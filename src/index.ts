import { getSandbox, proxyToSandbox } from "@cloudflare/sandbox";
import { customAlphabet } from "nanoid";

export { Sandbox } from "./sandbox";
export { SessionTracker } from "./session-tracker";

const generateId = customAlphabet("abcdefghijklmnopqrstuvwxyz0123456789", 8);
const SESSION_ID_RE = /^[a-z0-9]{8}$/;

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

function withCors(response: Response): Response {
  const patched = new Response(response.body, response);
  for (const [key, value] of Object.entries(CORS_HEADERS)) {
    patched.headers.set(key, value);
  }
  return patched;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    const proxyResponse = await proxyToSandbox(
      request,
      env as unknown as Parameters<typeof proxyToSandbox>[1],
    );
    if (proxyResponse) {
      if (request.headers.get("Upgrade") === "websocket") {
        return proxyResponse;
      }
      const response = new Response(proxyResponse.body, proxyResponse);
      response.headers.delete("X-Frame-Options");
      response.headers.delete("Content-Security-Policy");
      response.headers.set("Access-Control-Allow-Origin", "*");
      return response;
    }

    const url = new URL(request.url);

    if (
      url.pathname === "/ws/session" &&
      request.headers.get("Upgrade")?.toLowerCase() === "websocket"
    ) {
      return handleSessionWs(request, env, url);
    }

    if (url.pathname === "/status") {
      const tracker = env.SessionTracker.get(
        env.SessionTracker.idFromName("global"),
      );
      const active = await tracker.getActive();
      return withCors(
        new Response(JSON.stringify({ active }), {
          headers: {
            "Content-Type": "application/json",
            "Cache-Control": "max-age=1",
          },
        }),
      );
    }

    return withCors(new Response("Goose Pond Editor API"));
  },
};

async function handleSessionWs(
  request: Request,
  env: Env,
  url: URL,
): Promise<Response> {
  const tracker = env.SessionTracker.get(
    env.SessionTracker.idFromName("global"),
  );

  const existingSessionId = url.searchParams.get("session");

  if (existingSessionId && !SESSION_ID_RE.test(existingSessionId)) {
    const [client, server] = Object.values(new WebSocketPair());
    server.accept();
    server.send(
      JSON.stringify({ type: "error", message: "Invalid session ID format" }),
    );
    server.close(1008, "Invalid session ID");
    return new Response(null, { status: 101, webSocket: client });
  }

  const sessionId = existingSessionId || generateId();

  const lease = await tracker.acquire(sessionId);
  if (!lease) {
    // Browser WS API doesn't expose HTTP status codes on upgrade failure.
    const [client, server] = Object.values(new WebSocketPair());
    server.accept();
    const active = await tracker.getActive();
    server.send(JSON.stringify({ type: "full", active }));
    server.close(4429, "At capacity");
    return new Response(null, { status: 101, webSocket: client });
  }

  try {
    const sandbox = getSandbox(env.Sandbox, sessionId, {
      keepAlive: true,
      sleepAfter: "20m",
    });

    const wsUrl = new URL(request.url);
    wsUrl.searchParams.set("sessionId", sessionId);
    wsUrl.searchParams.set("leaseId", lease.leaseId);
    wsUrl.searchParams.set("hostname", request.headers.get("Host") ?? url.host);

    return await sandbox.fetch(new Request(wsUrl, request));
  } catch (err) {
    console.error("handleSessionWs error:", err);
    await tracker.release(sessionId);
    const [client, server] = Object.values(new WebSocketPair());
    server.accept();
    server.send(
      JSON.stringify({
        type: "error",
        message: `Failed to connect: ${err instanceof Error ? err.message : String(err)}`,
      }),
    );
    server.close(1011, "Internal error");
    return new Response(null, { status: 101, webSocket: client });
  }
}
