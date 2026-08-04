# Task Juggler plugin

Cowork plugin scaffold for Task Juggler — see the parent repo's `src/` for the
full design and the artifact's source.

## Structure

- `.claude-plugin/plugin.json` — plugin manifest.
- `skills/juggler/SKILL.md` — the `juggler` skill: create/repair the artifact,
  add-by-link and deep-scan chat flows.

## State architecture: the milestone-2 Notion adapter (not built in v1)

v1 uses `localStorage` as the canonical store, accessed only through the storage
interface in `src/storage.js` (`loadTasks`, `saveTasks`, `patchTask`, `addTask`,
`deleteTask`). Nothing else in the codebase touches `localStorage` directly. This
interface is the seam a future backend adapter plugs into without touching UI or
pipeline code.

Intended milestone-2 design, for a Notion-backed adapter (enables mobile/voice
access to the same task list via Notion's own apps):

- **Auto-provisioning**: on first run, the `juggler` skill checks (via
  `notion-search`) for an existing "Task Juggler" database. If absent, it creates
  one (via `notion-create-database`) with properties mirroring the data model:
  Title, Source (select), Status (select), Summary (rich text), Next Action (rich
  text), Waiting On (rich text), Ball In User's Court (checkbox), Est Remaining
  (select), Due Date (date), Source Priority (select), Context Hash (rich text),
  Last AI Run At (date), User Pinned Status (checkbox).
- **Write-through with retry**: `storage.js`'s functions become async and, after
  writing to `localStorage` (kept as the fast local cache), enqueue a
  `notion-update-page` / `notion-create-pages` call. On failure, the write is
  retried with backoff on the next `saveTasks`/`patchTask` call rather than
  blocking the UI — the local write always succeeds first, so the UI never waits
  on Notion round-trips.
- **localStorage demoted to cache**: on boot, if the Notion adapter is configured,
  it becomes the source of truth (`notion-query-database-view` populates
  `localStorage` on load); `localStorage` alone remains authoritative only when no
  Notion database is configured, preserving today's fully-local v1 behavior as a
  fallback.
- **Interface unchanged**: `loadTasks`/`saveTasks`/`patchTask`/`addTask`/
  `deleteTask` keep their exact signatures (becoming `Promise`-returning); no
  caller outside `storage.js` needs to change.

This is a design note only — no Notion code exists in this repo yet.

## A build-time lesson worth knowing before touching the artifact build

`build/inline.mjs` concatenates `src/*.js` into one inline `<script>` for the
shipped artifact by stripping `import`/`export` lines with regex — it is not a
real bundler and does not resolve import aliases. `import { x as y } from './m.js'`
will build "successfully" but leave `y` undefined at runtime, because the alias
binding only exists in real ES module semantics, not in a flat concatenation. The
build script now throws a build-time error if it detects an aliased import, but if
you ever replace `build/inline.mjs` with something else, keep that guard (or use a
real bundler that understands aliases). This was found live, the hard way: it
broke the delete button in a way that 219/219 unit tests didn't catch, because the
tests import `src/*.js` directly and never exercise the built `dist/` output.
