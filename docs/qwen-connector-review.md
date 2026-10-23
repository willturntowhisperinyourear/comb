# Qwen connector live review

Tested on 2026-10-23 using a fresh clone and installation of `smanx/qwen2api` at `54f7993cbcb4a2dd5ae7210759fbe574a4c09f7a` on Windows with Node 25.9.0 and Git Bash.

| Check | Actual result |
| --- | --- |
| Git clone and npm installation | Passed |
| Connector process starts | Passed |
| `/v1/models` | HTTP 500, `Failed to fetch models` |
| Non-streaming `qwen3.7-plus` | HTTP 502, `FAIL_SYS_USER_VALIDATE` / `RGV587_ERROR` |
| Non-streaming connector default `qwen3.8-max` | Same provider-validation failure |
| Streaming `qwen3.7-plus` | HTTP 200 SSE containing a provider error, not model content |
| Normal and streaming `qwen-web/qwen3.8-max` through comb's authenticated API | Both failed; provider errors remain in the attempted-upstream details |
| Qwen's own guest web client, after the user completed age confirmation | Returned `QWEN_LIVE_OK.` from Qwen3.8-Max |

The live connector test exited 1 with zero passed checks and three failed checks. A model responding in the website does not establish that this connector works.

The reviewed connector reads its model list from `window.__prerendered_data` in the homepage HTML. A direct request instead received a JavaScript validation page without that data. For chat, the connector obtains guest validation tokens with Chromium, then sends requests using Node fetch. Qwen rejected those requests. The exact provider validation rule is not known; a local reinstall did not fix it.

The connector does not forward an incoming Qwen access token or cookie to Qwen. Its `API_TOKENS` variable protects the local proxy. comb previously described those as Qwen credentials and supplied model ids that failed with `Model not found`; those catalog assumptions have been removed.

comb now preserves provider errors inside HTTP 200 JSON/SSE, rejects empty responses, requires usable discovery before marking a connector ready, and verifies a real response in Setup. Connector doctor can repair local configuration and runtime faults and retest them. This review does **not** claim that Qwen guest API access through this upstream connector has been restored.

The doctor was also run against the freshly installed real Qwen connector. It reported failed discovery, failed non-streaming chat and failed streaming chat, classified `FAIL_SYS_USER_VALIDATE` as requiring attention, and applied no restart/reinstall loop. Separate HTTP fixtures verified that the doctor repairs stale local URLs and only marks a repair successful after unique response markers return in both response modes. The optional advisor integration was tested with a local protocol fixture; no host LLM is bundled or silently configured.
