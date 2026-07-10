# JARVIS Bridge

Local Node service that gives the in-page **JARVIS watcher** (in the
`factnest365-ops/jarvis` Chrome extension) deep, internet-aware context.

It combines two tools on your machine:

- **Obscura** (`/Users/bhavy/obscura`) — Rust headless browser. Deep-fetches
  the current page as markdown AND scrapes platform search pages
  (Reddit / GitHub / YouTube) with anti-bot stealth.
- **Agent-Reach** (`~/.agent-reach-venv/bin/agent-reach`) — best-effort
  Whisper transcript of YouTube videos.

## Run

```bash
cd jarvis-bridge
JARVIS_BRIDGE_PORT=8787 node index.js
# or: npm start
```

Then point the extension at it: open the JARVIS Settings panel in the
extension and set **Bridge URL** to `http://localhost:8787`.

## Protocol

`POST /context`  body: `{ "url": "...", "title": "..." }`
→ `{ "url", "title", "pageContent", "transcript", "webSignal" }`

`POST /act`  body: `{ "action": "download", "url": "<file>", "name": "<opt>" }`
or `{ "action": "opencli", "args": ["browser","click", ...] }`
→ `{ "ok": true, "path": "<local file>" }` (download) or OpenCLI stdout

`GET /health` → `ok`

JARVIS *proposes* actions (download / draft / opencli); the user approves in the
bubble before anything runs. `draft` is generated client-side by the LLM.

## Action safety
- `download` and `opencli` run only after you tap the button in the JARVIS bubble.
- `opencli` acts on your *logged-in* browser — use with care.
- `draft` never posts; it only generates text you can copy/review.

## Env

| Var | Default | Notes |
|-----|---------|-------|
| `JARVIS_BRIDGE_PORT` | `8787` | listen port |
| `OBSCURA_BIN` | `/Users/bhavy/obscura` | path to Obscura binary |
| `AGENT_REACH_BIN` | `~/.agent-reach-venv/bin/agent-reach` | path to Agent-Reach |
| `OBSCURA_STEALTH` | `1` | set `0` to disable stealth |
