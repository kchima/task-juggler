# Task Juggler

A personal workflow juggler for someone who context-switches between Slack
threads, Linear tickets, and multiple AI sessions. Tracks in-flight work, shows
who each item is waiting on, and surfaces the single best next thing to do.
Depth-first, finishing-biased — not a breadth-first to-do list.


## Deliverables

- `dist/task-juggler.html` — the artifact: a single self-contained HTML file meant
  to be created via `mcp__cowork__create_artifact` inside a live Cowork session.
- `plugin/task-juggler/` — the Cowork plugin scaffold with the `juggler` skill.

## Development

```bash
npm install
npm test          # run the full Vitest suite (219 tests)
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
