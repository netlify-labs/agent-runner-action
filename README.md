# Netlify Agent Runners

> [!NOTE]
> The action is currently in beta, under active development

A GitHub Action that starts [Netlify Agent Runners](https://www.netlify.com/products/agents/) agent runs directly from GitHub issues and pull requests using `@netlify` mentions.

## How it works

1. Create an issue or comment on a PR with `@netlify` followed by your prompt
2. The action picks up the trigger, adds a 👀 reaction, and creates an in-progress status comment
3. The action uses the published `nax-agent-runner-sdk` package to start a new run or create a follow-up session
4. The SDK waits for the exact session, cancels it on timeout, and lands changed results as an open pull request
5. The action posts a full result comment, then updates the status comment with a short summary and a link to that result

The action is deliberately PR-only. It can create a PR or commit a follow-up
session to an existing agent PR, but it never merges the PR automatically.

### Trigger examples

```
@netlify Build a landing page for a coffee shop with a menu and contact form
@netlify claude Add a dark mode toggle
@netlify codex Make the hero section responsive
@netlify gemini Add a testimonials section
```

The default agent is `codex`. Specify `claude`, `codex`, or `gemini` after `@netlify` to choose an agent.

Aliases like `@netlify-agent` and `@netlify-ai` work too, and common typos are recognised (`@nelify`, `@netlfy`, `@netify`, `@netlif`, `@netfly`). Mentions inside fenced code blocks or inline code spans are ignored, so you can quote `@netlify` in a comment without triggering a run.

## Quick start

### 1. Install prerequisites

- Install the [netlify-coding](https://github.com/apps/netlify-coding) GitHub App on your repository
- Create a Netlify site linked to your repo (`netlify init`)
- Generate a [Netlify personal access token](https://app.netlify.com/user/applications#personal-access-tokens)

### 2. Add repository secrets

Go to **Settings > Secrets and variables > Actions** and add:

| Secret | Description |
|---|---|
| `NETLIFY_AUTH_TOKEN` | Your Netlify personal access token |
| `NETLIFY_SITE_ID` | Your Netlify site ID (from Site configuration > General) |

### 3. Add the workflow

Create `.github/workflows/netlify-agents.yml` in your repository:

```yaml
name: Netlify Agent Runners

on:
  workflow_dispatch:
    inputs:
      trigger_text:
        description: 'Prompt for the agent run'
        required: true
        type: string
        default: '@netlify'
      actor:
        description: 'Actor triggering the agent'
        required: true
        type: string
      agent:
        description: 'Agent to use'
        required: false
        type: choice
        options:
          - codex
          - claude
          - gemini
        default: 'codex'
  pull_request_target:
    types: [opened, reopened]
  pull_request_review_comment:
    types: [created]
  pull_request_review:
    types: [submitted, edited]
  issues:
    types: [opened, assigned, edited]
  issue_comment:
    types: [created, edited]

concurrency:
  group: netlify-${{ github.repository }}-${{ github.event.pull_request.number || github.event.issue.number || github.run_id }}
  cancel-in-progress: false

jobs:
  netlify-agent:
    # Skip bot senders early to avoid burning Actions minutes
    if: >-
      github.event_name == 'workflow_dispatch' ||
      (
        github.event.sender.login != 'github-actions[bot]' &&
        github.event.sender.login != 'netlify-coding[bot]' &&
        github.event.sender.login != 'netlify[bot]'
      )
    runs-on: ubuntu-latest
    timeout-minutes: 25
    permissions:
      contents: write
      pull-requests: write
      issues: write
    steps:
      - uses: netlify-labs/agent-runner-action@v1
        with:
          netlify-auth-token: ${{ secrets.NETLIFY_AUTH_TOKEN }}
          netlify-site-id: ${{ secrets.NETLIFY_SITE_ID }}
```

### 4. Trigger a run

Create a new issue:

```
Title: Build a portfolio site
Body: @netlify claude Create a modern portfolio with a projects grid and contact form
```

Or comment `@netlify make it blue` on an existing PR.

## Inputs

| Input | Required | Default | Description |
|---|---|---|---|
| `netlify-auth-token` | Yes | — | Netlify personal access token |
| `netlify-site-id` | Yes | — | Netlify site ID |
| `netlify-filter` | No | `''` | Deprecated compatibility input. SDK dispatch uses the exact `netlify-site-id`. |
| `github-token` | No | `github.token` | GitHub token for API calls |
| `allowed-users` | No | `''` | Comma-separated usernames allowed to trigger (empty = repo collaborators) |
| `default-agent` | No | `codex` | Default agent (`claude`, `codex`, or `gemini`) |
| `default-model` | No | `codex` | Backward-compatible alias for `default-agent` |
| `manage-labels` | No | `false` | Auto-create and apply labels on agent runs |
| `dry-run` | No | `false` | Start an agent run but skip commit/PR creation |
| `preflight-only` | No | `false` | Validate setup and exit without creating/resuming an agent run |
| `timeout-minutes` | No | `10` | Max minutes to wait for agent completion |
| `netlify-cli-version` | No | `24.8.1` | Netlify CLI version to install |
| `debug` | No | `false` | Enable debug logging of API responses |
| `timezone` | No | `America/Los_Angeles` | Timezone used for date/time rendering in comments |

## Execution modes: `dry-run` vs `preflight-only`

- `dry-run: 'true'` still starts an agent run (external Netlify calls still happen), but it skips branch commits and pull request creation.
- `preflight-only: 'true'` validates setup and permissions, then exits before creating/resuming any agent run.
- If both are set to `true`, `preflight-only` behavior wins and no agent is started.

```yaml
steps:
  - uses: netlify-labs/agent-runner-action@v1
    id: preflight
    with:
      netlify-auth-token: ${{ secrets.NETLIFY_AUTH_TOKEN }}
      netlify-site-id: ${{ secrets.NETLIFY_SITE_ID }}
      preflight-only: 'true' # setup validation only, no agent run

  - uses: netlify-labs/agent-runner-action@v1
    id: preview
    with:
      netlify-auth-token: ${{ secrets.NETLIFY_AUTH_TOKEN }}
      netlify-site-id: ${{ secrets.NETLIFY_SITE_ID }}
      dry-run: 'true' # agent runs, but no commits/PR creation
```

### Preflight troubleshooting

If `preflight-only` fails, inspect `preflight-summary` and `preflight-json` outputs and check:

- `netlify-auth-token` is present and valid
- `netlify-site-id` matches a site your token can access
- `default-agent` selects one of the supported agents: `claude`, `codex`, or `gemini`
- `default-model` remains supported as a backward-compatible alias
- `timeout-minutes` is a positive integer
- workflow permissions include `contents: write`, `pull-requests: write`, and `issues: write`

## Outputs

Use these outputs in subsequent workflow steps for custom automation:

| Output | Description |
|---|---|
| `agent-id` | Agent run ID |
| `outcome` | `success`, `failure`, or `timeout` |
| `agent-result` | Agent result summary text |
| `agent-pr-url` | Pull request URL (if created) |
| `agent-deploy-url` | Deploy preview URL |
| `agent` | Agent that was used |
| `model` | Backward-compatible alias for `agent` |
| `trigger-text` | Cleaned trigger text / prompt |
| `is-pr` | Whether triggered from a PR (`true`/`false`) |
| `issue-number` | Issue or PR number |
| `is-dry-run` | Whether the run used preview mode (`true`/`false`) |
| `preflight-ok` | Whether preflight validation passed (`true`/`false`) |
| `preflight-json` | Serialized preflight result payload (`ok`, `checks`, `warnings`, `failures`) |
| `preflight-summary` | Human-readable summary of preflight status |
| `should-continue` | Whether workflow execution should continue into agent runtime |
| `failure-category` | Preflight/runtime failure taxonomy category when available |
| `failure-stage` | Preflight/runtime failure stage when available |
| `agent-error` | Sanitized runtime error summary emitted by agent orchestration |

### Using outputs

```yaml
steps:
  - uses: netlify-labs/agent-runner-action@v1
    id: agent
    with:
      netlify-auth-token: ${{ secrets.NETLIFY_AUTH_TOKEN }}
      netlify-site-id: ${{ secrets.NETLIFY_SITE_ID }}

  - name: Run tests on agent PR
    if: steps.agent.outputs.outcome == 'success' && steps.agent.outputs.agent-pr-url != ''
    run: echo "Agent created PR: ${{ steps.agent.outputs.agent-pr-url }}"
```

## Maintainer simulator CLI

Use the local simulator to preview action decisions from fixtures without GitHub Actions or live Netlify calls. The `simulate` package script wraps `src/simulate.js`.

```bash
# Human-readable run/skip decision for a fixture
bun run simulate --fixture fixtures/events/issue-comment-on-pr.json

# JSON for scripts and test debugging
bun run simulate --fixture fixtures/events/workflow-dispatch.json --format json

# Markdown for copying a scenario report into an issue or PR
bun run simulate --fixture fixtures/events/issue-comment-on-pr.json --state-fixture /tmp/state.json --format markdown
```

Notes:
- `--fixture` is required.
- `--state-fixture` is optional and can inject prior status/PR state for runner recovery paths.
- `--format` supports `human` (default), `json`, and `markdown`.
- Each report includes the scenario name, run/skip decision, context, recovered state, and rendered comments.
- Reconciliation warnings are included in simulator output under `Warnings`.

## Maintainer local CI with act

Use [`act`](https://github.com/nektos/act) to run the GitHub Actions CI workflow locally before pushing.

```bash
bun run act:list
bun run act:ci
bun run act:ci:pr
```

The repo includes `.actrc` plus push and pull request payloads under `.act/`. Normal `act` runs require Docker. On macOS, start Docker Desktop first. If Docker is unavailable, `bun run act:ci:host` runs the same job on the host machine as a faster smoke check, but it is less representative than the container-backed runner.

## What gets posted

- **Status comment** — one mutable current-state comment with a short summary, deploy/agent/log links, and hidden state markers used to resume follow-up runs
- **Result comments** — one immutable full narrative comment per Netlify session run, including the prompt, result prose, screenshot, and links
- **History TOC** — one compact PR-only table of contents linking to result comments, newest-first
- **Issue redirect** — after a PR is created from an issue, a note directs users to the PR

## Follow-up prompts

After the first run creates a PR, add follow-up `@netlify` comments on the PR. The agent iterates on existing code. Commenting on the original issue shows a redirect to the PR.

## Troubleshooting

**Missing `NETLIFY_AUTH_TOKEN` or `NETLIFY_SITE_ID`.** Add both as repository secrets under **Settings > Secrets and variables > Actions**. Create a personal access token at <https://app.netlify.com/user/applications#personal-access-tokens>. Find your Site ID in the Netlify dashboard under Site configuration > General.

**Preflight checks failed.** Inspect the `preflight-summary` and `preflight-json` outputs. Common causes: a token/site-ID mismatch, an invalid `default-agent`, a non-positive `timeout-minutes`, or missing workflow permissions (`contents: write`, `pull-requests: write`, `issues: write`).

**"The project can't be found".** `NETLIFY_SITE_ID` points to a site that doesn't exist or that the current token can't access. Verify the site ID in the Netlify dashboard and regenerate the token if needed.

**Agent timed out.** Default timeout is 10 minutes. Increase it with `timeout-minutes: '15'` (or higher) for complex prompts, or split large tasks into smaller follow-up `@netlify` comments on the PR.

**"`dry-run` still contacted Netlify".** Expected. `dry-run: 'true'` skips commit/PR creation but still creates an agent run. Use `preflight-only: 'true'` for a no-op validation with no agent run.

**"Requested agent is not available".** The selected agent is temporarily unavailable. Try a different one: `@netlify claude`, `@netlify codex`, or `@netlify gemini`.

**Workflow runs on bot comments.** Add the job-level `if:` guard shown in the [Quick start workflow](#3-add-the-workflow) to skip `github-actions[bot]`, `netlify-coding[bot]`, and `netlify[bot]` senders.

**Monorepo site builds the wrong app.** Set `netlify-site-id` to the specific
Netlify site for the app. `netlify-filter` is retained only so existing
workflows do not break; SDK dispatch does not use CLI filter selection.

## Security

- Only repository collaborators, members, and owners can trigger agent runs
- Bot accounts (`github-actions[bot]`, `netlify-coding[bot]`, `netlify[bot]`) are excluded to prevent feedback loops
- Concurrency control ensures one run per issue/PR at a time
- The `allowed-users` input can further restrict access to specific users
- Common `@netlify` typos (`@nelify`, `@netlfy`, etc.) are recognised
- Only status comments carry runner/session state markers. Result comments are scrubbed so user or agent prose cannot reflect status/history/state markers into bot-authored comments; they carry only a result identifier marker for the PR history TOC.

### Trust model and `pull_request_target`

The example workflow uses the `pull_request_target` trigger so that PRs opened from forks can trigger agent runs. This trigger is powerful: it runs in the context of the base repository with access to repository secrets (`NETLIFY_AUTH_TOKEN`) and a write-scoped `GITHUB_TOKEN`. Combined with checking out the PR's head commit, this is the pattern GitHub Security Lab describes as a ["pwn request"](https://securitylab.github.com/resources/github-actions-preventing-pwn-requests/) — if misused, it lets a fork PR author exfiltrate secrets or push to your repo.

This action is safe under that trigger because:

1. **Author-association gate.** Before checkout, the action checks `author_association` on the event and drops anything that isn't `COLLABORATOR`, `MEMBER`, `OWNER`, or a user with write permission on the repo. Fork PRs from outside contributors are skipped.
2. **No PR code is executed on the runner.** After checkout, the workflow only inspects `package.json` for framework detection, runs `git diff` against the base branch, installs action-owned dependencies from `github.action_path`, installs a pinned Netlify CLI for site metadata, and hands the prompt to Netlify's remote agent service. The agent itself runs on Netlify infrastructure, not on your runner.

**If you fork this workflow, do not add steps that execute PR-supplied code** (e.g. `npm install` against the PR's `package.json`, running the project's tests/linter/build, or any tool that loads config files from the workspace). Any such step turns this from "trusted-only trigger that calls a remote API" into a credential exfiltration vector. If you need to run PR code, switch to the two-workflow `pull_request` + `workflow_run` pattern described in the GitHub Security Lab article above.

## SDK dependency policy

Runner lifecycle behavior comes from the exact published dependency
`nax-agent-runner-sdk@0.2.0-next.1`. The action does not use a workspace link or a
floating semver range. Maintainers should upgrade that pin intentionally,
review the SDK changelog, regenerate `package-lock.json`, and run:

```bash
npm ci --ignore-scripts
npm run typecheck
npm test
npm run docs:check
```

The integration suite exercises the installed npm package through create,
wait, timeout, follow-up, checkpoint, and PR-only landing boundaries.

## Contributing

Issues, bug reports, and pull requests are welcome. Before opening a PR, please:

- Run `bun test` and `bun run docs:check` locally — both should pass.
- Use the simulator (`bun run simulate --fixture <path>`) when changing trigger or runner decisions, and add a fixture under `fixtures/events/` for new event shapes.
- Keep the README, `docs/index.html`, `example-workflow.yml`, and `workflow-templates/netlify-agents.yml` in sync when changing inputs, outputs, or the recommended workflow.
