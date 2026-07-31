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
  `slack_read_thread` and search tools. **Both return a JSON envelope, not a bare
  text blob** — `slack_read_thread` gives `{messages, pagination_info}` and search
  gives `{results, pagination_info}`, where the thread/search body is the string
  inside `.messages` / `.results`. This is live-verified and worth being exact
  about: an earlier version of this doc claimed the thread arrived as raw text in
  `content[0].text`, and code written against that assumption treated *every real
  thread* as unfetchable, while a bare-string test fixture passed happily. Treat
  the extracted `.messages` string as the canonical context; don't parse fields
  out of it beyond that.
- Every connected Linear connector (there may be more than one — Linear OAuth is
  workspace-scoped, so each workspace is a separate connector instance): call
  `list_teams` on each to get its workspace/team name, and note its server
  prefix. Build a `{ workspaceLabel -> serverPrefix }` map keyed by that name.
  `get_issue`/`list_issues` return structured JSON via `structuredContent`.
- Matching is case-insensitive by design (`mcpAdapters.js`'s `findWorkspacePrefix`)
  because a pasted Linear URL's workspace slug (e.g. `acme`) and the team name
  from `list_teams` (e.g. `Acme`) won't always share casing — you don't need to
  normalize this yourself, just pass the label through as captured.
- **Claude Desktop / Cowork sessions — do this from CHAT, not the artifact.**
  Which server exists depends on the host, and they are NOT interchangeable.
  Claude Code exposes `ccd_session_mgmt`, whose `list_sessions` returns a real
  array of `{ sessionId, title, cwd, isArchived, isRunning, lastActivityAt }`
  (verified live) with `list_events` for the transcript tail. Cowork exposes
  `session_info` instead — schema confirmed live from its own tool
  definition, one optional param: `{ limit: number }` (default 20, most
  recent first). Its response is **prose**, not JSON:
  ```
  Sessions (N of TOTAL, most recent first...)
    - <sessionId> "<title>" (<status>, cwd: <path>, is_child: <bool>)
    ...
  ```
  No `isArchived`/`lastActivityAt` anywhere — there is no timestamp field at
  all, so staleness has to come from "most recent first" ordering plus a
  count cutoff, not a date comparison. `read_transcript` is presumably the
  tail-reading counterpart, but its shape is NOT verified — probe it the same
  way before writing anything against it.

  **Settled finding, confirmed twice: `session_info__list_sessions` works
  fine from chat and fails from inside the artifact, with the exact same
  arguments.** Called from chat with `{ limit: 3 }` (and with `{}`, and with
  `{ limit: "3" }`), it returns real session data every time. Called from
  inside a deployed artifact via `callMcpTool` with those identical
  arguments, it returned `Tool call failed: 400` every time — a bare,
  contentless refusal, not the labeled
  `"...not in this artifact's mcp_tools allowlist"` message a genuine
  allowlist rejection gives (`ccd_session_mgmt`, tried from the same artifact,
  gave that exact labeled message instead, since it isn't declared in
  `mcp_tools` at all). Since every other source (Slack, Linear, Todoist)
  calls tools from inside this same artifact successfully, this isn't a
  general sandbox limitation — it looks like a deliberate, tool-specific
  restriction on enumerating a user's full cross-session list from a
  less-trusted artifact context, which makes sense: that's a much broader
  disclosure surface (every session title and working directory on the
  user's machine) than one Slack workspace or Linear project.

  This is a closed question, not an open one — don't spend time re-probing it
  or trying to route around it from the artifact side. **Claude session
  discovery only ever runs in chat**, via the deep-scan flow below, injecting
  results as seed tasks the same way add-by-link already does. There used to
  be artifact-side code and a Probe button for this; both were removed once
  the platform restriction was confirmed stable rather than left as dead
  weight pointed at a permanent dead end. If a future host or config change
  ever lets an artifact call `session_info` successfully, that would be worth
  re-adding — but don't assume it without a fresh probe first.

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
     linearWorkspaces: { "Acme": "mcp__...__", "Globex": "mcp__...__" },
   };
   ```
   No session-related names here — the artifact never calls a session tool
   at all (see above). Any other name left empty just disables that source —
   the artifact degrades gracefully rather than erroring, so a missing
   connector is survivable.
3. Call `mcp__cowork__create_artifact` (first run) or `update_artifact` (repair)
   with this HTML and the `mcp_tools` list containing every probed tool name
   (Slack, Linear, Todoist only).
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
3. Claude sessions — **this step only runs here, in chat; the artifact
   cannot do it itself** (see the settled finding above: session-listing
   tools fail specifically from inside the artifact bridge, even correctly
   configured).
   1. Call whichever session-list tool is present
      (`ccd_session_mgmt.list_sessions` or `session_info.list_sessions`),
      `{ limit: 20 }` or similar.
   2. For `ccd_session_mgmt`: parse the real JSON array
      (`{sessionId, title, cwd, isArchived, isRunning, lastActivityAt}`),
      skip `isArchived` and anything with `lastActivityAt` older than ~72h.
   3. For `session_info`: parse the prose, one session per line matching
      ` - <id> "<title>" (<status>, cwd: <path>, is_child: <bool>)`. There's
      no timestamp field at all here — use "most recent first" ordering
      plus a count cutoff (e.g. only consider the first ~15-20 listed) as
      the staleness proxy instead of a date comparison.
   4. Skip anything already present in the artifact's current task list
      (match by `sessionId`) or on its dismissed list, same as any other
      source.
   5. For each remaining candidate, read its transcript tail
      (`read_transcript` / `list_events` — this shape is NOT verified,
      probe it fresh before relying on it) and judge directly, as part of
      this same chat turn, whether it looks unfinished and who it's
      waiting on. No separate AI call needed — you're already doing the
      judging.
   6. Shape anything genuinely unfinished as
      `{ title, source: "claude_session", sourceRef: { sessionId, cwd },
      summary, waitingOn, ballInUsersCourt: waitingOn === "user" }`.
4. Build seed task objects for everything new, and inject them via
   `update_artifact` exactly as in the add-by-link flow (merge into the seed
   script tag — over-including is safe since dedup happens on load; missing
   something silently is the failure mode to avoid).
5. Summarize what was added to the user in chat.

## What the artifact does on its own (don't duplicate it here)

Once created, the artifact self-polls every 5 minutes while it's open and
visible, and on every Refresh click: it discovers new Slack threads and
Linear/Todoist items directly via `callMcpTool`, and refreshes tracked
tasks. It does this without any skill involvement — the artifact cannot
invoke a skill, so it was built not to need one for those three sources.

Claude sessions are the one source this does NOT cover — deliberately, not
by oversight (see "Probe before you build" above). The artifact has no
session-discovery code and no session-related UI at all; that entire
source only exists via the deep-scan chat flow below.

Two behaviors worth knowing before you "help":
- **Dismissal is permanent.** Deleting a task records its identity on a
  dismissed list; discovery will never resurface it. Never re-add something
  the user dismissed, and don't "helpfully" clear the dismissed list.
- **Watermarks prevent re-judging.** Slack records a versioned content-hash
  signal per thread (unchanged content never reaches an LLM again — see
  `SLACK_JUDGMENT_VERSION` in `src/app.js` if that classification logic ever
  changes in a way that should force a fresh look). Injecting seed tasks by
  hand bypasses this, so prefer letting the artifact discover things itself
  where it can (Slack, Linear, Todoist).

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
