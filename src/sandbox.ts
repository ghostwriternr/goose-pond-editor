import { Sandbox as BaseSandbox } from "@cloudflare/sandbox";
import { generateText } from "ai";
import { createAiGateway } from "ai-gateway-provider";
import { createUnified } from "ai-gateway-provider/providers/unified";
import { customAlphabet } from "nanoid";

const PROJECT_DIR = "/home/user/goose-pond";
const VITE_PORT = 5173;
const HEARTBEAT_INTERVAL_MS = 30_000;
const SESSION_STATE_KEY = "sessionState";

const generateSocketId = customAlphabet(
  "abcdefghijklmnopqrstuvwxyz0123456789",
  12,
);

type SocketRole = "driver" | "viewer";

interface WsAttachment {
  socketId: string;
  role: SocketRole;
  state: "connected" | "ready";
  connectedAt: number;
}

type SessionStage = "idle" | "restoring" | "running" | "done";

interface SessionState {
  sessionId: string;
  leaseId: string;
  hostname: string;
  stage: SessionStage;
  driverSocketId?: string;
  previewUrl?: string;
  modifiedFiles: string[];
}

export class Sandbox extends BaseSandbox<Env> {
  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (
      url.pathname === "/ws/session" &&
      request.headers.get("Upgrade")?.toLowerCase() === "websocket"
    ) {
      const [client, server] = Object.values(new WebSocketPair());

      const socketId = generateSocketId();
      const sessionId = url.searchParams.get("sessionId")!;
      const leaseId = url.searchParams.get("leaseId")!;
      const hostname = url.searchParams.get("hostname")!;

      let state = await this.ctx.storage.get<SessionState>(SESSION_STATE_KEY);

      if (!state) {
        state = {
          sessionId,
          leaseId,
          hostname,
          stage: "idle",
          driverSocketId: socketId,
          modifiedFiles: [],
        };
      } else if (
        !state.driverSocketId ||
        !this.#hasSocket(state.driverSocketId)
      ) {
        state.driverSocketId = socketId;
      }

      const role: SocketRole =
        state.driverSocketId === socketId ? "driver" : "viewer";

      const attachment: WsAttachment = {
        socketId,
        role,
        state: "connected",
        connectedAt: Date.now(),
      };

      this.ctx.acceptWebSocket(server);
      server.serializeAttachment(attachment);

      await this.ctx.storage.put(SESSION_STATE_KEY, state);
      await this.ctx.storage.setAlarm(Date.now() + HEARTBEAT_INTERVAL_MS);

      return new Response(null, { status: 101, webSocket: client });
    }

    return super.fetch(request);
  }

  async webSocketMessage(
    ws: WebSocket,
    message: string | ArrayBuffer,
  ): Promise<void> {
    if (typeof message !== "string") return;

    let data: { type: string; prompt?: string };
    try {
      data = JSON.parse(message);
    } catch {
      this.#send(ws, "error", { message: "Invalid JSON" });
      return;
    }

    const att = ws.deserializeAttachment() as WsAttachment;

    switch (data.type) {
      case "hello":
        await this.#handleHello(ws, att);
        break;

      case "start":
        await this.#handleStart(ws, att, data.prompt);
        break;

      default:
        this.#send(ws, "error", {
          message: `Unknown message type: ${data.type}`,
        });
    }
  }

  async webSocketClose(
    ws: WebSocket,
    _code: number,
    _reason: string,
    _wasClean: boolean,
  ): Promise<void> {
    const att = ws.deserializeAttachment() as WsAttachment | null;
    if (!att) return;

    const state = await this.#loadState();
    if (!state) return;

    if (att.socketId === state.driverSocketId) {
      this.#electNewDriver(state, att.socketId);
      await this.#saveState(state);

      if (state.driverSocketId) {
        this.#broadcast("role", { driverSocketId: state.driverSocketId });

        if (state.stage === "idle") {
          const newDriverWs = this.#findSocket(state.driverSocketId);
          const newDriverAtt = newDriverWs?.deserializeAttachment() as
            | WsAttachment
            | undefined;
          if (newDriverWs && newDriverAtt?.state === "ready") {
            this.#send(newDriverWs, "prompt");
          }
        }
      }
    }

    const remaining = this.ctx.getWebSockets().filter((s) => s !== ws);
    if (remaining.length === 0) {
      await this.#finalizeAndDestroy(state);
    }
  }

  async webSocketError(ws: WebSocket, error: unknown): Promise<void> {
    console.error("WebSocket error:", error);
    try {
      ws.close(1011, "WebSocket error");
    } catch {}
  }

  async alarm(): Promise<void> {
    const state = await this.#loadState();
    if (!state) return;

    const sockets = this.ctx.getWebSockets();

    if (sockets.length === 0) {
      await this.#finalizeAndDestroy(state);
      return;
    }

    try {
      const tracker = this.env.SessionTracker.get(
        this.env.SessionTracker.idFromName("global"),
      );
      await tracker.renew(state.leaseId);
    } catch (err) {
      console.error("Lease renewal failed:", err);
    }

    await this.ctx.storage.setAlarm(Date.now() + HEARTBEAT_INTERVAL_MS);
  }

  override async onStop() {
    this.#broadcast("expired");
    await super.onStop();
  }

  // ── Message handlers ──────────────────────────────────────────────

  async #handleHello(ws: WebSocket, att: WsAttachment): Promise<void> {
    if (att.state !== "connected") {
      this.#send(ws, "error", { message: "Already sent hello" });
      return;
    }

    att.state = "ready";
    ws.serializeAttachment(att);

    const state = await this.#loadState();
    if (!state) return;

    this.#send(ws, "welcome", {
      socketId: att.socketId,
      role: att.role,
      session: {
        sessionId: state.sessionId,
        stage: state.stage,
        previewUrl: state.previewUrl,
      },
    });

    if (att.role === "driver" && state.stage === "idle") {
      const manifest = await this.env.DIFFS.get(
        `sessions/${state.sessionId}/manifest.json`,
      );
      if (manifest) {
        await this.#restoreSession(manifest);
      } else {
        this.#broadcast("prompt");
      }
    }
  }

  async #handleStart(
    ws: WebSocket,
    att: WsAttachment,
    prompt?: string,
  ): Promise<void> {
    if (att.role !== "driver") {
      this.#send(ws, "error", {
        message: "Only the driver can start a generation",
      });
      return;
    }

    if (!prompt) {
      this.#send(ws, "error", { message: "prompt is required" });
      return;
    }

    const state = await this.#loadState();
    if (!state) return;

    if (state.stage !== "idle" && state.stage !== "done") {
      this.#send(ws, "error", {
        message: "A generation is already in progress",
      });
      return;
    }

    await this.#runGeneration(prompt);
  }

  // ── Core operations ───────────────────────────────────────────────

  async #runGeneration(prompt: string): Promise<void> {
    let state = await this.#loadState();
    if (!state) return;

    try {
      state.stage = "running";
      await this.#saveState(state);

      if (!state.previewUrl) {
        this.#broadcast("status", {
          step: "server",
          message: "Starting dev server…",
        });
        const server = await this.startProcess("npx vite --host", {
          cwd: PROJECT_DIR,
        });
        await server.waitForPort(VITE_PORT, { mode: "tcp" });

        const exposed = await this.exposePort(VITE_PORT, {
          hostname: state.hostname,
          token: state.sessionId,
        });

        state = (await this.#loadState())!;
        state.previewUrl = exposed.url;
        await this.#saveState(state);
        this.#broadcast("preview", { url: exposed.url });
      }

      await this.#renewLease(state.leaseId);

      this.#broadcast("status", {
        step: "agent",
        message: "Agent is reading code…",
      });

      const [appFile, gooseFile, cssFile] = await Promise.all([
        this.readFile(`${PROJECT_DIR}/src/App.tsx`),
        this.readFile(`${PROJECT_DIR}/src/PixelGoose.tsx`),
        this.readFile(`${PROJECT_DIR}/src/index.css`),
      ]);

      this.#broadcast("status", {
        step: "agent",
        message: "Agent is thinking…",
      });

      const aigateway = createAiGateway({
        accountId: "8acffcc765d5baa91c873d1459ba1a19",
        gateway: "dev-envs-for-agents",
        apiKey: this.env.CF_AIG_TOKEN,
      });
      const unified = createUnified();

      const { text: modifiedCode } = await generateText({
        model: aigateway(unified("google-ai-studio/gemini-2.5-flash")),
        prompt: buildLLMPrompt(
          prompt,
          appFile.content,
          gooseFile.content,
          cssFile.content,
        ),
      });

      this.#broadcast("status", {
        step: "modify",
        message: "Applying changes…",
      });
      const code = extractCode(modifiedCode);
      await this.writeFile(`${PROJECT_DIR}/src/App.tsx`, code);

      state = (await this.#loadState())!;
      state.modifiedFiles = [`${PROJECT_DIR}/src/App.tsx`];
      state.stage = "done";
      await this.#saveState(state);

      await this.#persistToR2(state);
      await this.#renewLease(state.leaseId);

      this.#broadcast("done", {
        sessionId: state.sessionId,
        url: state.previewUrl,
      });
    } catch (err) {
      state = (await this.#loadState())!;
      state.stage = "done";
      await this.#saveState(state);
      this.#broadcast("error", { message: String(err) });
    }
  }

  async #restoreSession(manifestObj: R2ObjectBody): Promise<void> {
    let state = await this.#loadState();
    if (!state) return;

    try {
      state.stage = "restoring";
      await this.#saveState(state);

      this.#broadcast("status", {
        step: "restoring",
        message: "Restoring previous session…",
      });

      const manifest = (await manifestObj.json()) as { files: string[] };

      for (const filePath of manifest.files) {
        const fileName = filePath.split("/").pop()!;
        const fileObj = await this.env.DIFFS.get(
          `sessions/${state.sessionId}/${fileName}`,
        );
        if (fileObj) {
          await this.writeFile(filePath, await fileObj.text());
        }
      }

      this.#broadcast("status", {
        step: "server",
        message: "Starting dev server…",
      });
      const server = await this.startProcess("npx vite --host", {
        cwd: PROJECT_DIR,
      });
      await server.waitForPort(VITE_PORT, { mode: "tcp" });

      const exposed = await this.exposePort(VITE_PORT, {
        hostname: state.hostname,
        token: state.sessionId,
      });

      state = (await this.#loadState())!;
      state.previewUrl = exposed.url;
      state.modifiedFiles = manifest.files;
      state.stage = "done";
      await this.#saveState(state);

      this.#broadcast("preview", { url: exposed.url });
      await this.#renewLease(state.leaseId);

      this.#broadcast("restored", {
        sessionId: state.sessionId,
        url: exposed.url,
      });
    } catch (err) {
      state = (await this.#loadState())!;
      state.stage = "idle";
      await this.#saveState(state);
      this.#broadcast("error", {
        message: `Restore failed: ${String(err)}`,
      });
      this.#broadcast("prompt");
    }
  }

  // ── State management ──────────────────────────────────────────────

  async #loadState(): Promise<SessionState | undefined> {
    return this.ctx.storage.get<SessionState>(SESSION_STATE_KEY);
  }

  async #saveState(state: SessionState): Promise<void> {
    await this.ctx.storage.put(SESSION_STATE_KEY, state);
  }

  // ── Multi-tab ─────────────────────────────────────────────────────

  #hasSocket(socketId: string): boolean {
    for (const ws of this.ctx.getWebSockets()) {
      const att = ws.deserializeAttachment() as WsAttachment | null;
      if (att?.socketId === socketId) return true;
    }
    return false;
  }

  #findSocket(socketId: string): WebSocket | undefined {
    for (const ws of this.ctx.getWebSockets()) {
      const att = ws.deserializeAttachment() as WsAttachment | null;
      if (att?.socketId === socketId) return ws;
    }
    return undefined;
  }

  #electNewDriver(state: SessionState, excludeSocketId: string): void {
    let oldestAtt: WsAttachment | null = null;

    for (const ws of this.ctx.getWebSockets()) {
      const att = ws.deserializeAttachment() as WsAttachment | null;
      if (!att || att.socketId === excludeSocketId) continue;
      if (!oldestAtt || att.connectedAt < oldestAtt.connectedAt) {
        oldestAtt = att;
      }
    }

    if (oldestAtt) {
      state.driverSocketId = oldestAtt.socketId;

      for (const ws of this.ctx.getWebSockets()) {
        const att = ws.deserializeAttachment() as WsAttachment | null;
        if (!att || att.socketId === excludeSocketId) continue;
        att.role = att.socketId === oldestAtt.socketId ? "driver" : "viewer";
        ws.serializeAttachment(att);
      }
    } else {
      state.driverSocketId = undefined;
    }
  }

  // ── Broadcast / Send ──────────────────────────────────────────────

  #broadcast(type: string, data: Record<string, unknown> = {}): void {
    const msg = JSON.stringify({ type, ...data });
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(msg);
      } catch {}
    }
  }

  #send(ws: WebSocket, type: string, data: Record<string, unknown> = {}): void {
    try {
      ws.send(JSON.stringify({ type, ...data }));
    } catch {}
  }

  // ── R2 persistence ────────────────────────────────────────────────

  async #persistToR2(state: SessionState): Promise<void> {
    if (state.modifiedFiles.length === 0) return;

    try {
      await this.env.DIFFS.put(
        `sessions/${state.sessionId}/manifest.json`,
        JSON.stringify({ files: state.modifiedFiles }),
      );

      for (const filePath of state.modifiedFiles) {
        const file = await this.readFile(filePath);
        const fileName = filePath.split("/").pop()!;
        await this.env.DIFFS.put(
          `sessions/${state.sessionId}/${fileName}`,
          file.content,
        );
      }
    } catch (err) {
      console.error("Failed to persist to R2:", err);
    }
  }

  // ── Lease management ──────────────────────────────────────────────

  async #renewLease(leaseId: string): Promise<void> {
    try {
      const tracker = this.env.SessionTracker.get(
        this.env.SessionTracker.idFromName("global"),
      );
      await tracker.renew(leaseId);
    } catch (err) {
      console.error("Lease renewal failed:", err);
    }
  }

  // ── Cleanup ───────────────────────────────────────────────────────

  async #finalizeAndDestroy(state: SessionState): Promise<void> {
    try {
      await this.#persistToR2(state);
    } catch {}

    try {
      const tracker = this.env.SessionTracker.get(
        this.env.SessionTracker.idFromName("global"),
      );
      await tracker.release(state.leaseId);
    } catch {}

    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.delete(SESSION_STATE_KEY);

    try {
      await this.destroy();
    } catch {}
  }
}

function buildLLMPrompt(
  userPrompt: string,
  appCode: string,
  gooseCode: string,
  cssCode: string,
): string {
  return `You are modifying a React app. The app renders a pixel art goose on a pond background.

Here are the current source files:

=== src/App.tsx ===
${appCode}

=== src/PixelGoose.tsx (DO NOT MODIFY — read-only reference) ===
${gooseCode}

=== src/index.css (DO NOT MODIFY — read-only reference) ===
${cssCode}

The user wants you to: ${userPrompt}

RULES:
- ONLY modify App.tsx. Do NOT modify PixelGoose.tsx or index.css.
- The PixelGoose component accepts these props: size, direction ("left" | "right"), className, style.
- Return ONLY the complete modified App.tsx file contents.
- Do NOT include markdown fences, explanations, or anything other than the raw TypeScript/JSX code.
- The code must be valid TypeScript JSX that compiles without errors.
- Import React hooks if you use them.`;
}

function extractCode(response: string): string {
  const fenceMatch = response.match(/```(?:tsx?|jsx?)?\s*\n([\s\S]*?)```/);
  if (fenceMatch) {
    return fenceMatch[1].trim();
  }
  return response.trim();
}
