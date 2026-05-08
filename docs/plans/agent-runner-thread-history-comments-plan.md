# Agent Runner Thread-History Comments Plan

Status: draft plan
Scope: comment lifecycle redesign — append per-run result comments to issue/PR threads, truncate the sticky status comment, preserve PR #17 state-recovery invariants
Baseline: `main` after PR #17 (`Harden state reconciliation against untrusted-author markers`)
Canonical consumer slug: `netlify-labs/agent-runner-action@v1`

## Purpose

After running the action against real issues and PRs for several weeks, a usability problem has emerged: each new `@netlify` trigger overwrites the sticky status comment, so when an issue or PR fires the agent multiple times the previous run's narrative disappears from the GitHub timeline. The full results still exist inside the Netlify dashboard, but contributors looking at the GitHub thread see only the latest run. There is no chronological audit trail in the place reviewers actually read.

A second symptom is hidden today but will bite soon: the existing `generate-history-comment.js` consolidates *all* runs into a single growing comment. GitHub caps comment bodies at 65,536 characters; long-lived threads with many runs will eventually fail to update, silently truncating history.

The fix is to split the current single-comment lifecycle into two distinct comment kinds, one mutable and one immutable:

1. The sticky status comment becomes a short, glanceable summary of the latest run (target ≤ 1000 user-visible characters), continuing to carry the runner-id and session-data state markers used by `extract-agent-id` and `find-comment`.
2. Each run additionally appends an immutable result comment to the issue/PR thread. This comment carries the full prompt, agent narrative, screenshot, and links — the content that today is squeezed into the status comment. It does **not** carry the state markers, so it is invisible to `find-comment` and irrelevant to `reconcileAgentState`.

The truncated status comment hyperlinks down to the latest result comment via a `#issuecomment-<id>` anchor so a reviewer landing at the top of the thread can still reach the full content in one click.

This plan is intentionally implementation-oriented but is meant to be reviewed and converted into beads before any code is written. PR #17 just shipped meaningful state-recovery hardening; the design here is constrained to preserve those invariants.

## Current Ground Truth

The action runs through the following comment-related steps today (`action.yml` line numbers approximate, on `main` at e854b19):

- `Find existing status comment` (line 362) — `peter-evans/find-comment@v4`, filters by bot identity (resolved at `bot-identity` step) and `body-includes: '<!-- netlify-agent-run-status -->'`, takes the **last** match. This is the comment whose markers seed state recovery.
- `Find existing history comment` (line 373) — same filter pattern, body-includes `'<!-- netlify-agent-run-history -->'`, only on PRs. Drives `Post or update history comment`.
- `Extract existing agent run ID` (line 384) — invokes `src/extract-agent-id.js`, which calls `reconcileAgentState` over the (sanitized) status-comment body and, for same-repo PRs only, the PR body. PR #17 added the bot-author filter on `find-comment`, the same-repo gate in `extract-agent-id`, the URL/SHA allowlists in `comment-markers`, and the read/write HTML-comment scrubbers.
- `Post preflight status comment` (line 406) — direct `github.rest.issues.{create,update}Comment` with the status marker; used when preflight blocks the agent run before it starts.
- `Create initial status comment` (line 540) — first-run-only create, body from `utils.buildInProgressComment`, no markers yet (markers get appended on the success/error replace).
- `Generate success comment` (line 1100) → `src/generate-success-comment.js` produces a full body containing prompt block, result title, screenshot/links, completion timestamp, and the trailing `STATUS_COMMENT_MARKER` + `RUNNER_ID_MARKER` + `SESSION_DATA_MARKER`. Output: `comment-body`, `session-data-map`.
- `Generate history comment` (line 1131) → `src/generate-history-comment.js` reads `${RUNNER_TEMP}/agent-sessions-${AGENT_ID}.json` (every session for this runner) plus the merged `SESSION_DATA_MAP`, and renders a single growing list, latest first, with the `HISTORY_COMMENT_MARKER` at the bottom. Only emitted on PRs.
- `Generate error comment` (line 1151) → `src/generate-error-comment.js`, similar shape to success comment but error-flavored.
- `Post or update status comment` (line 1180) — `peter-evans/create-or-update-comment@v5` with `edit-mode: replace`, targeting `find_comment.outputs.comment-id || create_comment.outputs.comment-id`.
- `Post or update history comment` (line 1196) — same pattern, PR-only, targeting `find_history_comment.outputs.comment-id`.
- `Cross-post to PR and update issue` (line 1213) → `src/cross-post-to-pr.js` posts both bodies as new comments on the PR that the agent created, and injects a redirect note into the issue's status comment.
- `Fallback status update` (line 1236) — last-resort safety net that overwrites the status comment with a minimal failure note when both generators failed.

State markers, defined in `src/comment-markers.js`:

- `STATUS_COMMENT_MARKER` (`<!-- netlify-agent-run-status -->`) — find-comment selector.
- `HISTORY_COMMENT_MARKER` (`<!-- netlify-agent-run-history -->`) — find-history-comment selector.
- `RUNNER_ID_MARKER_PREFIX` + `MARKER_SUFFIX` — encodes the validated runner id.
- `SESSION_DATA_MARKER_PREFIX` + `MARKER_SUFFIX` — encodes the sanitized session-data map (URL allowlist, SHA format, length cap).
- `ALLOWED_MARKER_INNER` — regex listing the four marker shapes the read-side scrubber preserves; everything else is stripped from untrusted bodies.

Important constraints (carry-overs from PR #17 that any new design must respect):

- Only bot-authored comments with the status marker contribute to state recovery. Any new comment kind that is *not* part of state recovery must therefore not carry the status marker.
- Any new marker shape that the action wants to read back later must be added to `ALLOWED_MARKER_INNER`, otherwise `stripUntrustedHtmlComments` will erase it on read paths.
- User-authored content embedded into bot comments must continue to flow through `stripAllHtmlComments` so it cannot reflect marker-shaped strings.
- URL/SHA fields decoded from markers must continue to round-trip through `sanitizeSessionEntry`.

## Goals

1. Each agent run produces a new, immutable, bot-authored comment on the issue/PR thread containing the full result narrative. Subsequent runs do not destroy or alter prior result comments.
2. The sticky status comment continues to exist as a single mutable comment, but its visible body is short (target ≤ 1000 characters before trailing markers) and includes a stable hyperlink to the latest result comment.
3. State recovery (`extract-agent-id` → `reconcileAgentState`) keeps reading from the status comment only, with no behavior change in `find-comment` selection or in marker parsing rules.
4. Long-running threads do not hit GitHub's 65,536-character per-comment limit. The limit becomes a per-run concern, not a per-thread concern.
5. The current `HISTORY_COMMENT_MARKER` either disappears cleanly or is repurposed as a small, lightweight table-of-contents pointing at the new result comments — never as a growing log.
6. Cross-posting from issue to a created PR continues to land both an initial status comment and a first-run result comment on the PR, while leaving the issue thread with both its (redirect-noted) status comment and its first-run result comment for posterity.
7. Failure paths (agent error, preflight failure, both generators failing) continue to produce the right shape of comment(s); preflight failures specifically do not produce a result comment because there is no run to record.

## Non-Goals

- Re-architecting the find-comment / state-reconciliation pipeline. Those layers stay as they are; only the inputs they read from change shape.
- Editing or deleting historical comments authored before this change ships. We accept that pre-rollout threads will look mixed for one transitional cycle.
- Compressing or rewriting the Netlify-dashboard-side history. The dashboard remains the canonical source of truth.
- Adding any new GitHub permissions. The bot already has `issues: write` and `pull-requests: write`; the new comments use the same scopes.
- Renaming the existing markers or breaking the action's input/output contract.

## Design — Two-Comment Lifecycle

### Comment kinds and markers

| Kind | Mutability | Count per thread | Markers carried | Found by |
|---|---|---|---|---|
| Status comment | mutable, edit-in-place | 1 | `STATUS_COMMENT_MARKER`, `RUNNER_ID_MARKER`, `SESSION_DATA_MARKER` | `find-comment` (existing) |
| Result comment | immutable, append-only | N (one per Netlify session run) | `RESULT_COMMENT_MARKER` (new) only | `find-result-comments` (new, optional) |
| History TOC comment | mutable, edit-in-place | 0 or 1 | `HISTORY_COMMENT_MARKER` (existing) | `find-history-comment` (existing) |

The new `RESULT_COMMENT_MARKER` shape is `<!-- netlify-agent-run-result:<runner-id>:<session-id> -->`, where both id segments must satisfy `RUNNER_ID_FORMAT` (`/^[A-Za-z0-9_-]{1,128}$/`) at parse time. The runner-id segment is what lets a future renderer (or the history TOC) group result comments by run; the session-id segment disambiguates multiple sessions inside one run. `generate-result-comment.js` gets the runner id from `AGENT_ID` and gets the session id from the latest session in `${RUNNER_TEMP}/agent-sessions-${AGENT_ID}.json`. Result comments are only emitted when both identifiers are available. Preflight failures and setup failures that never create a Netlify session remain status-comment-only.

The marker is added to `ALLOWED_MARKER_INNER` so `stripUntrustedHtmlComments` preserves it on read paths. Read code that parses the marker validates both id segments against `RUNNER_ID_FORMAT` before trusting them. Critically, the marker carries no consumable state — it is purely an identifier — and result-body rendering must prove that no status/history/runner/session markers can appear anywhere in the body before appending this marker.

### Status comment: truncated, hyperlinked, mutable

The status comment continues to be the single canonical entry point for "what's the current state." Its visible body is reorganized around a hard ≤ 1000-character soft cap (excluding trailing state markers, which add roughly 200–400 bytes of HTML comments and do not count against the user-facing budget).

Required content, in order:

1. Header line: `### [Netlify Agent Run completed](agent-run-url) ✅` (or the dry-run / error variant).
2. One-line subtitle with run number, model, and timestamp: `Run #N • codex • completed at YYYY-MM-DDTHH:MM:SSZ`.
3. Optional inline screenshot (right-aligned, width 180–250).
4. Optional one-line title from `agent-title` (truncated at sentence boundary if too long).
5. Compact pipe-separated link row: `Open Preview • Agent run • Code Changes • Action logs`.
6. **Hyperlink to the latest result comment**: `[Read full result ↳](#issuecomment-<id>)`.
7. (Issue → PR redirect case only) the existing redirect note pointing at the new PR.
8. Trailing markers: `SESSION_DATA_MARKER`, `RUNNER_ID_MARKER`, `STATUS_COMMENT_MARKER`.

Removed from the status comment (moved to the result comment):

- The full prompt block.
- The `agent-result` prose summary.
- Any multi-paragraph file-change breakdown.

The truncation contract (see "Truncation contract" below) handles the case where required content unexpectedly overflows; the explicit goal is that under normal inputs the status comment never needs textual truncation, only structural simplification.

### Per-run result comment: full, immutable

The result comment carries the full narrative for one agent run. It is created fresh (`github.rest.issues.createComment`) every run and is never edited after creation.

Body shape, in order:

1. Header: `### Run #N • codex • Agent Run completed ✅` (or error variant), with the `agent-run-url` link.
2. Full prompt block, rendered through `formatPromptBlock` (which already calls `stripAllHtmlComments` on user input).
3. `### Result: <agent-title>` heading, falling back to `### Result` when title is empty.
4. Inline screenshot (right-aligned), if present.
5. Full `agent-result` prose summary.
6. Compact link row: `Open Preview • Agent run • Code Changes • Action logs`.
7. (Failure case) full classified failure narrative from `failure-taxonomy`, with the same character cap (`MAX_ERROR_LENGTH = 500`) currently enforced in `generate-error-comment.js`.
8. `*Completed at <ISO timestamp>*` line.
9. Trailing `RESULT_COMMENT_MARKER` only — no state markers, no status marker, no history marker.

Result comments are subject to GitHub's 65,536-character cap per individual comment. This is far larger than any realistic single-run output, but the renderer should still apply `MAX_RESULT_BODY_LENGTH` (suggested 60,000) with a "result truncated; see Netlify dashboard" tail.

Success runs normally have a latest Netlify session and therefore produce a result comment. Mid-run failures produce a result comment only if the session file contains a latest session id; failures before session creation do not have a stable result marker and stay status-comment-only.

### History comment: keep as a small TOC, lose the growing log

The current `generate-history-comment.js` renders the full per-run narrative for every session in a single comment. That is the part this plan deletes — the per-run narrative now lives in dedicated thread comments.

Two viable options:

- **Option A: drop the history comment entirely.** Reviewers scroll the timeline. Simple, but a 30-run PR becomes annoying to navigate.
- **Option B: repurpose as a TOC.** The history comment is regenerated each run as a short index linking to each result comment by `#issuecomment-<id>` anchor, plus the run number, model, status emoji, and timestamp. ~30 bytes per row × 50 runs ≈ 1.5 KB; very far from the 65 KB cap and useful for triage.

This plan recommends Option B. The TOC retains the existing `HISTORY_COMMENT_MARKER` (so `find-history-comment` keeps working) but the body is simply a markdown list. PR-only, same as today. Issues with linked PRs continue to redirect via the cross-post path.

The TOC is emitted even when it has one result row. A one-row TOC is slightly redundant, but it keeps the PR shape consistent from the first run, simplifies cross-posting, and makes the issue-to-PR handoff test deterministic.

The TOC needs to know the issuecomment id of every result comment posted so far. Since result comments are immutable and only ever appended, the TOC can be regenerated by listing comments via `github.rest.issues.listComments` (or by paging through the existing comment list once and filtering on `RESULT_COMMENT_MARKER`). This avoids needing to persist a separate manifest. The list is bot-author-filtered to prevent a non-bot author from injecting a fake row.

### Ordering and idempotency

Within one run, the comment-write sequence must satisfy: status body needs to know the result comment id to link to, so the result comment must be posted first. That gives:

1. Generate the **result body** (full).
2. Generate the **status skeleton** with a placeholder for the result comment id.
3. **Post the result comment** via `github.rest.issues.createComment`. Capture `comment.id`.
4. Patch the status skeleton: replace the placeholder with `[Read full result ↳](https://github.com/<owner>/<repo>/issues/<issue>#issuecomment-<id>)`.
5. **Update or create the status comment** via `peter-evans/create-or-update-comment@v5` (existing logic, replace mode).
6. (PR only) Regenerate the **history TOC** by listing existing result comments after the new result comment exists, and update or create the history comment.

Steps 1 and 2 can run in parallel; 3–5 are sequential by data dependency. Step 6 happens after 3 because the new result comment id must be visible to the TOC generator.

Idempotency considerations:

- If step 3 succeeds but step 5 fails partway, the next run's `extract-agent-id` reads the *previous* status comment (still containing prior runner-id markers), reconciles correctly, and the next run's status update overwrites with the latest result link. The orphan result comment from the failed run remains in the thread — which is the desired outcome, not a leak. The fallback-status-update step in the existing pipeline still applies.
- If step 3 fails (createComment 5xx), the run reverts to single-status-comment behavior for that run only: the status update happens with the result body inlined (or with a "result comment failed to post" notice). This degraded mode is detectable in the step summary.
- Re-running the same workflow run is not a real-world flow, but if it happens we accept duplicate result comments. The runner-id and session-id pair in the result marker makes them detectable, and a future cleanup tool can dedupe.

## State Recovery Preservation (PR #17 Invariants)

The hardening shipped in PR #17 must continue to hold:

1. **Bot-author filter on `find-comment` is sufficient.** Result comments are bot-authored too, but they do not carry `STATUS_COMMENT_MARKER`. The `body-includes` filter on `find-comment` therefore excludes them from state-recovery selection. Verified by adding a fixtures test that injects a result comment with bot authorship and confirms `find-comment` still resolves to the status comment.

2. **`extract-agent-id` reads only from status / PR-body sources.** No new code paths feed `reconcileAgentState`. Result comments are *not* a state source.

3. **`stripUntrustedHtmlComments` preserves only allowlisted markers.** `RESULT_COMMENT_MARKER`'s prefix is added to `ALLOWED_MARKER_INNER`. The marker contains only validated id segments and no URL or SHA fields, so the `SESSION_URL_ALLOWLIST` / `COMMIT_SHA_FORMAT` machinery does not need to expand.

4. **All user- and agent-authored prose is scrubbed before it is embedded in bot comments.** Result comment bodies embed user prompts via `formatPromptBlock`; that function already calls `stripAllHtmlComments`. The same standard must apply to agent result prose, titles, and failure narratives before they enter either status or result comments. After rendering and before appending `RESULT_COMMENT_MARKER`, the result renderer performs a final marker assertion: the body must not contain `STATUS_COMMENT_MARKER`, `HISTORY_COMMENT_MARKER`, `RUNNER_ID_MARKER_PREFIX`, or `SESSION_DATA_MARKER_PREFIX`.

5. **Fork-PR PR-body fallback in `extract-agent-id` is unchanged.** Result comments are never read by extract-agent-id, so there is no new fork-PR concern.

The plan adds two new tests that explicitly assert these invariants:

- A poisoned non-bot comment carrying `RESULT_COMMENT_MARKER` plus a fake runner-id marker still has its runner-id marker scrubbed by `stripUntrustedHtmlComments` and is ignored by `find-comment`.
- A malicious trigger/agent result containing marker-shaped text cannot make a bot-authored result comment contain `STATUS_COMMENT_MARKER`, `HISTORY_COMMENT_MARKER`, `RUNNER_ID_MARKER_PREFIX`, or `SESSION_DATA_MARKER_PREFIX`. This test is load-bearing: because `find-comment` selects the last bot-authored comment with `STATUS_COMMENT_MARKER`, a reflected status marker in a newer result comment would otherwise be eligible for state recovery.

## Truncation Contract

The status comment has a soft 1000-character user-visible cap, but the right primitive is "render the structured fields, then if total user-visible bytes exceed the cap, drop or truncate optional fields in a defined order." The renderer never silently chops in the middle of a markdown link or a state marker.

### Render order

1. (Always emit) Header link line.
2. (Always emit) Run number / model / timestamp subtitle.
3. (Always emit) `[Read full result ↳](#issuecomment-<id>)` — this is the entire point.
4. (Always emit) Trailing markers (state markers and status marker).
5. (Required when applicable) Redirect note for issue → PR handoff.
6. Compact pipe-separated link row.
7. `agent-title` line.
8. Inline screenshot.

### Drop order

When the visible body exceeds the budget, remove or truncate optional fields in this order:

1. Inline screenshot.
2. `agent-title` line.
3. Compact pipe-separated link row.

The header, subtitle, result link, redirect note when applicable, and trailing markers are required. If required visible fields alone exceed the budget, truncate only the longest required prose field at a boundary; never remove the result link or markers.

Algorithm:

```
budget = 1000
emit required fields plus optional fields in render order, accumulating user-visible bytes
if next field would exceed budget:
  - if field is optional, skip it and continue
  - else truncate the longest required prose field at a sentence/paragraph boundary, append "…", and stop
emit trailing markers
```

Smart truncation: at a paragraph break (`\n\n`) → at a sentence break (`. `) → at a word break (` `) → byte-level last resort. Never cut inside a markdown link `[…](…)` or a code fence.

### Why 1000 characters

- GitHub's web UI renders ~1000 characters as roughly 6–10 visual lines on a wide screen, which is glanceable without scrolling inside the comment.
- Notification email previews truncate at a similar size, so reviewers receive a useful summary in their inbox.
- Leaves headroom for the result link and the trailing markers without bumping into the 65,536-character hard cap.

This cap is configurable via a private constant `STATUS_COMMENT_VISIBLE_BYTES = 1000`; making it a public action input is out of scope for this plan but trivial later.

### Where the truncation logic lives

A new module `src/comment-truncation.js` exports:

- `truncateAtBoundary(text, maxBytes)` — boundary-aware truncation.
- `assembleStatusBody({ header, subtitle, screenshot, title, links, redirectNote, resultCommentLink, markers, budget })` — the ordered status-body renderer.
- Constants: `STATUS_COMMENT_VISIBLE_BYTES`, `MAX_RESULT_BODY_LENGTH`.

Both `generate-success-comment.js` and `generate-error-comment.js` consume `assembleStatusBody`. The full-result rendering moves into a sibling pair: `src/generate-result-comment.js` (success and failure variants share the file, mirroring how `generate-error-comment.js` handles flavors today).

## Implementation Breakdown

### New modules

- **`src/comment-truncation.js`** — boundary-aware truncation, ordered status body assembly, shared constants.
- **`src/generate-result-comment.js`** — full per-run body for both success and failure outcomes. Replaces the body-rendering portion currently inside `generate-success-comment.js` and `generate-error-comment.js`. Sets outputs `result-body`, `result-marker`, `session-data-map` (success only — failure path emits an empty session-data update).
- **`src/post-result-comment.js`** — `github-script` callee that calls `github.rest.issues.createComment` with `result-body`, captures the new comment id, and sets `result-comment-id` and `result-comment-url`.
- **`src/generate-status-comment.js`** — assembles the truncated status body using `comment-truncation`, taking `result-comment-id` as a required input. Emits `status-body` and the merged `session-data-map` carried in the trailing markers.
- **`src/generate-history-toc.js`** — replaces `generate-history-comment.js`. Lists bot-authored thread comments via `github.rest.issues.listComments`, filters by `RESULT_COMMENT_MARKER`, validates the runner-id and session-id segments per row, renders a compact bulleted TOC. Reuses the existing `HISTORY_COMMENT_MARKER`.

### Modified modules

- **`src/comment-markers.js`**
  - Add `RESULT_COMMENT_MARKER_PREFIX` (`'<!-- netlify-agent-run-result:'`).
  - Add `renderResultCommentMarker({ runnerId, sessionId })` and `parseResultCommentIdentifiers(body)` helpers, both validating against `RUNNER_ID_FORMAT`.
  - Extend `ALLOWED_MARKER_INNER` regex to include `netlify-agent-run-result:`.
  - Export new symbols.
- **`src/generate-success-comment.js`** — refactor to call `generate-result-comment` for the full body and `generate-status-comment` for the truncated body. Sets two new outputs: `result-body`, `status-body` (alongside the existing `comment-body` for one transitional cycle, marked deprecated in a comment).
- **`src/generate-error-comment.js`** — same refactor as success.
- **`src/cross-post-to-pr.js`** — post a PR-local result comment first, then build and post a PR-local status comment that links to that PR result comment, then build/update the PR history TOC by listing comments on the PR number. The issue's status comment is updated only to add the redirect note; its existing result link remains pointed at the issue-local result comment.
- **`src/format-comment.js`** — no change to the `in-progress` and `clean-prompt` commands. The in-progress comment remains a simple status-shape comment with no result link (because there is no result yet); when the run completes, the in-progress comment is overwritten with the truncated status comment.
- **`src/extract-agent-id.js`** — no change. State recovery still reads only the status comment / PR body.

### action.yml step changes

The post-completion section (line 1098+) is rewritten as follows. Step names and `if:` guards are illustrative; existing wiring patterns (such as `continue-on-error: true` on every comment-emitting step) are preserved.

```
# 15. Generate bodies
- Generate result body          → outputs: result-body, result-marker, session-data-map
- Generate status skeleton      → outputs: status-skeleton (placeholder for result link)

# 16. Post comments
- Post result comment           → captures result-comment-id, result-comment-url
- Patch status body             → injects result-comment-url into status-skeleton
- Post or update status comment → existing peter-evans step, body now from patched skeleton
- Generate history TOC          → (PR only) lists result comments after the new result exists
- Post or update history TOC    → (PR only) existing peter-evans step, body now a TOC
- Cross-post to PR              → adapted to post both status + result on the new PR
- Fallback status update        → existing safety net, unchanged
```

Step ordering details:

- The "Find existing status comment" and "Find existing history comment" steps stay where they are. Both remain bot-authored + body-includes filtered. Neither needs to know about result comments.
- The "Create initial status comment" step (in-progress placeholder) stays where it is. On the *first* run there is no prior result comment yet, so the in-progress comment has no result link. The completion path posts the first result comment, then updates the in-progress comment in place to become the first real status comment.
- The history TOC generation/update steps live in the same conditional block as today for direct PR runs (PR-only, bot-author-filtered), but they run after `Post result comment`.
- Both new steps (`Post result comment`, `Patch status body`) get `continue-on-error: true`, matching the existing pipeline ethos that comment delivery should never fail the agent run.

### Cross-post adjustment

`src/cross-post-to-pr.js` becomes:

```
1. Post the issue's result comment in the main issue-scoped flow.
2. Update the issue's status comment in the main issue-scoped flow; its result link points at the issue result comment.
3. In `cross-post-to-pr.js`, post a separate first result comment on the PR.
4. Build the PR status body after the PR result comment id is known, so its result link points at the PR result comment.
5. Post the PR status comment.
6. Build/update the PR history TOC by listing comments on the PR number, not the original issue number.
7. Update the issue's status comment with the redirect note pointing to the PR, preserving the issue-local result link.
```

The PR's history TOC cannot be seeded by the main issue-scoped TOC step because that step lists comments on the original issue number. Cross-post owns the first PR TOC update. Later direct PR runs use the normal PR-scoped TOC path.

## Test Plan

Unit tests, added alongside existing patterns:

- `comment-truncation.test.js`
  - Smart truncation at paragraph / sentence / word / byte boundaries.
  - Never cuts inside a markdown link.
  - Priority-driven assembler emits required fields under tight budgets.
  - Status body always ends with markers regardless of truncation.
  - Result link and trailing markers are always present even when budget is exceeded.
- `generate-result-comment.test.js`
  - Success and failure variants render expected sections.
  - User-authored prompt content is scrubbed for embedded HTML comments.
  - Agent-authored title/result/error prose cannot reflect status/history/runner/session markers into the final body.
  - `RESULT_COMMENT_MARKER` is present and contains validated runner-id + session-id segments.
  - No `STATUS_COMMENT_MARKER`, no `HISTORY_COMMENT_MARKER`, no `RUNNER_ID_MARKER`, no `SESSION_DATA_MARKER` present.
- `generate-status-comment.test.js`
  - Result comment link is injected when `result-comment-id` is provided.
  - Status body fits within the 1000-byte visible budget for representative success and error inputs.
  - Trailing markers are present and pass `parseRunnerId` / `parseSessionData` round-trip.
- `generate-history-toc.test.js`
  - TOC enumerates only bot-authored, marker-bearing comments.
  - Non-bot comments carrying a fake `RESULT_COMMENT_MARKER` are excluded.
  - Run order is chronological (oldest first or newest first — confirm UX preference; recommendation: newest first for parity with current behavior).
  - Each row links to the correct `#issuecomment-<id>` anchor.
- `comment-markers.test.js` (extend)
  - `RESULT_COMMENT_MARKER` round-trips through `renderResultCommentMarker` / `parseResultCommentIdentifiers`.
  - Invalid runner-id or session-id segments are rejected at parse time.
  - `stripUntrustedHtmlComments` preserves the new marker shape.

Integration tests via `scenario-harness`:

- `scenario-three-runs-on-pr` — three sequential triggers on the same PR. Asserts: one status comment exists at the end (replaced twice), three result comments exist (chronological, immutable), one history TOC comment exists with three rows linking to the three result comments.
- `scenario-issue-to-pr-handoff` — issue trigger creates a PR. Asserts: issue thread has a status comment (with redirect note) plus a first-result comment; PR thread has its own status comment (linking to the PR's first-result comment) plus a first-result comment; PR's history TOC has one row.
- `scenario-state-recovery-with-result-comments` — second run on a thread that already has one status comment and one result comment from a prior run. Asserts: `extract-agent-id` recovers the prior runner-id from the status comment only, ignoring the result comment.
- `scenario-poisoned-result-comment` — non-bot comment in the thread carrying a fake `RESULT_COMMENT_MARKER` and fake state markers. Asserts: state recovery is unaffected; history TOC excludes the fake row.

End-to-end via the existing dogfood workflow: run the new comment lifecycle on this repo's own canary PRs before tagging/releasing the action ref that consumers use.

## Backwards Compatibility & Migration

Action consumers pinned to `@v1` see a behavior change but no contract change:

- No new required inputs.
- All existing outputs continue to be emitted. New outputs (`result-body`, `result-comment-id`, `result-comment-url`) are additive.
- Existing markers continue to work and continue to be emitted on the status comment.
- Pre-rollout threads: prior status comments remain in place, prior history comments remain in place. The first post-rollout run on those threads will:
  - Create a new result comment (no orphan; the prior single-status-comment behavior is what was "broken" for the user).
  - Update the prior status comment in place to the new truncated shape (existing comment id reuse via `find-comment`).
  - On PRs, replace the prior growing-history comment with the TOC body (existing comment id reuse via `find-history-comment`). The growing log is overwritten — losing the inline narrative content, but that content was never a durable source of truth, only a visual aggregator. Reviewers wanting the prior content can read it in the Netlify dashboard.

Rollout order: ship the behavior directly on the development branch, dogfood on canary, then tag/release the action ref that consumers use. There is no feature flag; the action always appends full result comments once this change ships.

Optional one-time backfill: a script that walks recent threads, reads each prior status comment's session list, and posts retroactive result comments. GitHub comments cannot be backdated, so these would appear at backfill time rather than at the original run time. This is genuinely optional and probably not worth the complexity; mention only as a possibility.

## Resolved Decisions

1. **History TOC order:** newest-first, matching the current history comment and keeping the most recent run easiest to find.
2. **Status screenshot:** keep the inline screenshot when the visible budget allows it; drop it before required fields if the status comment would exceed budget.
3. **Result comment marker:** include both runner-id and session-id. The runner id groups result comments by agent run; the session id identifies the exact Netlify session.
4. **Failure result comments:** preflight/setup failures without a session are status-comment-only. Mid-run failures with a validated runner-id and latest session-id produce a result comment.
5. **TOC threshold:** always emit the PR TOC once result comments are enabled, including a one-row TOC on the first PR run.
6. **Feature flag:** no feature flag. The action always appends full result comments to threads after this change ships.
7. **Notification volume:** every run posts a new comment, which means subscribers get a fresh notification per run. This is the design intent; revisit only if dogfood feedback shows excessive churn.

## Sequencing & Single-PR Work Plan

This should land as one implementation PR. The bullets below are the internal order of work inside that PR, not separate PRs:

- **Markers and truncation primitives.** Add `RESULT_COMMENT_MARKER` to `comment-markers.js`, add `comment-truncation.js`, and cover both with unit tests.
- **Split renderers.** Introduce `generate-result-comment.js` and `generate-status-comment.js`. Refactor `generate-success-comment.js` and `generate-error-comment.js` to delegate to them and emit `result-body` / `status-body`.
- **Wire the two-comment lifecycle.** Add action.yml steps for `Post result comment`, `Patch status body`, status update, direct-PR history TOC generation/update, and fallback behavior. These steps always run when comments are expected and a result body exists.
- **Cross-post issue-created PRs.** Update `cross-post-to-pr.js` so issue-created runs post PR-local result/status/TOC comments while preserving the issue-local result link and adding only the redirect note to the issue status comment.
- **Clean up docs and contracts.** Replace the growing history renderer with `generate-history-toc.js`, keep existing action outputs additive for compatibility, and update SECURITY.md plus user-facing docs that describe the comment lifecycle.
- **Verify the whole flow.** Add/adjust unit tests and scenario-harness coverage, then dogfood the single PR on canary before tagging/releasing the action ref consumers use.

The single PR should still be organized as reviewable commits if useful, but the behavior should not be split across multiple pull requests.

## Risks

- **Notification fatigue.** Each run produces a new comment; subscribers get a fresh notification each time. Mitigated by clear, scannable result-comment headers (run number + model + status emoji) so the notification preview is itself useful.
- **Status comment stale-link race.** If the status update fails after the result comment is posted, the status comment links to the previous run's result comment, which is now stale-relative-to-the-latest-narrative. Detectable via the runner-id mismatch between status marker and result marker; the next run heals it. Acceptable.
- **TOC drift.** If a result comment is manually deleted by a maintainer, the TOC's next regeneration silently drops the row, which is fine. If a TOC row points at a deleted comment, GitHub renders the link as a 404; we accept this as expected behavior rather than building TOC self-healing.
- **65,536-character ceiling on long single runs.** Result comments still inherit GitHub's per-comment cap. Result-body truncation at `MAX_RESULT_BODY_LENGTH = 60000` with a "see Netlify dashboard" tail covers the worst case.
- **State-recovery regression.** Most of the risk surface for this change is in the find-comment / state-reconciliation pipeline. The new tests in "State Recovery Preservation" are explicitly designed to catch any regression there. PR #17's invariants are the load-bearing constraint and any reviewer should verify them line by line.
- **Migration on long pre-rollout threads.** The first post-rollout run loses the prior growing-history comment's inline content. Acceptable because that content was never the durable source of truth, but worth flagging in the release note.

## Done When

- The single implementation PR lands with the full comment lifecycle, tests, docs, and release verification complete.
- Three sequential `@netlify` triggers on the canary PR produce: one updated status comment, three thread-level result comments, one history TOC comment with three rows.
- `extract-agent-id` continues to recover the correct runner-id and session-data on the second and third triggers.
- Step summary on each run links to both the status comment and the new result comment.
- A poisoned non-bot comment carrying a fake result marker does not affect state recovery, verified by an explicit scenario-harness test.
- Release notes call out the comment-lifecycle change and the dropped growing-history comment.
