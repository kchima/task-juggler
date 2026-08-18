# Task Juggler

A personal workflow juggler for someone who context-switches between Slack
threads, Linear tickets, and multiple AI sessions. Tracks in-flight work, shows
who each item is waiting on, and surfaces the single best next thing to do.
Depth-first, finishing-biased — not a breadth-first to-do list.

## Quick start — the local app

The primary product is a **local web app + localhost service** (`app/`). Run it,
open the browser, connect sources, and paste API tokens to pull in work.

```bash
./run.sh        # or: npm start
# open http://localhost:3000  (binds to 127.0.0.1 only)
```

Sources connect two ways: **OAuth via "Connect with browser"** (Linear, Todoist —
zero-setup through their hosted MCP endpoints) or a **paste-an-API-token** (Slack,
Devin). Tokens you paste are stored in your macOS Keychain and survive restarts.

AI classification is on by default once you set an OpenRouter key: it re-judges
new/changed work every few minutes (within a daily budget) and surfaces what
needs you at the top. See ["Getting an API token for each source"](#getting-an-api-token-for-each-source) below.

## Getting an API token for each source

### Slack

A Slack token works, but note that **on modern Slack every token still comes
from a Slack app** — the old "grab a token" pages are deprecated. The good news:
getting a bot token is quick and involves **none** of the OAuth redirect/PKCE
boilerplate.

1. Go to https://api.slack.com/apps → **Create New App → From scratch**.
2. Under **OAuth & Permissions → Bot Token Scopes**, add:
   `search:read`, `search:read.private`, `channels:history`, `groups:history`,
   `mpim:history`, `im:history`, `users:read`, `channels:read`, `files:read`,
   `emoji:read`, `reactions:read`.
3. **Install to Workspace** (your workspace may require admin approval).
4. Copy the **Bot User OAuth Token** (`xoxb-…`) from **OAuth & Permissions**.
5. Task Juggler → **Connections → Slack → Add Slack token** → paste it.

A bot token searches the channels its bot is in. For the strongest "threads I
need to reply to" signal (`to:me` search), a **user token** (`xoxp-…`) is better
but now requires an OAuth flow — use Task Juggler's **"Advanced: OAuth (requires
a Slack app)"** option for that.

### Devin

1. Sign in at https://app.devin.ai, then open your **account settings → API / service users**.
2. Create an **API key** (Devin service-user keys start with `cog_`).
3. Task Juggler → **Connections → Devin → API Token** → paste the `cog_…` key.

(Devin's hosted MCP has no OAuth — it is key-authenticated only. An org-scoped
service-user key works on its own; enterprise/org-scoped keys may additionally
need an org id.)

### Linear

Prefer **Connect with browser** — OAuth through `mcp.linear.app`, zero-setup.
If you'd rather use a key:

1. Linear app → **Settings → Security & permissions → Personal API keys → Create**,
   then copy the `lin_api_…` key.
2. Set it as the `LINEAR_API_KEY` environment variable before starting the
   server (the Linear UI entry is OAuth; the key path is env-based).

### Todoist

Prefer **Connect with browser** — OAuth through `ai.todoist.net`, zero-setup,
read-only `data:read` scope. If you want a plain token instead, Todoist →
**Settings → Integrations → API token**, and set it as `TODOIST_API_TOKEN`
(Todoist's UI entry is OAuth; the token path is env-based).

### OpenRouter (the AI classifier)

1. https://openrouter.ai/keys → **Create API key** → copy the `sk-or-…` key.
2. Make it available to the server process, e.g. `OPENROUTER_API_KEY=sk-or-… ./run.sh`
   (or `export OPENROUTER_API_KEY=…` before starting).

The classifier pins the cheap `deepseek/deepseek-v4-flash-0731` by default, runs
every few minutes, and stops once it hits the `$0.25/day` budget. Tune with
`TASK_JUGGLER_AI_*` env vars, or set `TASK_JUGGLER_AI_ENABLED=false` to disable
AI classification entirely.


## Deliverables

- `dist/task-juggler.html` — the artifact: a single self-contained HTML file meant
  to be created via `mcp__cowork__create_artifact` inside a live Cowork session.
- `plugin/task-juggler/` — the Cowork plugin scaffold with the `juggler` skill.

## Development

```bash
npm install
npm test          # run the full Vitest suite (364 tests)
npm run build      # rebuild dist/task-juggler.html from src/
```

## Local end-to-end testing (no real Cowork session required)

`window.cowork.*` only exists inside a live Cowork session, which this repo has no
way to reach. `tests/harness.html` defines a mock `window.cowork` seeded with real
captured Slack/Linear response shapes (see `tests/fixtures/`), loads the built
artifact into it, and can be driven with a browser to exercise the full UI —
add/edit/delete/status-cycle/reopen, the refresh cache-hit/cache-miss pipeline,
debounce, card-view skip, and add-by-link.

```bash
npx --yes http-server -p 8123 -c-1
# then open http://localhost:8123/tests/harness.html
```

This validates everything except the actual `window.cowork` wiring itself, which
can only be confirmed inside a real Cowork session once the artifact is created
there. Note that unit tests import `src/*.js` directly and never exercise the
concatenated `dist/task-juggler.html` — the harness is what catches build-only
bugs (one such bug, a silently-broken import alias that disabled the delete
button, was found exactly this way; see `plugin/task-juggler/README.md`).

## Acceptance checklist

- [x] Artifact opens across sessions with tasks intact (localStorage via the
      storage interface) — verified via the harness across multiple tab reloads.
- [x] No UI code touches localStorage directly — all state flows through
      `src/storage.js` (spot-checked; `grep -rn "localStorage" src/` shows only
      `storage.js` and the two boot-time calls in `main.js` that go through
      `loadTasks`/`saveTasks`), and the milestone-2 Notion adapter design is
      documented in `plugin/task-juggler/README.md`.
- [x] Manual add/edit/delete/status-cycle/reopen all work; manual status pins
      against AI override — `tests/app.test.js`, `tests/main.test.js`, and live
      in the harness (including finding and fixing a critical delete bug and
      verifying the fix live afterward).
- [x] Refresh with zero changed sources makes zero askClaude calls — asserted in
      `tests/app.test.js` ("makes zero askClaude calls...") and confirmed live
      via the harness's per-task refresh cache-hit check.
- [x] Changing one Slack thread causes exactly one askClaude call, updating only
      that task — `tests/app.test.js` ("makes exactly one askClaude call...") and
      confirmed live via the harness's `__jugglerFlipSlackFixture()` helper.
- [x] Refresh is debounced; concurrent per-task calls are limited to 3 —
      `tests/app.test.js` ("is debounced...", "limits concurrency to 3...").
- [x] Priority ordering demonstrates finishing bias: a small-remaining,
      ball-in-user's-court task outranks a high-priority task waiting on an AI —
      `tests/scoring.test.js` ("the finishing-bias acceptance case").
- [x] Completed tasks: strikethrough, bottom, one-click reopen — `tests/ui.test.js`
      and confirmed live in the harness.
- [x] Paste a Slack permalink / Linear URL / arbitrary URL → correct source type
      created — `tests/urlParser.test.js`, `tests/app.test.js`, and confirmed live
      in the harness against real captured URLs (including finding and fixing a
      case-sensitive workspace-matching bug for the Linear case).
- [x] Plugin scaffold with the `juggler` skill exists and documents the deep-scan
      and add-by-link chat flows — `plugin/task-juggler/skills/juggler/SKILL.md`.

## Non-goals (v1)

No background polling, no notifications, no multi-user, no Todoist/Linear
write-back, no Notion adapter implementation (design only — see
`plugin/task-juggler/README.md`), no direct Devin API integration.
