# Netlify Agent Runners Hardening Plan

Status: draft plan  
Scope: ideas 1, 4, 5, 6, 7, 8, 9, and 11 from the idea-wizard pass  
Canonical consumer slug: `netlify-labs/agent-runner-action@v1`

## Purpose

This plan describes a reliability and operator-experience hardening pass for the Netlify Agent Runners GitHub Action. The action already provides the core user workflow: a GitHub user mentions `@netlify` in an issue, pull request, review, review comment, issue comment, or manual dispatch; the action extracts context, starts or resumes an agent run, updates status comments, and optionally creates or updates a pull request.

The next layer of value is not another flashy feature. It is making the action easier to trust, debug, test, and support. The selected ideas all point in the same direction:

- Deterministic scenario coverage for the GitHub event matrix.
- Robust reconstruction of existing runner/session state.
- A safe preflight path for setup validation.
- A local simulator that shows maintainers what the action would do.
- Automated checks to keep docs, templates, and action metadata aligned.
- Consistent use of the current canonical slug, `netlify-labs/agent-runner-action@v1`.
- Better failure classification and user-facing remediation.
- A structured GitHub Actions step summary for every meaningful run.

This plan intentionally does not create beads and does not pick a single work item for implementation. The sequencing below is dependency-aware, but the user can choose any slice to start with.

## Current Ground Truth

The action is a composite GitHub Action defined in `action.yml`.

Important current modules:

- `src/check-trigger.js` decides whether a GitHub event should activate the action.
- `src/get-context.js` extracts issue/PR refs, model, prompt text, dry-run state, linked PR hints, and source URLs.
- `src/utils.js` owns trigger matching, model extraction, prompt cleanup, date formatting, and in-progress comment rendering.
- `src/extract-agent-id.js` parses sticky status comments or PR bodies to recover runner/session metadata.
- `src/generate-success-comment.js` renders the completed status comment.
- `src/generate-error-comment.js` renders failure comments.
- `src/generate-history-comment.js` renders PR run history.
- `src/cross-post-to-pr.js` copies status/history from issue-created runs onto the created PR.
- `src/format-comment.js` is a small CLI helper for comment generation from the shell step.

Important current tests:

- `src/check-trigger.test.js` covers event trigger and permission decisions.
- `src/get-context.test.js` covers context extraction.
- `src/utils.test.js` covers trigger/model/prompt/comment helpers.
- `src/action-wiring.test.js` validates some `action.yml` references and required metadata.

Important current docs/templates:

- `README.md` contains setup, trigger, input/output, and security documentation.
- `docs/index.html` is a static docs page.
- `example-workflow.yml` is a consumer workflow example.
- `workflow-templates/netlify-agents.yml` is the workflow template.
- `workflow-templates/netlify-agents.properties.json` is template metadata.

Important current constraints:

- The action runs in GitHub Actions and must preserve the current default behavior for existing users.
- The canonical consumer slug for this plan is `netlify-labs/agent-runner-action@v1`.
- The action currently relies on Bun, Netlify CLI, GitHub CLI, `jq`, and GitHub APIs.
- A lot of orchestration still lives inline in `action.yml` Bash. This plan does not require a full runner rewrite, but it should extract pure parsing/rendering/decision logic into testable modules where that directly supports the selected ideas.
- `dry-run` currently means "start an agent run but skip PR creation and commits." It is not the same as "do not contact Netlify."

## Goals

1. Make the event and state behavior deterministic enough to test locally.
2. Reduce support burden by producing actionable diagnostics for setup errors, API errors, permission errors, timeouts, and PR creation failures.
3. Make docs and workflow examples mechanically consistent with `action.yml`.
4. Give maintainers a local simulator for fast feedback without invoking GitHub Actions or Netlify.
5. Preserve current public defaults and avoid surprising existing users.
6. Keep all new behavior testable with Bun/node:test and fixture-driven scenario tests.

## Non-Goals

- Do not redesign the entire action architecture in this pass.
- Do not replace the Netlify CLI integration wholesale.
- Do not change the canonical slug away from `netlify-labs/agent-runner-action@v1`.
- Do not create beads as part of this plan.
- Do not require live Netlify API calls in normal CI tests.
- Do not make `dry-run` silently change semantics. If a no-external-run mode is needed, add a separate preflight-only mode.

## Design Principles

- Prefer pure modules for logic that needs tests: parsing, rendering, classification, reconciliation, fixture execution, and docs validation.
- Keep the composite action user-facing contract stable unless a new input is explicitly introduced.
- Treat GitHub comments as user interface and as durable state. Rendering and parsing must be tested together.
- Treat every failure as a product moment. The action should tell users what happened, what it tried, and what they can do next.
- Use fixture-driven tests for confidence, not live external services.
- Make local tools useful for maintainers without forcing them into CI-only workflows.

## Proposed Files And Modules

The exact file names can change during implementation, but this plan assumes the following modules.

`src/comment-markers.js`

Centralizes hidden comment markers and parser/render helpers:

- `STATUS_MARKER`
- `HISTORY_MARKER`
- `RUNNER_ID_MARKER_PREFIX`
- `SESSION_DATA_MARKER_PREFIX`
- `renderRunnerIdMarker(runnerId)`
- `parseRunnerId(body)`
- `renderSessionDataMarker(sessionDataMap)`
- `parseSessionData(body)`
- `parseLinkedPrReference(body)`

Why this matters: multiple modules currently render or parse hidden state independently. Centralization reduces the chance that a comment copy edit breaks follow-up runs.

`src/state-reconciliation.js`

Reconstructs the best known agent state from multiple sources:

- Existing sticky status comment body.
- PR body fallback.
- Issue timeline linked PR data already gathered by `get-context`.
- Environment outputs from earlier steps.
- Optional Netlify runner/session data if available in a fixture or later runtime hook.

It should return a structured object:

```js
{
  runnerId: '',
  sessionDataMap: {},
  linkedPrNumber: '',
  agentRunUrl: '',
  confidence: 'none' | 'low' | 'medium' | 'high',
  sources: [],
  warnings: [],
  recoveryAction: 'start-new-run' | 'resume-runner' | 'redirect-to-pr' | 'manual-review'
}
```

Why this matters: follow-up prompts and issue-to-PR handoff rely on durable state hidden in comments and PR bodies. Deleted comments, malformed markers, partial data, or doc-format changes should not cause duplicate or confusing runs.

`src/failure-taxonomy.js`

Classifies failures into stable categories:

- `missing-auth-token`
- `missing-site-id`
- `site-lookup-failed`
- `netlify-cli-missing`
- `netlify-cli-install-failed`
- `model-unavailable`
- `agent-create-failed`
- `session-create-failed`
- `agent-timeout`
- `agent-failed`
- `deploy-preview-unavailable`
- `commit-to-branch-failed`
- `pull-request-create-failed`
- `github-permission-denied`
- `github-api-failed`
- `malformed-api-response`
- `unknown`

It should return:

```js
{
  category: 'agent-timeout',
  title: 'Agent timed out before completion',
  summary: 'The agent run did not reach a terminal state before the configured timeout.',
  remediation: ['Try a smaller prompt', 'Increase timeout-minutes', 'Check the Netlify Agent Runners dashboard'],
  severity: 'error',
  retryable: true,
  userActionRequired: false
}
```

Why this matters: failure comments are more useful when they are specific. It also gives tests a stable contract and enables summary/reporting improvements.

`src/generate-step-summary.js`

Renders Markdown for `$GITHUB_STEP_SUMMARY`.

Expected sections:

- Run overview.
- Trigger context.
- Agent details.
- Outcome.
- Links.
- Failure classification and remediation if applicable.
- Preflight results if applicable.

Why this matters: many users debug from the GitHub Actions UI, not from issue comments. The step summary should be the concise operator console for the run.

`src/preflight.js`

Provides validation logic split into two layers:

- Static/local validation: required inputs, event context, model validity, timeout numeric validity, declared dependencies, action metadata expectations.
- External validation: Netlify site lookup, GitHub permission check where practical, CLI availability checks.

It should return:

```js
{
  ok: true,
  checks: [
    { id: 'netlify-auth-token', status: 'pass', message: 'Token input is present' },
    { id: 'netlify-site-id', status: 'pass', message: 'Site ID input is present' }
  ],
  warnings: [],
  failures: []
}
```

Why this matters: setup errors are common and expensive when the only way to discover them is to start a full action run.

`src/scenario-harness.js`

Runs deterministic local scenarios from fixtures without contacting GitHub or Netlify.

Responsibilities:

- Load a GitHub event fixture.
- Create mock `github`, `context`, and `core`.
- Run selected modules in sequence.
- Inject fake GitHub API responses.
- Inject fake Netlify API/CLI responses for parser-level tests.
- Return a structured trace of decisions, outputs, comments, warnings, and failure classifications.

Why this matters: the action has many event branches. A harness lets maintainers test the product behavior, not just isolated helper functions.

`src/simulate.js`

CLI wrapper around `scenario-harness`.

Example commands:

```bash
bun src/simulate.js --fixture fixtures/events/issue-opened.json
bun src/simulate.js --fixture fixtures/events/pr-comment-followup.json --state fixtures/state/status-comment-with-runner.json
bun src/simulate.js --fixture fixtures/events/workflow-dispatch.json --format markdown
```

Why this matters: maintainers need a fast way to answer "what would the action do?" without pushing a branch and waiting for Actions.

`src/check-docs-drift.js`

Parses action metadata and validates docs/templates.

Responsibilities:

- Parse `action.yml` inputs and outputs.
- Ensure README input/output tables include declared public inputs/outputs.
- Ensure examples use only declared inputs.
- Ensure all public examples use `netlify-labs/agent-runner-action@v1`.
- Ensure workflow templates contain required permissions, concurrency, and event coverage.
- Ensure docs site examples match the canonical slug and important defaults.

Why this matters: stale docs cause setup failures and erode trust. Drift should be caught by CI, not by users.

## Workstream A: Deterministic Action Scenario Harness

Selected idea: 1.

### User Problem

Maintainers currently have unit tests for specific helpers, but not a deterministic way to simulate a full user story. GitHub Actions behavior depends on event shape, comment bodies, permissions, linked PRs, and hidden comment markers. A change can pass unit tests while breaking an important real workflow.

### Plan

Create fixture-driven scenario tests that execute the action's decision modules with mocked GitHub and Netlify responses. The first version should not try to execute every shell command in `action.yml`. It should cover the high-value product decisions:

- Should the action run?
- What issue/PR context is extracted?
- What prompt is sent to the agent?
- Which model is selected?
- Is this a PR or issue run?
- Is dry-run detected?
- Is an existing runner recovered?
- Is a linked issue redirected to a PR?
- What comment body would be posted?
- What failure category would be reported?
- What step summary would be rendered?

### Fixtures

Create a fixture directory:

```text
fixtures/
  events/
    issue-opened-body-trigger.json
    issue-opened-title-trigger.json
    issue-comment-on-issue.json
    issue-comment-on-pr.json
    pull-request-target-body-trigger.json
    pull-request-review-comment.json
    pull-request-review.json
    workflow-dispatch.json
    fork-pr-untrusted.json
    bot-comment.json
  github/
    collaborator-admin.json
    collaborator-read.json
    timeline-no-linked-pr.json
    timeline-linked-pr.json
    existing-status-comment-with-runner.json
    existing-status-comment-malformed-session-data.json
    pr-body-with-runner-marker.json
  netlify/
    get-site-success.json
    get-site-failure-auth.json
    agent-create-success.json
    agent-create-model-unavailable.json
    agent-show-running.json
    agent-show-completed-with-diff.json
    agent-show-failed.json
    sessions-list-success.json
```

Fixtures should be intentionally small. They only need fields the current modules read.

### Scenario Contract

Each scenario should declare:

```json
{
  "name": "issue opened with body trigger creates new run context",
  "eventFixture": "fixtures/events/issue-opened-body-trigger.json",
  "githubFixtures": {
    "issues.listEventsForTimeline": "fixtures/github/timeline-no-linked-pr.json"
  },
  "env": {
    "DEFAULT_MODEL": "codex",
    "DRY_RUN": "false"
  },
  "expect": {
    "shouldRun": true,
    "isPr": false,
    "model": "codex",
    "issueNumber": "10",
    "recoveryAction": "start-new-run"
  }
}
```

The harness should return a trace that is easy to inspect when a test fails:

```js
{
  scenario: 'issue opened with body trigger creates new run context',
  outputs: {},
  logs: [],
  comments: [],
  state: {},
  summary: '',
  failures: []
}
```

### Tests

Add `src/scenario-harness.test.js`.

Required coverage:

- New issue trigger with title and body combinations.
- PR follow-up comment that recovers PR refs.
- Issue comment with linked PR that results in redirect behavior.
- Workflow dispatch with explicit model.
- Bot sender skipped.
- Untrusted fork PR skipped.
- Malformed comment marker does not throw.
- Missing session data produces warning and safe fallback.
- Model unavailable fixture maps to a failure taxonomy category.
- Timeout fixture maps to timeout category and step summary output.

### Success Criteria

- Maintainers can run `bun test` and see scenario-level failures with useful trace output.
- New scenarios require only JSON fixtures plus an expected result block.
- No live GitHub or Netlify calls are required.
- The harness can be reused by the simulator CLI.

## Workstream B: Session-State Reconciliation

Selected idea: 4.

### User Problem

Follow-up prompts depend on recovering the previous agent run ID. The current implementation parses a sticky status comment first and falls back to PR body markers. That is useful but fragile. If a comment is deleted, edited, partially rendered, or contains malformed session JSON, the action can lose continuity.

### Plan

Introduce a `state-reconciliation` module that owns the state reconstruction contract. Existing code can keep using GitHub APIs, but the interpretation of state should move into a pure module with tests.

### Reconciliation Inputs

The module should accept:

```js
{
  isPr: true,
  statusCommentBody: '',
  prBody: '',
  issueTimelineLinkedPrNumber: '',
  contextOutputs: {},
  siteName: '',
  existingRunnerIdOutput: '',
  existingSessionDataOutput: ''
}
```

### Reconciliation Behavior

The module should:

- Prefer a valid runner ID from the status comment.
- Fall back to a valid runner ID from the PR body.
- Preserve valid session data from the newest trusted source.
- Treat malformed session data as a warning, not a hard failure.
- Detect linked PR references from existing status body.
- Distinguish between "no prior state" and "state exists but is malformed."
- Return an explicit `recoveryAction`.

### Integration Points

`src/extract-agent-id.js` should become thinner:

- Fetch candidate comment/PR bodies using GitHub APIs.
- Call `reconcileAgentState`.
- Set outputs from the reconciliation result.
- Log warnings in a readable way.

`src/generate-success-comment.js`, `src/generate-history-comment.js`, and `src/cross-post-to-pr.js` should use centralized marker helpers from `src/comment-markers.js`.

### Tests

Add `src/state-reconciliation.test.js`.

Required cases:

- Empty state returns `start-new-run` with `confidence: none`.
- Valid status comment runner wins over PR body runner.
- PR body runner is used when status comment is missing.
- Malformed session JSON returns `{}` plus warning.
- Linked PR detected from "Changes in Pull Request #123".
- Linked PR detected from Markdown PR URL.
- Unknown marker formats do not throw.
- Agent run URL is reconstructed when site name and runner ID exist.

### Success Criteria

- Existing follow-up behavior is preserved.
- State parsing is testable without GitHub API calls.
- Comments can evolve without duplicating parser regexes across modules.
- The scenario harness can assert state decisions directly.

## Workstream C: Preflight Validation Mode

Selected idea: 5.

### User Problem

Users can misconfigure the action in several ways: missing token, wrong site ID, insufficient GitHub permissions, invalid model, too-low timeout, stale docs, or Netlify CLI install failure. Today many of those problems are discovered only after starting a full action run or reading raw logs.

### Plan

Add a preflight validation path that can run before the expensive agent step. This should include both always-on validation improvements and an optional preflight-only mode.

### Proposed Input

Add a new optional input:

```yaml
preflight-only:
  description: 'Validate setup and configuration without starting an agent run'
  required: false
  default: 'false'
```

This is intentionally separate from `dry-run`.

- `dry-run=true`: starts the agent but skips PR creation and commits.
- `preflight-only=true`: validates setup and exits before creating or resuming an agent run.

This separation avoids surprising existing users.

### Preflight Checks

Static checks:

- `netlify-auth-token` input is present.
- `netlify-site-id` input is present.
- `default-agent` is one of `claude`, `codex`, or `gemini`; `default-model` remains a compatibility alias.
- `timeout-minutes` is a positive integer.
- `github-token` input is present.
- Trigger context can be extracted.
- For event-based runs, `issue-number` is available when comments need to be posted.

Runtime checks:

- Bun is installed by setup step.
- Netlify CLI install/cache step succeeded.
- `netlify api getSite` can resolve the configured site.
- GitHub token can read the current repo.
- GitHub token has enough permissions for issue/PR comments where practical.

Optional warnings:

- `timeout-minutes` below a reasonable threshold.
- `allowed-users` configured but current actor not in list.
- Event type is enabled but trigger text is empty.
- `dry-run` and `preflight-only` both true; preflight should win and explain that no agent will run.

### Integration In `action.yml`

Add a preflight step after context extraction and before any agent creation. The preflight step should:

- Run validations.
- Set outputs such as `preflight-ok`, `preflight-summary`, and `preflight-json`.
- Generate a step summary section.
- If `preflight-only=true`, post or update a status comment with the preflight result and exit the rest of the action path safely.

Composite actions do not have a native "return early" primitive. The implementation should use step `if:` guards based on `steps.preflight.outputs.should-continue == 'true'`.

### Comment UX

For preflight-only success:

```markdown
### Netlify Agent Runners preflight passed

The action configuration looks valid. No agent was started because `preflight-only` is enabled.

Checks:
- Netlify token input present
- Site resolved: example-site
- GitHub token can access this repository
- Trigger context extracted

[GitHub Action logs](...)
<!-- netlify-agent-run-status -->
```

For preflight failure:

```markdown
### Netlify Agent Runners preflight failed

The action did not start an agent run because setup validation failed.

Failed checks:
- Missing `netlify-site-id`

How to fix:
- Add `NETLIFY_SITE_ID` in repository secrets.
- Pass it as `netlify-site-id: ${{ secrets.NETLIFY_SITE_ID }}`.

[GitHub Action logs](...)
<!-- netlify-agent-run-status -->
```

### Tests

Add `src/preflight.test.js`.

Required cases:

- Missing auth token fails with remediation.
- Missing site ID fails with remediation.
- Invalid model fails.
- Invalid timeout fails.
- Both `dry-run` and `preflight-only` true produces warning and does not continue to agent.
- Site lookup success produces pass.
- Site lookup failure maps to `site-lookup-failed`.
- Preflight result renders in step summary.

### Success Criteria

- Users can validate setup without starting an agent run.
- Setup failures produce specific, actionable comments and summaries.
- Existing default runs continue unless preflight fails.
- `dry-run` semantics remain unchanged.

## Workstream D: Local Simulator CLI

Selected idea: 6.

### User Problem

Maintainers currently need to mentally evaluate event payloads or push branches to see how the action behaves. That is slow and makes edge-case work harder than it needs to be.

### Plan

Build `src/simulate.js` as a local CLI backed by the scenario harness. It should answer "what would happen if this event triggered the action?" without GitHub Actions.

### CLI Behavior

Initial command shape:

```bash
bun src/simulate.js --fixture fixtures/events/issue-comment-on-pr.json
bun src/simulate.js --fixture fixtures/events/issue-comment-on-pr.json --state fixtures/github/existing-status-comment-with-runner.json
bun src/simulate.js --fixture fixtures/events/workflow-dispatch.json --format json
bun src/simulate.js --fixture fixtures/events/workflow-dispatch.json --format markdown
```

Proposed package scripts:

```json
{
  "scripts": {
    "simulate": "bun src/simulate.js",
    "test:scenarios": "bun test src/scenario-harness.test.js"
  }
}
```

### Output Modes

Default human output:

```text
Scenario: issue comment on PR
Decision: should run
Model: claude
Context: PR #42, head feat, base main
Runner: resume existing abc123 from status comment
Prompt:
  fix the mobile layout

Would update status comment with:
  Netlify Agent Runners...
```

JSON output:

```json
{
  "shouldRun": true,
  "model": "claude",
  "isPr": true,
  "issueNumber": "42",
  "recoveryAction": "resume-runner",
  "warnings": []
}
```

Markdown output:

- Useful for copying into issues or PRs when debugging.
- Can reuse the step summary renderer.

### Tests

Add `src/simulate.test.js`.

Required cases:

- CLI loads fixture and exits 0 on valid scenario.
- CLI exits non-zero on missing fixture.
- `--format json` emits parseable JSON.
- `--format markdown` includes scenario name and decision.
- CLI includes warnings from state reconciliation.

### Success Criteria

- A maintainer can inspect event behavior locally in seconds.
- The simulator and scenario tests share the same harness.
- The CLI does not require network access.

## Workstream E: Docs And Template Drift Checker

Selected ideas: 7 and 8.

### User Problem

Docs, workflow templates, and action metadata can drift. A user copying an outdated slug or missing input gets a broken setup. The current canonical slug is `netlify-labs/agent-runner-action@v1`, and all examples should say that.

### Plan

Add an automated docs drift checker and clean up existing docs/templates so they agree on public API and canonical install path.

### Canonical Slug Rule

Every public consumer example should use:

```yaml
- uses: netlify-labs/agent-runner-action@v1
```

Known places to validate:

- `README.md`
- `docs/index.html`
- `example-workflow.yml`
- `workflow-templates/netlify-agents.yml`

The checker should fail if it finds:

- `netlify/agent-runner@v1`
- `netlify/agent-runner-action@v1`
- Any other action slug in a consumer example for this action unless explicitly allowlisted.

### Metadata Drift Checks

Parse `action.yml` and validate:

- Every declared input appears in the README input table, or is explicitly marked internal/undocumented.
- Every declared output appears in the README output table, or is explicitly marked internal/undocumented.
- Workflow examples use only declared inputs.
- Required secrets are described consistently.
- Default agent is documented consistently.
- `dry-run`, `netlify-cli-version`, `timezone`, and the proposed `preflight-only` input are documented.
- The docs site includes the canonical slug.
- Workflow templates include required permissions: `contents: write`, `pull-requests: write`, `issues: write`.
- Workflow templates include the concurrency group.

### Implementation Approach

Start with a pragmatic parser rather than a full Markdown AST:

- Use a small YAML parser if already available, or a lightweight metadata extractor similar to current `action-wiring.test.js`.
- For README tables, parse lines between `## Inputs` and `## Outputs`.
- For docs HTML, use string checks for canonical snippets and input names.
- Keep allowlists explicit in the checker.

Potential script:

```bash
bun src/check-docs-drift.js
```

Potential package script:

```json
{
  "scripts": {
    "docs:check": "bun src/check-docs-drift.js"
  }
}
```

CI should run:

```yaml
- run: bun src/check-docs-drift.js
```

### Tests

Add `src/check-docs-drift.test.js`.

Required cases:

- Detects wrong action slug.
- Detects missing input documentation.
- Detects missing output documentation.
- Allows explicitly ignored internal fields if needed.
- Detects workflow template missing required permissions.
- Passes current docs after cleanup.

### Success Criteria

- Public docs consistently use `netlify-labs/agent-runner-action@v1`.
- Adding or removing an action input/output requires docs updates.
- CI catches common copy/paste drift before release.

## Workstream F: Richer Failure Taxonomy

Selected idea: 9.

### User Problem

When the action fails, users need to know whether they made a setup mistake, Netlify had a temporary issue, the chosen model is unavailable, a PR could not be created, or the agent timed out. Generic failure output forces users to inspect logs and guess.

### Plan

Create a failure taxonomy module and route all error comments and step summaries through it.

### Classification Inputs

The classifier should accept:

```js
{
  stage: 'validate-env' | 'resolve-site' | 'create-agent' | 'create-session' | 'poll-agent' | 'commit' | 'create-pr' | 'comment-update',
  exitCode: 1,
  stderr: '',
  stdout: '',
  state: '',
  errorMessage: '',
  timeoutSeconds: 600,
  model: 'codex'
}
```

### Categories And Remediation

`missing-auth-token`

- Trigger: empty token input or explicit missing token error.
- User message: add `NETLIFY_AUTH_TOKEN` repository secret and pass it to `netlify-auth-token`.
- Retryable: false until user fixes setup.

`missing-site-id`

- Trigger: empty site ID input.
- User message: add `NETLIFY_SITE_ID` repository secret and pass it to `netlify-site-id`.
- Retryable: false until user fixes setup.

`site-lookup-failed`

- Trigger: `netlify api getSite` returns no name or auth/site error.
- User message: verify token, site ID, and account access.
- Retryable: maybe, depending on error text.

`model-unavailable`

- Trigger: error text like "Agent X is not available."
- User message: retry with another agent, e.g. `@netlify codex`, `@netlify claude`, or `@netlify gemini`.
- Retryable: true.

`agent-create-failed`

- Trigger: `agents:create` returns no ID.
- User message: show sanitized first useful error line and link logs.
- Retryable: maybe.

`session-create-failed`

- Trigger: follow-up session creation fails after retries.
- User message: existing runner could not be resumed; try a fresh PR/issue prompt or dashboard.
- Retryable: maybe.

`agent-timeout`

- Trigger: polling exceeds `timeout-minutes`.
- User message: task may still be running; check dashboard, increase timeout, or split prompt.
- Retryable: true.

`pull-request-create-failed`

- Trigger: PR creation call finishes without URL.
- User message: check GitHub App installation and repository permissions.
- Retryable: maybe.

`commit-to-branch-failed`

- Trigger: branch commit flow reports merge error or no merge SHA.
- User message: branch may be protected or out of date; inspect PR branch and permissions.
- Retryable: maybe.

`github-permission-denied`

- Trigger: GitHub API 403/404 in comment, PR edit, or permission check paths.
- User message: check workflow permissions and GitHub token.
- Retryable: false until setup changes.

`malformed-api-response`

- Trigger: expected JSON field missing or JSON parse failure.
- User message: include logs and retry; may be upstream response shape change.
- Retryable: maybe.

`unknown`

- Trigger: fallback.
- User message: include sanitized error, logs link, and issue-report guidance.

### Integration Points

`action.yml` shell step should write an additional output:

```bash
echo "failure-stage=create-agent" >> $GITHUB_OUTPUT
echo "failure-category=agent-create-failed" >> $GITHUB_OUTPUT
```

Where shell classification would become too noisy, it can pass raw stage/error data to `generate-error-comment.js`, and that module can call the classifier.

`src/generate-error-comment.js` should:

- Use classifier output.
- Render category-specific title.
- Render remediation bullets.
- Preserve existing dashboard/log links.
- Preserve provider/model fallback hints.

`src/generate-step-summary.js` should:

- Include the same classification.
- Show retryability and whether user action is required.

### Tests

Add `src/failure-taxonomy.test.js`.

Required cases:

- Missing token.
- Missing site ID.
- Model unavailable with alternate model suggestions.
- Agent create returns no ID.
- Follow-up session create fails after retries.
- Timeout.
- PR create no URL.
- Commit-to-branch merge error.
- GitHub permission denied.
- Malformed JSON.
- Unknown fallback.

Add or update `src/generate-error-comment.test.js`.

Required cases:

- Each high-value category produces the right title and remediation.
- Error output is truncated and sanitized.
- Links are included when available.
- Hidden status marker remains present.

### Success Criteria

- Failure comments are specific and actionable.
- Failure category is testable as structured data.
- Step summary and status comments agree on failure classification.

## Workstream G: Structured GitHub Step Summary

Selected idea: 11.

### User Problem

Issue/PR comments are visible to collaborators, but the Actions run page is where maintainers inspect logs and diagnose failures. The action should provide a concise summary there instead of requiring users to hunt through raw logs.

### Plan

Generate a `$GITHUB_STEP_SUMMARY` Markdown report for every triggered run. It should be useful for successful runs, failures, timeouts, dry-runs, and preflight-only runs.

### Summary Sections

Run overview:

```markdown
## Netlify Agent Runners

| Field | Value |
|---|---|
| Outcome | success |
| Event | issue_comment |
| Context | PR #42 |
| Agent | codex |
| Dry-run | false |
| Preflight-only | false |
```

Agent details:

```markdown
## Agent

| Field | Value |
|---|---|
| Runner ID | abc123 |
| Site | example-site |
| Dashboard | https://app.netlify.com/projects/example-site/agent-runs/abc123 |
| Deploy Preview | https://deploy-preview... |
| Pull Request | https://github.com/.../pull/123 |
```

Prompt:

```markdown
## Prompt

> Build a landing page
```

Failure:

```markdown
## Failure

**Category:** `agent-timeout`  
**Retryable:** yes  
**User action required:** no

The agent run did not finish before the configured timeout.

Suggested next steps:
- Check the Netlify Agent Runners dashboard.
- Increase `timeout-minutes`.
- Split the task into a smaller prompt.
```

Preflight:

```markdown
## Preflight Checks

| Check | Status | Notes |
|---|---|---|
| Netlify auth token | pass | Input is present |
| Netlify site | pass | Resolved `example-site` |
```

### Integration Approach

Add `src/generate-step-summary.js` and call it from an `always()` shell or `actions/github-script` step near the end of `action.yml`.

The generator should accept data from environment variables and action outputs. It should not call GitHub or Netlify APIs itself. Its job is rendering, not fetching.

If `$GITHUB_STEP_SUMMARY` is unavailable, the step should no-op.

### Tests

Add `src/generate-step-summary.test.js`.

Required cases:

- Success run includes outcome, context, model, runner ID, PR/deploy links.
- Failure run includes failure category and remediation.
- Timeout run includes timeout duration.
- Dry-run run explains no PR/commit was created.
- Preflight-only success includes checks and explains no agent was started.
- Markdown escaping prevents malformed tables for values containing pipes or newlines.

### Success Criteria

- Every triggered run produces a readable Actions summary.
- The summary is generated from tested renderer logic.
- Failure summaries match the failure taxonomy.

## Cross-Workstream Dependencies

These are dependencies, not implementation choices.

- `comment-markers.js` should come before or alongside state reconciliation, because reconciliation and comment rendering should share marker helpers.
- `failure-taxonomy.js` should come before updated error comments and step summaries, because both should render the same category/remediation contract.
- `scenario-harness.js` should come before the simulator CLI, because the simulator should reuse the harness rather than duplicate behavior.
- `preflight.js` can be implemented independently, but its best test coverage comes from the scenario harness and failure taxonomy.
- `check-docs-drift.js` can be implemented independently after deciding whether `preflight-only` is part of the public API.
- Docs cleanup for canonical slug can happen independently and should use `netlify-labs/agent-runner-action@v1`.

## Suggested Implementation Slices

These slices are intentionally separable. The user can choose any one.

### Slice 1: Docs Slug And Drift Baseline

Scope:

- Normalize all public examples to `netlify-labs/agent-runner-action@v1`.
- Add `src/check-docs-drift.js`.
- Add `docs:check` script.
- Add CI check.

Why it is self-contained: it does not change runtime behavior.

### Slice 2: Comment Markers And State Reconciliation

Scope:

- Add `src/comment-markers.js`.
- Add `src/state-reconciliation.js`.
- Refactor `src/extract-agent-id.js` to use it.
- Add unit tests.

Why it is self-contained: it hardens follow-up state without changing the agent run flow.

### Slice 3: Failure Taxonomy And Error Comments

Scope:

- Add `src/failure-taxonomy.js`.
- Update `src/generate-error-comment.js`.
- Add category outputs where practical.
- Add tests.

Why it is self-contained: it improves diagnostics without changing trigger/run success paths.

### Slice 4: Step Summary

Scope:

- Add `src/generate-step-summary.js`.
- Wire an `always()` summary step in `action.yml`.
- Reuse failure taxonomy.
- Add tests.

Why it is self-contained: it adds observability without changing user-trigger behavior.

### Slice 5: Scenario Harness And Fixtures

Scope:

- Add fixture directories.
- Add `src/scenario-harness.js`.
- Add scenario tests for the major event paths.

Why it is self-contained: it improves confidence and sets up the simulator.

### Slice 6: Simulator CLI

Scope:

- Add `src/simulate.js`.
- Add `simulate` script.
- Reuse scenario harness.
- Add tests.

Why it depends on Slice 5: it should not duplicate harness logic.

### Slice 7: Preflight Mode

Scope:

- Add `preflight-only` input.
- Add `src/preflight.js`.
- Wire preflight step/guards into `action.yml`.
- Add preflight comments and summary rendering.
- Update docs/templates and drift checker.

Why it touches more surface area: it affects public API, action control flow, docs, and summaries.

## Testing Strategy

Unit tests:

- `comment-markers.test.js`
- `state-reconciliation.test.js`
- `failure-taxonomy.test.js`
- `preflight.test.js`
- `generate-step-summary.test.js`
- `check-docs-drift.test.js`
- `simulate.test.js`

Scenario tests:

- `scenario-harness.test.js` should use fixtures and assert full run decisions.

Existing tests to preserve:

- `check-trigger.test.js`
- `get-context.test.js`
- `utils.test.js`
- `action-wiring.test.js`

CI commands:

```bash
bun install
bun test src/*.test.js
bunx tsc --noEmit
bun src/check-docs-drift.js
```

Manual smoke tests:

- Trigger from a new issue.
- Trigger from a PR comment.
- Trigger from a PR review comment.
- Trigger workflow dispatch.
- Run `preflight-only=true`.
- Run `dry-run=true`.
- Use an invalid site ID and confirm failure category.
- Use a malformed existing status comment and confirm safe fallback.

## Documentation Updates

README:

- Ensure every example uses `netlify-labs/agent-runner-action@v1`.
- Add `preflight-only` if accepted.
- Clarify `dry-run` versus `preflight-only`.
- Document the step summary.
- Document failure categories at a high level.
- Add a maintainer section for simulator and scenario tests.

Docs site:

- Ensure canonical slug.
- Add preflight setup validation section if accepted.
- Add troubleshooting table based on failure taxonomy.

Workflow templates:

- Ensure canonical slug.
- Include optional commented examples for `dry-run`, `preflight-only`, `timeout-minutes`, and `debug` once supported/documented.

Example workflow:

- Ensure canonical slug.
- Include the same important optional settings as README.

## Open Questions

1. Should `preflight-only` be added as a public input, or should preflight be an always-on validation step only?
2. Should the simulator be a public documented maintainer tool, or an internal script only?
3. Should docs drift checking parse `docs/index.html` deeply, or is string-level validation enough for now?
4. Should failure category be exposed as a formal action output, e.g. `failure-category`, or only used internally in comments/summaries?
5. Should scenario fixtures live under `fixtures/` at repo root or under `test/fixtures/`?
6. Should the action write a step summary on skipped triggers, or only when `should-run == true`?
7. Should preflight-only post a GitHub status comment, or only write a step summary for manual runs?

## Acceptance Criteria For The Whole Plan

- All public examples use `netlify-labs/agent-runner-action@v1`.
- Docs drift checker runs in CI and passes.
- Scenario harness covers the major GitHub event paths without network calls.
- State reconciliation handles missing and malformed comment state safely.
- Preflight-only mode, if accepted, validates setup without starting an agent.
- Simulator CLI can explain action decisions from fixture payloads.
- Failure comments contain category-specific remediation.
- GitHub Actions step summary gives maintainers a concise run report.
- Existing action behavior remains backward compatible by default.
- `bun test src/*.test.js` and `bunx tsc --noEmit` pass after implementation.

## Plan Review Prompt

Use this prompt for an external review pass:

```text
Carefully review this entire plan for me and come up with your best revisions in terms of better architecture, new features, changed features, etc. to make it better, more robust/reliable, more performant, more compelling/useful, etc. For each proposed change, give me your detailed analysis and rationale/justification for why it would make the project better along with the git-diff style change versus the original plan shown below:

<PASTE THIS COMPLETE PLAN HERE>
```
