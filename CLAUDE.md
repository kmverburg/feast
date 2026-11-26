# Feast

Both factory agents read this file first. Keep it short and accurate.

## What this app is
Feast is a personal recipe, meal-planning and shopping-list app (installable web app, English and Dutch). Recipes can be imported from a URL, pasted text, a photo or a Cookmate XML file, and are translated and annotated by AI, also in the background with the app closed. It is used by one household behind Cloudflare Access.

## Stack
- React 18 + TypeScript, built with Vite (`src/`), `lucide-react` icons, `@dnd-kit` for drag and drop.
- One Cloudflare Worker (`worker/index.js`, plain JavaScript) serves `/api/*` and the built SPA (`dist/`) as static assets. State, images and background-work data live in one Workers KV namespace (binding `FEAST`). A cron trigger runs every minute for background work.
- AI: Gemini by default, Mistral optionally. Deployed with wrangler by GitHub Actions (`.github/workflows/deploy.yml`: production on `main`, a per-PR preview version otherwise).

## Commands
- Install: `npm ci`
- Test: `npm test` (esbuild bundles `tests/*.test.mjs`, then `node --test`; about 47 tests, no network or secrets needed)
- Lint: there is no linter. Type checking is part of the build (`tsc`).
- Build: `npm run build` (`tsc && vite build`, output in `dist/`; the chunk-size warning is normal)
- Check the Worker config (as CI does): `npx --yes wrangler@4 deploy --dry-run` and `npx --yes wrangler@4 deploy --dry-run -c wrangler.preview.toml`
- Run locally, front end only: `npm run dev` serves http://localhost:5173. There is no worker, so recipes are kept in the browser's localStorage and nothing is synced. This needs no secrets and is the quickest way to check UI changes. AI calls only work if `.env.local` has a dev `GEMINI_API_KEY` (see `.env.example`); agents have none, so do not try AI features.
- Run locally, with the Worker: `cp .dev.vars.example .dev.vars` (git-ignored; leave `GEMINI_API_KEY` empty, never add a real key), then `npx --yes wrangler@4 dev --test-scheduled --port 8787` after `npm run build`. It serves http://localhost:8787 with a local KV. (`npm run dev:worker` does the same build + start, but it needs `wrangler` installed, which is not a dependency, so it fails with "wrangler: not found" in a fresh checkout.)
  - The Worker returns 403 for requests without a `Cf-Access-Jwt-Assertion` header. `.dev.vars.example` sets `DEV_SKIP_ACCESS=1`, which switches that check off locally, so browsers and `curl` work with no login or header (`curl localhost:8787/api/state` returns `{"rev":0,"data":null}` on a fresh KV).
  - Optional in `.dev.vars`: `GEMINI_BASE=http://127.0.0.1:8799` points Gemini calls at a local stand-in you run yourself, and `WORK_GAP_MS=0` removes the pause between calls.
  - Rebuild (`npm run build`) after front-end changes; the Worker serves `dist/`.
- Benchmarks (`npm run bench*`) call real AI providers with real keys. Do not run them.

## Checking UI changes in the headless browser
1. Start `npm run dev` in the background (or the Worker as above if the change involves `/api`), and wait until the URL answers.
2. Write a throwaway Python Playwright script under `.factory/` (`from playwright.sync_api import sync_playwright`), open the URL with Chromium, click through the changed flow and its edge cases, and save screenshots under `.factory/`. Then look at them.
3. The app is used mostly on phones: also check a narrow viewport (e.g. 390x844) as well as a desktop one, in the light and dark theme.
4. First-run data comes from `INITIAL_RECIPES` in `src/services/storageService.ts`, so a fresh browser profile already has recipes to click on.
5. Stop the servers you started.

## Previews
Every PR from this repo gets a preview: the `preview` job in `.github/workflows/deploy.yml` builds with `VITE_APP_ENV=preview` (a TEST badge shows) and uploads a separate Worker version with `wrangler.preview.toml` and the alias `pr-<number>`. It has its own KV namespace (never production data), no cron, and `APP_ENV=preview`, which tags every log line `env: "preview"` so the log scout ignores it. It sits behind Cloudflare Access like production, and uses the `*_API_KEY_TEST` secrets when set (see `GEMINI_KEYS.md`).
To find a PR's preview URL: the workflow posts it as a PR comment starting with "**Test version:**" (marker `<!-- feast-preview -->`); it is also in the "Upload preview version" step log, and has the form `https://pr-<number>-feast.<account-subdomain>.workers.dev`.

## Conventions
- UI components in `src/components/`, hooks in `src/hooks/`, storage, sync, AI and import logic in `src/services/`, types in `src/types/`, code shared with the worker in `src/shared/`.
- Worker code lives in `worker/` (`index.js` routing, `gemini.js` and `providers.js` AI calls, `work.js` background work, `feedback.js`, `push.js`). It is plain JS with no build step; `worker/gemini.js` is also used by the Vite dev server.
- Tests are `tests/*.test.mjs` using `node:test`; add one beside the existing ones for logic you change, in the same style.
- The app has English and Dutch text; add both when you add user-visible strings, following the existing pattern.
- Match the existing style; keep changes small. Never put a key in a committed file or a `VITE_` variable (those get bundled into the app).
- Existing docs. Link to them, do not copy them, and update them if you change what they describe:
  - `OBSERVABILITY.md`: logs, events and what the app reports (`/api/log`). Read before adding or changing logging.
  - `BACKGROUND_WORK.md`: server-side translating/annotating, cron, Gemini batch API, patches in KV.
  - `AI_PROVIDERS.md`: Gemini/Mistral switch and `worker/providers.js`.
  - `GEMINI_KEYS.md`: which key lives where, models, rotating keys.
  - `BENCHMARK.md` and `AI_PROVIDER_BENCHMARK.md`: the AI benchmark and its plan.

## Off-limits
- `.github/`: change workflow files only when the ticket explicitly asks for it, never otherwise. The reviewer always escalates such a PR and it never auto-merges, so a human approves every workflow change.
- `wrangler.toml` and `wrangler.preview.toml`: the `routes` (production custom domain), `[triggers]`, `[[kv_namespaces]]` ids and bindings, `[assets]` settings and `workers_dev`/`preview_urls`. Never change them unless the ticket explicitly asks. `wrangler.preview.toml` must stay identical to `wrangler.toml` except for its own KV namespace, no cron and `PUMP_ON_POLL`, so that test data never touches real recipes.
- Secrets and API keys: never read, create or change `.env`, `.env.local`, `.dev.vars` with real values, or GitHub/Worker secrets (`GEMINI_API_KEY`, `GEMINI_API_KEY_TEST`, `MISTRAL_API_KEY`, `MISTRAL_API_KEY_TEST`, Cloudflare tokens). Never log or echo them, never add them to code, tests, docs or screenshots, and never run commands that use a real key (benchmarks, real AI calls, `wrangler secret`).
- The Cloudflare Access check in `worker/index.js` (the `Cf-Access-Jwt-Assertion` header and `DEV_SKIP_ACCESS`): do not weaken or bypass it. `DEV_SKIP_ACCESS` must never be set in `wrangler.toml` or CI.
- Never deploy, and never run wrangler commands against the real account (`wrangler deploy` without `--dry-run`, `kv` commands, `tail`, `secret`). Only local `wrangler dev` and `--dry-run` are fine.

## Factory review rules
Escalate to a human (do not approve on your own) when the change:
- touches `wrangler.toml` or `wrangler.preview.toml` routes, triggers, bindings, KV ids, assets or vars, or makes the two files drift apart in anything other than the intended differences.
- touches `.github/`, secrets or API keys, how a key is read, sent or logged, or adds a new key or provider setting. Any key in code, tests, logs or a `VITE_` variable is a blocker.
- changes the Access check, or adds an `/api/*` route that skips it.
- changes stored user data: the shape of the `state` KV value or localStorage data, `src/services/storageService.ts`, sync and revision/conflict handling (`rev`, `state_conflict`), the `work` patches and their fingerprints, KV key names, image storage, or the import/export and Cookmate import. Such a change needs a migration path for existing data, and must not delete or overwrite recipes, shopping lists or meal plans.
- changes the background work or cron (`worker/work.js`, batch handling) in a way that could write recipes directly, loop, or multiply AI calls and cost.
- changes tests so they pass (weakened or deleted assertions) rather than fixing the code.
