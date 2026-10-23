# comb

A local model router with replaceable connectors. Point any OpenAI client at it, and comb routes the request to a web session, a CLI, or an API, with native-looking tool calling on top of providers that only speak plain text.

```
client ──▶ comb (:3000/v1) ──▶ chain / model resolution
                                  │
                                  ├─ web2api connector  (gemini-web, qwen-web, deepseek-web, arena …)
                                  ├─ cli2api connector  (gemini CLI, claude CLI, codex, cursor …)
                                  └─ api2api connector  (key pools, OAuth accounts, any /v1)
```

## Quick start

```bash
npm install
npm run build
npm start            # http://127.0.0.1:3000
```

The first start creates `data/comb.db`, a bootstrap API key (`data/bootstrap-key.txt`), and the connector catalog. Open the dashboard, go to **Setup**, tick the connectors you want and let it clone, install, start, discover models, and calibrate tool calling.

The server binds to loopback by default. Set `HOST=0.0.0.0` to expose it, `PORT` to change the port, `COMB_DATA` to move the data directory.

## Why connectors

Every provider integration is a repo on this host, not code inside comb. That keeps the fragile part (reverse-engineered web endpoints, CLI session formats) replaceable: when a provider changes, you reinstall or edit one connector without touching the router.

The catalog ships with these (all third-party, all unofficial):

| connector | kind | repo | auth |
|---|---|---|---|
| Gemini Web | web2api | [Sophomoresty/gemini-web2api](https://github.com/Sophomoresty/gemini-web2api) | `__Secure-1PSID` cookie, or anonymous flash |
| Qwen Web | web2api | [smanx/qwen2api](https://github.com/smanx/qwen2api) | guest session or `access_token` |
| DeepSeek Web | web2api | [sums001/Deepseek-API](https://github.com/sums001/Deepseek-API) | browser login cached on disk |
| Arena.AI | web2api | [CloudWaddie/LMArenaBridge](https://github.com/CloudWaddie/LMArenaBridge) | arena session token |
| Grok Web | web2api | [anojndr/grok.com-to-openai](https://github.com/anojndr/grok.com-to-openai) | `sso` cookies |
| GLM Web (Z.ai) | web2api | [izaart95-jpg/GLM-Free-API](https://github.com/izaart95-jpg/GLM-Free-API) | `ZAI_TOKEN` |
| Copilot | web2api | [ericc-ch/copilot-api](https://github.com/ericc-ch/copilot-api) | device-code login |
| gpt4free | web2api | [xtekky/gpt4free](https://github.com/xtekky/gpt4free) | per-provider cookies or HAR |
| Perplexity Web | web2api | [henrique-coder/perplexity-webui-scraper](https://github.com/henrique-coder/perplexity-webui-scraper) | session cookie |
| CLIProxyAPI | cli2api | [router-for-me/CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) | provider OAuth |
| Gemini CLI Proxy | cli2api | [nettee/gemini-cli-proxy](https://github.com/nettee/gemini-cli-proxy) | `gemini` login |
| Claude Max Proxy | cli2api | [wende/claude-max-api-proxy](https://github.com/wende/claude-max-api-proxy) | `claude auth login` |
| Cursor Agent Proxy | cli2api | [anyrobert/cursor-api-proxy](https://github.com/anyrobert/cursor-api-proxy) | `agent login` |
| Codex Shim | cli2api | [hotchpotch/openai-api-server-via-codex](https://github.com/hotchpotch/openai-api-server-via-codex) | `~/.codex/auth.json` |
| Agent CLI → API | cli2api | [leeguooooo/agent-cli-to-api](https://github.com/leeguooooo/agent-cli-to-api) | wrapped CLI logins |
| Antigravity OAuth | api2api | [dvcrn/antigravity-oauth-proxy](https://github.com/dvcrn/antigravity-oauth-proxy) | Google OAuth |
| gpt-load | api2api | [tbphp/gpt-load](https://github.com/tbphp/gpt-load) | provider keys / OAuth pools |
| LLM API Key Proxy | api2api | [Mirrowel/LLM-API-Key-Proxy](https://github.com/Mirrowel/LLM-API-Key-Proxy) | numbered env keys |

Connectors ship a fixed model list and fall behind the provider. Add the newer ids yourself: the setup wizard takes extra ids per upstream, and each upstream has an **add model** field in the panel. comb routes an id the connector never advertised; if the provider rejects it, normal failover applies.

You are not limited to the catalog. **Connectors → add custom connector** (also reachable from Setup) takes either a git URL or an uploaded archive (`.zip`, `.tar.gz`, `.tgz`, `.tar`, `.rar`, `.7z`). comb stages it, extracts with zip-slip protection, unwraps a single top-level folder, then analyzes the tree: runtime and lockfile, install and start commands, listening port, kind, native vs emulated tools, and model ids found in the README and config. You review or edit every field before pressing install. Installing under an existing id replaces that connector's files and reinstalls it.

`.zip` and `.tar`/`.tar.gz` are parsed by comb itself. `.rar` and `.7z` need a host extractor (`unrar`, `unar`, `7z` or `bsdtar`); without one the API returns the exact list of binaries to install. Uploads are capped at 200 MB.

You can also skip connectors entirely and point an upstream at any OpenAI-compatible URL, or at a CLI on this host (`cli-spawn` adapter, `$COMB_PROMPT` / `$COMB_MODEL` in the command).

Install commands run as your user with git, npm, python and go available. Only install sources you trust.

## Tool emulation

Web sessions have no function calling. comb makes them behave as if they did.

1. The request's `tools` array becomes a protocol preamble: the JSON schemas plus rules for emitting a call.
2. The model answers in one of three shapes (`xml`, `fence`, `json`), depending on what it can follow.
3. comb parses the block, repairs the usual model JSON mistakes, validates names against the declared tools, and returns real `tool_calls` with stringified arguments and `finish_reason: "tool_calls"`.
4. On the next turn, `role: "tool"` messages are folded back into the transcript as `<tool_result>` blocks, so the model sees a coherent conversation.

`POST /api/models/:id/recalibrate` probes one model with a dummy tool in every shape (native plus each variant), keeps the first shape that produced a valid, schema-valid call, and stores it. Native is preferred when the connector really forwards `tools`. A text reply that merely contains a tool-shaped block does not count as native support.

Emulated models carry a calibration state separate from their variant. They start `uncalibrated` with the `default_tool_variant` from Settings as a fallback, become `calibrated` once a probe passes, and `failed` when every shape fails. Native and `off` models are never queued for emulation calibration. The Models page shows the state, has a bulk **calibrate uncalibrated** action, and lets you add ids the connector never listed.

Scope and limits:

- Every declared tool name is checked; unknown names are dropped and logged rather than forwarded.
- Arguments are coerced into a parsed object and re-serialized, so clients get valid JSON.
- Streaming for emulated providers is a buffered reply sliced into chunks, not token-by-token output. Native connectors stream for real.
- Emulation cannot give a text-only model the ability to see tool output it never received; it works because the client sends results back on the next turn, exactly like the OpenAI API.

**Refresh** on an upstream runs the same pipeline in one step: it asks the connector for its live model list, seeds the preset and connector ids when the connector is down or returns nothing, keeps every existing row and manual id, then calibrates only the emulated models that are uncalibrated or failed. Pass `force` to re-probe everything. Nothing is deleted.

The **background scheduler** runs that refresh for every active upstream on an interval (default 60 minutes, off until enabled in Settings). It re-discovers models, checks health, and calibrates only emulated models that are still uncalibrated; failures are retried after a six-hour backoff, and calibrated models are never re-probed. Passes are serial: a second pass, or a manual refresh already in flight, is skipped rather than stacked. Settings shows the last run summary, last and next run times, and a **run now** button. `GET/PATCH /api/scheduler` and `POST /api/scheduler/run` back it.

## Routing

- **Model ids** are canonical: `gemini-web/gemini-2.5-pro`, `openai-compatible/gpt-4.1`.
- **Chains** are named lists with a strategy and are callable as a model. `priority`, `weighted`, `round_robin`, `least_used`, `fastest`, `cheapest`, `quota_headroom`.
- **`auto`** ranks every enabled model by success rate, latency, cost and rate-limit headroom.
- **Failover** tries up to `max_attempts` members on transport errors, 429, 5xx and timeouts.
- **Cooldowns** double per consecutive failure (`cooldown_base_ms`, capped at 15 minutes) and honor `Retry-After`. Successful calls clear them.
- **Rate limits** are enforced per upstream (`max_rpm`, `max_rpd`) and per client key (`rpm`, `rpd`).

## API

```
POST /v1/chat/completions   OpenAI-compatible, streaming and tools
GET  /v1/models             chains, models and auto
GET  /v1/health             cooldown snapshot
POST /v1/embeddings         returns 501 (not routed yet)
```

Auth is `Authorization: Bearer <comb key>`. Every response includes a `comb` block with the routed model, upstream, attempt count, latency and whether tools were emulated.

```bash
curl http://127.0.0.1:3000/v1/chat/completions \
  -H "authorization: Bearer $(cat data/bootstrap-key.txt)" \
  -H "content-type: application/json" \
  -d '{"model":"auto","messages":[{"role":"user","content":"hello"}]}'
```

The `/api/*` routes back the dashboard. They are unauthenticated by design for a single-user local tool; the server binds to loopback unless you set `HOST`, so put your own proxy in front if you expose it.

## Free web tiers and session reset

Some web providers hand a **guest** session its own quota. Qwen chat is the common example: a browser session that has not logged in gets a slice of free access, and a fresh cookie jar looks like a new guest. comb's `cookie_reset` upstream mode drops the stored cookie and clears cooldowns for that upstream's models, so the connector mints a new guest session on the next request.

What this is not: a way to remove real account limits. Logged-in accounts, per-IP fair use and provider-side device fingerprinting all survive a cookie wipe, and providers change or ban this kind of use whenever they want. Treat it as session recovery, keep your own requests modest, and expect the connector to break when the provider ships a change.

Terms risk also applies to Antigravity OAuth and other subscription-backed connectors; Google's Antigravity terms prohibit third-party clients explicitly. comb will route it if you configure it, and the account is your responsibility.

## Dashboard

`/` serves the built UI: overview with health and traffic, setup wizard, connector manager with logs, upstream editor and discovery, per-model tool mode and calibration, chain editor, client keys, request log, and a playground that shows how a request was routed and whether tools were emulated.

## Development

```bash
npm run dev        # API + built dashboard on :3000 (rebuild the UI with npm run build)
npm run typecheck
npm test           # parser, router, failover, refresh, scheduler, archive, analyzer and dashboard tests
node scripts/fake-connector.mjs   # fake web2api on :8811 for manual testing
```

Layout: `src/server` (Express, SQLite via `node:sqlite`, router, adapters, plugin supervisor, tool emulation), `src/dashboard` (React), `src/shared` (types).

## Not built yet

Embeddings and the Responses API, multi-user auth, per-model token accounting from real usage data (connectors often omit it, so comb estimates), and proper token-by-token streaming for emulated tool providers.

Connector commands use Bash. On Linux/macOS, comb uses `/bin/bash`. On Windows, install Git for Windows; comb finds its Bash automatically, including installations on PATH. Set `COMB_SHELL` to the full Bash executable path for a nonstandard installation. Windows commands use `python` and `.venv/Scripts/` for the catalog's Python environments; install Python on PATH. Node/npm and Go are needed by their respective connectors. Third-party repos may have additional platform requirements. Install and start failures appear in Connectors with their process output, and a failed connector does not stop the API or the rest of the setup queue.
