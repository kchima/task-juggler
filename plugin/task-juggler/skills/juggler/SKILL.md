---
name: juggler
description: Use when the user wants to create, repair, or update their Task Juggler artifact — including "add this Slack thread/Linear ticket/Devin URL to my juggler", "scan for new work", or "set up my juggler".
---

# Juggler

Manages the user's Task Juggler artifact: a persistent Cowork artifact
(`dist/task-juggler.html` from the task-juggler repo) that tracks in-flight work
across Slack, Linear, and AI sessions, and surfaces the single best next thing to
do. See `src/` in the repo for the full data model and refresh pipeline.

## Discover, validate, and build (first run or repair)

Before creating or repairing the artifact, probe every accessible connector to
determine what is available and build a single configuration payload + tool
allowlist. Do this systematically — the order matters because results from one
source determine which tool names must appear in the artifact's allowlist.

### Step 1 — Discover Slack connectors

For each connected Slack connector visible in this environment:

1. Identify the connector's server prefix (e.g. `mcp__<uuid>__` is part of every
   tool name it exposes).
2. Call `slack_read_thread` with a known channel/thread to verify the tool
   exists and observe its response shape. **The response is a JSON envelope,
   not a bare text blob** — it returns `{messages, pagination_info}` where the
   thread body is the string inside `.messages`. Call a search tool to confirm
   it returns `{results, pagination_info}` with results inside `.results`.
   (This is live-verified: an earlier version of this doc assumed bare text,
   and code written against that treated *every real thread* as unfetchable.)
3. Record the full tool name for `slack_read_thread` and the full tool name
   for `slack_search_public_and_private` (or whatever search tool is exposed).

If no Slack connector is available, note that Slack tasks will not be
auto-discovered. Existing Slack tasks still refresh via their stored
thread references.

### Step 2 — Discover Linear workspaces

For each connected Linear connector (there may be more than one — Linear OAuth
is workspace-scoped, so each workspace is a separate connector instance):

1. Identify the connector's server prefix.
2. Call `list_teams` on it to get the workspace/team name.
3. Record the team name (user-visible label, e.g. `Acme`) and the server
   prefix. Matching against a pasted URL slug is case-insensitive by design
   — `mcpAdapters.js`'s `findWorkspacePrefix` handles casing differences
   between a URL slug (`acme`) and a team name (`Acme`).
4. Also call `list_issues` with `{ assignee: "me" }` and verify it returns
   structured JSON via `structuredContent` with an `issues` array. If it
   throws (connector invalidated / needs reconnect), skip that workspace —
   its existing tasks will show stale on next refresh rather than failing
   everything.

If no Linear connector is available, note that Linear tasks will not be
auto-discovered.

### Step 3 — Discover Todoist

If a Todoist connector (`find-tasks` tool) is available:

1. Call `find-tasks` with `{ filter: "today | overdue | p1", limit: 50 }`.
2. Verify the result returns structured JSON with a `tasks` array containing
   objects that have at least `id` and `content` string fields.
3. If the shape is valid, record the full tool name. If it throws or returns
   an unexpected shape, skip Todoist — it will not be auto-discovered.

If no Todoist connector is available, note that existing Todoist tasks are
not refreshable (Todoist is in `NO_REFRESH_ADAPTER_SOURCES`).

### Step 4 — Claude/Cowork sessions (chat only, not artifact)

Do not add session tool names to the artifact configuration. This is a
**settled finding confirmed twice**: `session_info.list_sessions` works from
chat but fails from inside the artifact with `Tool call failed: 400` — a
deliberate platform restriction on enumerating sessions from a less-trusted
artifact context. Use the deep-scan chat flow below (see "Deep-scan chat
flow") for session discovery.

If `ccd_session_mgmt` (Claude Code) is present but `session_info` (Cowork)
is the host's tool, note which — the deep-scan flow handles both shapes
differently.

### Step 5 — Build the configuration payload

Collect the recorded values and build the config JSON and tool allowlist
together:

```js
// Pseudocode — substitute the actual discovered names
const probeResults = {
  slack: readThreadTool && searchTool
    ? { readThread: readThreadTool, search: searchTool }
    : null,
  linearWorkspaces: [
    // One entry per workspace that responded successfully
    { label: "Acme", prefix: "mcp__<uuid>__" },
  ],
  todoist: todoistTool ? { findTasks: todoistTool } : null,
};

// These are exported from src/connectorConfig.js but the logic is simple
// enough to do by hand if you can't import:
//   config object = { slackReadThread, slackSearch, linearWorkspaces, todoistFindTasks }
//   allowlist     = all tool-level names (Slack read/search, Linear prefix+tool, Todoist)
const configJson = buildToolConfig(probeResults);
const mcpToolsAllowlist = configToMcpTools(configJson);
```

The resulting config JSON goes into `#juggler-tool-config`. The allowlist
goes into the `mcp_tools` parameter of `create_artifact` / `update_artifact`.
Because both are derived from the same probe results, they cannot drift.

If a connector was unavailable or threw, simply omit it from `probeResults` —
`buildToolConfig` will write empty defaults and `configToMcpTools` will not
generate any allowlist entries for it, so the artifact degrades gracefully.

## Create or repair the artifact

1. Build the artifact if `dist/task-juggler.html` is stale relative to `src/`:
   `cd task-juggler && npm run build`.
2. Inject the config JSON (from Step 5 above) into the canonical tool-config
   block:
   ```html
   <script id="juggler-tool-config" type="application/json">{"slackReadThread":"mcp__...__slack_read_thread","slackSearch":"mcp__...__slack_search","linearWorkspaces":{"Acme":"mcp__...__"},"todoistFindTasks":"mcp__...__find-tasks"}</script>
   ```
   No session-related names here — the artifact never calls a session tool
   at all (see Step 4 above). Any field left empty (or absent from the config)
   just disables that source — the artifact degrades gracefully rather than
   erroring, so a missing connector is survivable.
3. Call `mcp__cowork__create_artifact` (first run) or `update_artifact` (repair)
   with this HTML and an `mcp_tools` list set to the allowlist from Step 5.
   Because the allowlist is derived from the same probe results as the config
   JSON, configuration and permissions cannot drift.
4. Confirm to the user that the artifact was created/updated and that its state
   (via `localStorage`) persists across sessions. Tell them which connectors
   were detected, which were skipped, and (for Linear) how many workspaces are
   configured.

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
      **Normalize the slug against the configured workspace labels before storing**
      (match case-insensitively; use the canonical label from the config).
      Without this, a pasted URL with lowercase `acme` and a discovered task with
      uppercase `Acme` produce different identity keys, causing duplicate tasks
      and ineffective dismissals. The artifact's `addByLink` does this
      normalization automatically; when building seed tasks by hand, do it
      yourself.
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
by oversight (see Step 4 of "Discover, validate, and build" above). The artifact has no
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
