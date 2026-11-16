# Observability

Where to look when something is off or you want to know what to improve.

## 1. Workers Logs (Cloudflare dashboard, 7 days)
Dashboard > Workers & Pages > **feast** > **Observability** (turned on in `wrangler.toml`).
Every `/api/*` call is logged as one structured line, and every field is searchable:

| `event` | Fields | Tells you |
| --- | --- | --- |
| `request` | `method`, `path`, `status`, `ms` | traffic, slow calls, 4xx/5xx (warnings and errors stand out) |
| `gemini_upstream` | `status`, `ms`, `requestBytes`, `error` | rate limits (429), slow Gemini calls, rejected keys |
| `state_conflict` | `clientRev`, `serverRev` | two devices saving at once |
| `client` | `type`, `level`, `message`, `data`, `count`, `device`, `version`, `page` | what the app reports (below) |
| `batch_submitted`, `batch_submit_failed`, `batch_unavailable`, `batch_failed`, `batch_poll_failed`, `batch_models`, `work_done`, `work_waiting`, `work_stopped`, `work_bad_output`, `cron_work` | `kind` (t = translate, a = annotate), `ms`, `calls`, `reason`, `waitMs` | background work on the server (see `BACKGROUND_WORK.md`) |
| `feedback_proposed`, `feedback_decided`, `feedback_commented`, `feedback_failed` | `proposalId`, `changes`, `ms`, `model`, `round`, `noChange`, `feedback`, `summary`, `decision`, `rounds`, `reason`, `attempts` | the recipe Feedback flow (below) |
| `unhandled_error` | `path`, `message`, `stack` | bugs in the worker |

### Recipe feedback events
One line per step: `feedback_proposed` (the AI made a proposal: number of `changes`, `ms`, `model`, `round` = 1 for the first proposal and higher after comments), `feedback_decided` (`decision` approved or declined, `rounds` = how many proposals it took), `feedback_commented` (the cook commented on the proposal of `round`), `feedback_failed` (the AI call gave an unusable answer: `reason`, `attempts` so far). Rate limits are not failures here; see `feedback_waiting`.
Only when the AI proposes nothing (`noChange: true`) does `feedback_proposed` also carry the cook's `feedback` text and the AI's `summary`, each cut to 300 characters, so requests Feast can't do show up. No other recipe content is logged.
Filter: `event = feedback_proposed AND noChange = true`.

Handy filters: `event = client AND level = error`, `event = gemini_upstream AND status != 200`.
Live view from a terminal: `npx wrangler tail feast --format json`.

## 2. What the app reports (`/api/log`)
No recipe content, only:
- `js_error`, `unhandled_rejection`: errors nobody handled (message, a short stack, app version, page)
- `job_import`, `job_translate`, `job_reparse`: outcome of every background job (status, method, duration, host for imports)
- `job_*_retry`: a job waiting on a rate limit or hiccup
- `sync_conflict`: this device had to reload the latest version

Repeated identical errors are counted, not repeated. Local dev (no worker) sends nothing.

## 3. Longer history (KV, no expiry)
Three keys in the `FEAST` namespace, readable with wrangler:
- `activity`: last 2000 import / translation / re-parse entries (also shown in Settings > Activity log)
- `clientlog`: last 1000 client events
- `proposals`: recipe feedback proposals; `observe.mjs` only counts them (proposals, approval and decline rate, average rounds, no-change, failed)

```bash
node scripts/observe.mjs              # summary: success rate and p50/p95 per method, top errors, versions
node scripts/observe.mjs --days 30    # other window
node scripts/observe.mjs --preview    # the PR test database
node scripts/observe.mjs --json       # raw numbers
```
Needs `npx wrangler login` once. It only reads those keys and never prints recipes.

## 4. In the app
Settings > Activity log shows the same job entries, merged across your devices.
