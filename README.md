# Netlify Agent Runners

> [!NOTE]
> The action is currently in beta, under active development

A GitHub Action that starts [Netlify Agent Runners](https://www.netlify.com/products/agents/) agent runs directly from GitHub issues and pull requests using `@netlify` mentions.

## How it works

1. Create an issue or comment on a PR with `@netlify` followed by your prompt
2. The action picks up the trigger, adds a 👀 reaction, and creates an in-progress status comment
3. Netlify Agent Runners creates an agent run to build or modify your site based on the prompt
4. On completion, the status comment is updated with a screenshot, deploy preview link, and result summary
5. If triggered from an issue, a PR is automatically created with the changes

### Trigger examples

```
@netlify Build a landing page for a coffee shop with a menu and contact form
@netlify claude Add a dark mode toggle
@netlify codex Make the hero section responsive
@netlify gemini Add a testimonials section
```

The default agent is `codex`. Specify `claude`, `codex`, or `gemini` after `@netlify` to choose an agent.

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
        description: 'Agent to use (claude, codex, gemini)'
        required: false
        type: string
        default: 'codex'
  pull_request_target:
    types: [opened, synchronize, reopened]
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
      # preflight-only: 'false' # Validate setup and stop before agent execution

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

- **Status comment** — current run result with screenshot, deploy preview, and links
- **History comment** — chronological list of all runs (on PRs only)
- **Issue redirect** — after a PR is created from an issue, a note directs users to the PR

## Follow-up prompts

After the first run creates a PR, add follow-up `@netlify` comments on the PR. The agent iterates on existing code. Commenting on the original issue shows a redirect to the PR.

## Security

- Only repository collaborators, members, and owners can trigger agent runs
- Bot accounts (`github-actions[bot]`, `netlify-coding[bot]`) are excluded
- Concurrency control ensures one run per issue/PR at a time
- The `allowed-users` input can further restrict access to specific users
- Common `@netlify` typos (`@nelify`, `@netlfy`, etc.) are recognised
