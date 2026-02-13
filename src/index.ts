import { getSandbox, proxyToSandbox, type Sandbox } from '@cloudflare/sandbox';
import { generateText } from 'ai';
import { createAiGateway } from 'ai-gateway-provider';
import { createUnified } from 'ai-gateway-provider/providers/unified';

export { Sandbox } from '@cloudflare/sandbox';

const REPO_URL = 'https://github.com/ghostwriternr/goose-pond';
const PROJECT_DIR = '/workspace/goose-pond';
const VITE_PORT = 5173;

const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type'
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
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    // Proxy requests to exposed sandbox ports
    const proxyResponse = await proxyToSandbox(request, env);
    if (proxyResponse) {
      if (request.headers.get('Upgrade') === 'websocket') {
        return proxyResponse;
      }
      const response = new Response(proxyResponse.body, proxyResponse);
      response.headers.delete('X-Frame-Options');
      response.headers.delete('Content-Security-Policy');
      response.headers.set('Access-Control-Allow-Origin', '*');
      return response;
    }

    const url = new URL(request.url);

    if (url.pathname === '/demo') {
      return handleDemo(request, env);
    }

    // Existing endpoints
    const sandbox = getSandbox(env.Sandbox, 'my-sandbox');

    if (url.pathname === '/run') {
      const result = await sandbox.exec('echo "2 + 2 = $((2 + 2))"');
      return withCors(
        Response.json({
          output: result.stdout,
          error: result.stderr,
          exitCode: result.exitCode,
          success: result.success
        })
      );
    }

    if (url.pathname === '/file') {
      await sandbox.writeFile('/workspace/hello.txt', 'Hello, Sandbox!');
      const file = await sandbox.readFile('/workspace/hello.txt');
      return withCors(Response.json({ content: file.content }));
    }

    return withCors(new Response('Try /run, /file, or POST /demo'));
  }
};

function sseEvent(event: string, data: Record<string, unknown>): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

async function handleDemo(request: Request, env: Env): Promise<Response> {
  if (request.method !== 'POST') {
    return withCors(
      new Response('POST { "prompt": "make the goose follow my cursor" }', {
        status: 405
      })
    );
  }

  const { prompt } = (await request.json()) as { prompt: string };
  if (!prompt) {
    return withCors(
      Response.json({ error: 'prompt is required' }, { status: 400 })
    );
  }

  const { host } = new URL(request.url);
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: string, data: Record<string, unknown>) => {
        controller.enqueue(encoder.encode(sseEvent(event, data)));
      };

      try {
        // 1. Provision sandbox
        send('status', { step: 'sandbox', message: 'Provisioning sandbox…' });
        const sandboxId = `demo-${Date.now()}`;
        const sandbox = getSandbox(env.Sandbox, sandboxId);

        // 2. Clone repo
        send('status', { step: 'clone', message: 'Cloning goose-pond…' });
        await sandbox.gitCheckout(REPO_URL, { depth: 1 });

        // 3. Install dependencies
        send('status', {
          step: 'install',
          message: 'Installing dependencies…'
        });
        const install = await sandbox.exec('npm install', { cwd: PROJECT_DIR });
        if (!install.success) {
          send('error', { message: `npm install failed: ${install.stderr}` });
          controller.close();
          return;
        }

        // 4. Start dev server
        send('status', { step: 'server', message: 'Starting dev server…' });
        const server = await sandbox.startProcess('npx vite --host', {
          cwd: PROJECT_DIR
        });

        // 5. Wait for Vite to be ready
        await server.waitForPort(VITE_PORT, { mode: 'tcp' });

        // 6. Expose port and emit preview URL
        const exposed = await sandbox.exposePort(VITE_PORT, { hostname: host });
        send('status', {
          step: 'preview',
          message: 'Preview ready',
          url: exposed.url
        });

        // 7. Read source files for LLM context
        send('status', { step: 'agent', message: 'Agent is reading code…' });
        const [appFile, gooseFile, cssFile] = await Promise.all([
          sandbox.readFile(`${PROJECT_DIR}/src/App.tsx`),
          sandbox.readFile(`${PROJECT_DIR}/src/PixelGoose.tsx`),
          sandbox.readFile(`${PROJECT_DIR}/src/index.css`)
        ]);

        // 8. Call LLM to generate modification
        send('status', { step: 'agent', message: 'Agent is thinking…' });

        const aigateway = createAiGateway({
          accountId: '8acffcc765d5baa91c873d1459ba1a19',
          gateway: 'dev-envs-for-agents',
          apiKey: env.CF_AIG_TOKEN
        });
        const unified = createUnified();

        const { text: modifiedCode } = await generateText({
          model: aigateway(unified('google-ai-studio/gemini-2.5-flash')),
          prompt: buildLLMPrompt(
            prompt,
            appFile.content,
            gooseFile.content,
            cssFile.content
          )
        });

        // 9. Extract code from LLM response and write it
        send('status', { step: 'modify', message: 'Applying changes…' });
        const code = extractCode(modifiedCode);
        await sandbox.writeFile(`${PROJECT_DIR}/src/App.tsx`, code);

        // 10. Done — Vite HMR picks up the change
        send('done', { url: exposed.url, message: 'Done!' });
      } catch (err) {
        send('error', { message: String(err) });
      } finally {
        controller.close();
      }
    }
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      ...CORS_HEADERS
    }
  });
}

function buildLLMPrompt(
  userPrompt: string,
  appCode: string,
  gooseCode: string,
  cssCode: string
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
  // Strip markdown code fences if the model includes them despite instructions
  const fenceMatch = response.match(/```(?:tsx?|jsx?)?\s*\n([\s\S]*?)```/);
  if (fenceMatch) {
    return fenceMatch[1].trim();
  }
  return response.trim();
}
