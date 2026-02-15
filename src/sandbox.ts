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

interface WsAttachment {
  socketId: string;
  state: "connected" | "ready";
  replaced?: boolean;
}

type SessionStage = "idle" | "restoring" | "running" | "done";

interface SessionState {
  sessionId: string;
  leaseId: string;
  hostname: string;
  stage: SessionStage;
  epoch: number;
  previewUrl?: string;
  modifiedFiles: string[];
}

export class Sandbox extends BaseSandbox<Env> {
  #stopping = false;

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
          epoch: 0,
          modifiedFiles: [],
        };
      }

      // Accept new socket FIRST
      this.ctx.acceptWebSocket(server);

      const attachment: WsAttachment = {
        socketId,
        state: "connected",
      };
      server.serializeAttachment(attachment);

      await this.ctx.storage.put(SESSION_STATE_KEY, state);
      await this.ctx.storage.setAlarm(Date.now() + HEARTBEAT_INTERVAL_MS);

      // THEN close old sockets — mark each as replaced before closing
      for (const existing of this.ctx.getWebSockets()) {
        if (existing === server) continue;
        try {
          const existingAtt =
            existing.deserializeAttachment() as WsAttachment | null;
          if (existingAtt) {
            existingAtt.replaced = true;
            existing.serializeAttachment(existingAtt);
          }
          existing.close(1000, "Replaced by new connection");
        } catch {}
      }

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

  async webSocketClose(ws: WebSocket): Promise<void> {
    if (this.#stopping) return;

    const att = ws.deserializeAttachment() as WsAttachment | null;
    if (att?.replaced) return;

    const remaining = this.ctx.getWebSockets().filter((s) => s !== ws);
    if (remaining.length === 0) {
      const state = await this.#loadState();
      if (state) {
        await this.#finalizeAndDestroy(state);
      }
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
    this.#stopping = true;
    this.#broadcast("expired");

    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.close(1000, "Container stopped");
      } catch {}
    }

    const state = await this.#loadState();
    if (state) {
      await this.ctx.storage.deleteAlarm();
      await this.ctx.storage.delete(SESSION_STATE_KEY);

      try {
        const tracker = this.env.SessionTracker.get(
          this.env.SessionTracker.idFromName("global"),
        );
        await tracker.release(state.leaseId);
      } catch {}
    }

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

    let state = await this.#loadState();
    if (!state) return;

    switch (state.stage) {
      case "idle": {
        const manifest = await this.env.DIFFS.get(
          `sessions/${state.sessionId}/manifest.json`,
        );
        // Re-check state after R2 await (non-storage I/O allows interleaving)
        state = await this.#loadState();
        if (!state) return;

        if (state.stage !== "idle") {
          this.#send(ws, "welcome", {
            sessionId: state.sessionId,
            stage: state.stage,
            previewUrl: state.previewUrl,
            epoch: state.epoch,
          });
          break;
        }

        if (manifest) {
          const sessionId = state.sessionId;
          state.stage = "restoring";
          state.epoch += 1;
          await this.#saveState(state);
          this.#send(ws, "welcome", {
            sessionId: state.sessionId,
            stage: "restoring",
            epoch: state.epoch,
          });
          await this.#restoreSession(manifest, state.epoch, sessionId);
        } else {
          this.#send(ws, "welcome", {
            sessionId: state.sessionId,
            stage: "idle",
            epoch: state.epoch,
          });
          this.#send(ws, "ready");
        }
        break;
      }

      case "done":
        this.#send(ws, "welcome", {
          sessionId: state.sessionId,
          stage: "done",
          previewUrl: state.previewUrl,
          epoch: state.epoch,
        });
        this.#send(ws, "ready");
        break;

      case "restoring":
      case "running":
        this.#send(ws, "welcome", {
          sessionId: state.sessionId,
          stage: state.stage,
          previewUrl: state.previewUrl,
          epoch: state.epoch,
        });
        break;
    }
  }

  async #handleStart(
    ws: WebSocket,
    _att: WsAttachment,
    prompt?: string,
  ): Promise<void> {
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

    state.stage = "running";
    state.epoch += 1;
    await this.#saveState(state);
    const epoch = state.epoch;

    try {
      if (!state.previewUrl) {
        this.#broadcast("status", {
          step: "server",
          message: "Starting dev server…",
          epoch,
        });
        const server = await this.#withContainerRetry(
          () => this.startProcess("npx vite --host", { cwd: PROJECT_DIR }),
          epoch,
        );
        await server.waitForPort(VITE_PORT, { mode: "tcp" });

        const exposed = await this.#ensurePortExposed(
          VITE_PORT,
          state.hostname,
          state.sessionId,
        );

        state = await this.#loadState();
        if (!state) return;
        state.previewUrl = exposed.url;
        await this.#saveState(state);
        this.#broadcast("preview", { url: exposed.url, epoch });
      }

      await this.#renewLease(state.leaseId);

      this.#broadcast("status", {
        step: "agent",
        message: "Agent is reading code…",
        epoch,
      });

      const [appFile, gooseFile, cssFile] = await this.#withContainerRetry(
        () =>
          Promise.all([
            this.readFile(`${PROJECT_DIR}/src/App.tsx`),
            this.readFile(`${PROJECT_DIR}/src/PixelGoose.tsx`),
            this.readFile(`${PROJECT_DIR}/src/index.css`),
          ]),
        epoch,
      );

      this.#broadcast("status", {
        step: "agent",
        message: "Agent is thinking…",
        epoch,
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
        epoch,
      });
      const code = extractCode(modifiedCode);
      await this.writeFile(`${PROJECT_DIR}/src/App.tsx`, code);

      state = await this.#loadState();
      if (!state) return;
      state.modifiedFiles = [`${PROJECT_DIR}/src/App.tsx`];
      state.stage = "done";
      await this.#saveState(state);

      await this.#persistToR2(state);
      await this.#renewLease(state.leaseId);

      this.#broadcast("done", {
        sessionId: state.sessionId,
        url: state.previewUrl,
        epoch,
      });
    } catch (err) {
      state = await this.#loadState();
      if (!state) return;
      state.stage = "idle";
      await this.#saveState(state);
      this.#broadcast("error", { message: String(err), epoch });
      this.#broadcast("ready");
    }
  }

  async #restoreSession(
    manifestObj: R2ObjectBody,
    epoch: number,
    sessionId: string,
  ): Promise<void> {
    try {
      this.#broadcast("status", {
        step: "restoring",
        message: "Restoring previous session…",
        epoch,
      });

      const manifest = (await manifestObj.json()) as { files: string[] };

      for (const filePath of manifest.files) {
        const fileName = filePath.split("/").pop()!;
        const fileObj = await this.env.DIFFS.get(
          `sessions/${sessionId}/${fileName}`,
        );
        if (!fileObj) {
          throw new Error(
            `Missing R2 object: sessions/${sessionId}/${fileName}`,
          );
        }
        const content = await fileObj.text();
        await this.#withContainerRetry(
          () => this.writeFile(filePath, content),
          epoch,
        );
      }

      this.#broadcast("status", {
        step: "server",
        message: "Starting dev server…",
        epoch,
      });
      const server = await this.#withContainerRetry(
        () => this.startProcess("npx vite --host", { cwd: PROJECT_DIR }),
        epoch,
      );
      await server.waitForPort(VITE_PORT, { mode: "tcp" });

      let state = await this.#loadState();
      if (!state) return;

      const exposed = await this.#ensurePortExposed(
        VITE_PORT,
        state.hostname,
        state.sessionId,
      );

      state = await this.#loadState();
      if (!state) return;
      state.previewUrl = exposed.url;
      state.modifiedFiles = manifest.files;
      state.stage = "done";
      await this.#saveState(state);

      this.#broadcast("preview", { url: exposed.url, epoch });
      await this.#renewLease(state.leaseId);

      this.#broadcast("restored", {
        sessionId: state.sessionId,
        url: exposed.url,
        epoch,
      });
      this.#broadcast("ready");
    } catch (err) {
      const state = await this.#loadState();
      if (!state) return;
      state.stage = "idle";
      await this.#saveState(state);
      this.#broadcast("error", {
        message: `Restore failed: ${String(err)}`,
        epoch,
      });
      this.#broadcast("ready");
    }
  }

  // ── State management ──────────────────────────────────────────────

  async #loadState(): Promise<SessionState | undefined> {
    return this.ctx.storage.get<SessionState>(SESSION_STATE_KEY);
  }

  async #saveState(state: SessionState): Promise<void> {
    await this.ctx.storage.put(SESSION_STATE_KEY, state);
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

  // ── Container helpers ─────────────────────────────────────────────

  async #withContainerRetry<T>(
    fn: () => Promise<T>,
    epoch?: number,
    attempts = 5,
  ): Promise<T> {
    for (let i = 0; i < attempts; i++) {
      try {
        return await fn();
      } catch (err) {
        if (i === attempts - 1) throw err;
        this.#broadcast("status", {
          step: "server",
          message: `Waiting for container… (attempt ${i + 2})`,
          ...(epoch !== undefined && { epoch }),
        });
        await new Promise((r) => setTimeout(r, 3000 * 2 ** i));
      }
    }
    throw new Error("unreachable");
  }

  async #ensurePortExposed(
    port: number,
    hostname: string,
    token: string,
  ): Promise<{ url: string }> {
    try {
      return await this.exposePort(port, { hostname, token });
    } catch (err) {
      if (err instanceof Error && err.name === "PortAlreadyExposedError") {
        await this.unexposePort(port);
        return await this.exposePort(port, { hostname, token });
      }
      throw err;
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

  // ── Cleanup ──────────────────────────────────────────────────────��

  async #finalizeAndDestroy(state: SessionState): Promise<void> {
    await this.ctx.blockConcurrencyWhile(async () => {
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
    });
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
