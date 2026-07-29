---
name: juggler
description: Use when the user wants to create, repair, or update their Task Juggler artifact — including "add this Slack thread/Linear ticket/Devin URL to my juggler", "scan for new work", or "set up my juggler".
---

# Juggler

Manages the user's Task Juggler artifact: a persistent Cowork artifact
(`dist/task-juggler.html` from the task-juggler repo) that tracks in-flight work
across Slack, Linear, and AI sessions, and surfaces the single best next thing to
do. See `src/` in the repo for the full data model and refresh pipeline.

## Probe before you build (first run only)

Before creating or repairing the artifact, call each MCP tool you intend to wire
in once, in chat, and record its exact name and response shape — do not assume
names or shapes from documentation, since this environment's tool names carry
instance-specific prefixes (e.g. `mcp__<uuid>__slack_read_thread`):

- Every connected Slack connector: note the server prefix for its
  `slack_read_thread` tool. Its response has no `structuredContent` — the thread
  comes back as a single formatted text blob in `content[0].text`. Treat that raw
  text as the canonical context directly; don't try to parse fields out of it.
- Every connected Linear connector (there may be more than one — Linear OAuth is
  workspace-scoped, so each workspace is a separate connector instance): call
  `list_teams` on each to get its workspace/team name, and note its server
  prefix. Build a `{ workspaceLabel -> serverPrefix }` map keyed by that name.
  `get_issue`/`list_issues` return structured JSON via `structuredContent`.
- Matching is case-insensitive by design (`mcpAdapters.js`'s `findWorkspacePrefix`)
  because a pasted Linear URL's workspace slug (e.g. `acme`) and the team name
  from `list_teams` (e.g. `Acme`) won't always share casing — you don't need to
  normalize this yourself, just pass the label through as captured.
- **Claude Desktop sessions (important — this is a primary task source):** look
  for a session-management MCP server, `ccd_session_mgmt`. Verified live: its
  `list_sessions` returns `{ sessionId, title, cwd, isArchived, isRunning,
  lastActivityAt }` and `list_events` returns a plaintext transcript rendering
  with a `limit` param for reading just the tail. Record both names as
  `sessionList` and `sessionEvents`. If this server is NOT exposed to the
  artifact's `mcp_tools` allowlist, Claude Desktop session detection silently
  does nothing — so verify it appears in the artifact's allowed tools, and tell
  the user plainly if it doesn't rather than leaving the feature quietly dead.

## Create or repair the artifact

1. Build the artifact if `dist/task-juggler.html` is stale relative to `src/`:
   `cd task-juggler && npm run build`.
2. Inject a small `<script>` before the main module script, setting the tool
   names discovered in the probe step:
   ```js
   window.__JUGGLER_TOOL_NAMES__ = {
     slackReadThread: "mcp__...__slack_read_thread",
     slackSearch:     "mcp__...__slack_search_public_and_private",
     todoistFindTasks:"mcp__...__find-tasks",
     sessionList:     "mcp__...__list_sessions",   // ccd_session_mgmt
     sessionEvents:   "mcp__...__list_events",     // ccd_session_mgmt
     linearWorkspaces: { "Acme": "mcp__...__", "Globex": "mcp__...__" },
   };
   ```
   Any name left empty just disables that source — the artifact degrades
   gracefully rather than erroring, so a missing connector is survivable.
3. Call `mcp__cowork__create_artifact` (first run) or `update_artifact` (repair)
   with this HTML and the `mcp_tools` list containing every probed tool name.
4. Confirm to the user that the artifact was created/updated and that its state
   (via `localStorage`) persists across sessions.

## Add-by-link chat flow

When the user says something like "add this to my juggler: <link>" or pastes a
Slack/Linear/Devin URL and asks it to be tracked:

1. Recognize the link type using the same rules as `src/urlParser.js` in the repo:
   - Slack permalink (`https://<workspace>.slack.com/archives/<CHANNEL>/p<digits>`)
     → `{ source: "slack", sourceRef: { channelId, threadTs } }` (reconstruct
     `threadTs` by inserting a decimal point 6 digits from the end of the `p`
     digits — e.g. `p1784829904373009` → `1784829904.373009`).
   - Linear issue URL (`https://linear.app/<workspace-slug>/issue/<ID>`) →
     `{ source: "linear", sourceRef: { workspaceLabel: slug, issueId: ID } }`.
   - Anything else → `{ source: "url", sourceRef: { url } }`.
2. Build a full seed task object matching the data model in the design spec
   (id, title, status: "not_started", the fields above, and sensible defaults
   for the rest — `ballInUsersCourt: false` unless you have reason to set it
   `true`, `estRemaining: "medium"`, everything else `null`/`false`/timestamps).
3. Call `update_artifact`, injecting the seed task into the
   `<script id="juggler-seed" type="application/json">` block (merge with any
   existing seed content — don't clobber unconsumed seeds from a prior deep scan;
   the artifact's own `seedMerge.js` dedups by `sourceRef` on load, so it's safe
   to append rather than worry about exact-duplicate seeds).
4. Tell the user the task was queued and will appear next time the artifact loads
   or is brought to front.

## Deep-scan chat flow

When the user asks for a scan (e.g. "check for new in-flight work", "scan my
Slack/Linear for stuff I'm missing"):

1. For each connected Slack connector: search recent threads the user
   participated in (e.g. `is:thread from:me` or `to:me`, last few days), and note
   any thread not already represented in the artifact's current task list.
2. For each connected Linear workspace: `list_issues` with `assignee: "me"`,
   filter to unresolved states, skip issues already present as tasks.
3. If session tools are available, check recent Claude/Claude Code sessions for
   ones that look unfinished.
4. Build seed task objects for everything new, and inject them via
   `update_artifact` exactly as in the add-by-link flow (merge into the seed
   script tag — over-including is safe since dedup happens on load; missing
   something silently is the failure mode to avoid).
5. Summarize what was added to the user in chat.

## What the artifact does on its own (don't duplicate it here)

Once created, the artifact self-polls every 5 minutes while it's open and
visible, and on every Refresh click: it discovers new Slack threads, Linear
issues, Todoist items, and Claude Desktop sessions directly via
`callMcpTool`, and refreshes tracked tasks. It does this without any skill
involvement — the artifact cannot invoke a skill, so it was built not to need
one.

Two behaviors worth knowing before you "help":
- **Dismissal is permanent.** Deleting a task records its identity on a
  dismissed list; discovery will never resurface it. Never re-add something
  the user dismissed, and don't "helpfully" clear the dismissed list.
- **Watermarks prevent re-judging.** Each source records a change signal
  (session `lastActivityAt`, Slack thread ts, Linear `updatedAt`). Unchanged
  items never reach an LLM again. Injecting seed tasks by hand bypasses this,
  so prefer letting the artifact discover things itself.

## Notes

- This skill never writes back to Slack or Linear — read-only.
- The artifact does its own refresh pipeline and AI calls
  (`window.cowork.askClaude`) per task, on a manual Refresh click, debounced and
  cache-checked by content hash; this skill's job is only discovery and
  injection, not status synthesis.
- Degrade gracefully: if a Linear workspace connector is disconnected when you
  probe, skip it (its existing tasks in the artifact will just show stale on next
  refresh, per the artifact's own fetch-failure handling) rather than failing the
  whole create/repair or deep-scan flow.
