# 🪿 Goose Pond Editor

Give an AI agent a prompt, and watch it modify a live pixel art goose app — right in your browser.

The base app is [goose-pond](https://github.com/ghostwriternr/goose-pond) — a pixel art goose, chilling on a pond. The agent reads the code, thinks about your request, writes the changes, and Vite hot-reloads the result. All streamed to you as it happens.

## Try it

```bash
npm install
cp .dev.vars.example .dev.vars  # add your AI Gateway token
npm run dev
```

```bash
curl -N -X POST http://localhost:8787/demo \
  -H 'Content-Type: application/json' \
  -d '{"prompt": "make the goose follow my cursor"}'
```
