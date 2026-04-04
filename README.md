# Netlify Agent Runner

> [!NOTE]
> The action is currently in beta, under active development

A GitHub Action that lets you trigger [Netlify Agents](https://www.netlify.com/products/agents/) directly from GitHub issues and pull requests using `@netlify` mentions.

## How it works

1. Create an issue or comment on a PR with `@netlify` followed by your prompt
2. The action picks up the trigger, adds a 👀 reaction, and creates an in-progress status comment
3. Netlify Agents builds or modifies your site based on the prompt
4. On completion, the status comment is updated with a screenshot, deploy preview link, and result summary
5. If triggered from an issue, a PR is automatically created with the changes

### Trigger examples

```
@netlify Build a landing page for a coffee shop with a menu and contact form
@netlify claude Add a dark mode toggle
@netlify codex Make the hero section responsive
@netlify gemini Add a testimonials section
```

The default model is `codex`. Specify `claude`, `codex`, or `gemini` after `@netlify` to choose a model.

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
name: Netlify Agents

on:
  workflow_dispatch:
    inputs:
      trigger_text:
        description: 'Prompt for the Netlify Agent'
        required: true
        type: string
        default: '@netlify'
      actor:
        description: 'Actor triggering the agent'
        required: true
        type: string
      model:
        description: 'Model to use (claude, codex, gemini)'
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
| `default-model` | No | `codex` | Default AI model (`claude`, `codex`, or `gemini`) |
| `manage-labels` | No | `false` | Auto-create and apply labels on agent runs |
| `timeout-minutes` | No | `10` | Max minutes to wait for agent completion |
| `debug` | No | `false` | Enable debug logging of API responses |

## Outputs

Use these outputs in subsequent workflow steps for custom automation:

| Output | Description |
|---|---|
| `agent-id` | Netlify agent runner ID |
| `outcome` | `success`, `failure`, or `timeout` |
| `agent-result` | Agent result summary text |
| `agent-pr-url` | Pull request URL (if created) |
| `agent-deploy-url` | Deploy preview URL |
| `model` | AI model that was used |
| `trigger-text` | Cleaned trigger text / prompt |
| `is-pr` | Whether triggered from a PR (`true`/`false`) |
| `issue-number` | Issue or PR number |

### Using outputs

```yaml
steps:
  - uses: netlify/agent-runner@v1
    id: agent
    with:
      netlify-auth-token: ${{ secrets.NETLIFY_AUTH_TOKEN }}
      netlify-site-id: ${{ secrets.NETLIFY_SITE_ID }}

  - name: Run tests on agent PR
    if: steps.agent.outputs.outcome == 'success' && steps.agent.outputs.agent-pr-url != ''
    run: echo "Agent created PR: ${{ steps.agent.outputs.agent-pr-url }}"
```

## What gets posted

- **Status comment** — current run result with screenshot, deploy preview, and links
- **History comment** — chronological list of all runs (on PRs only)
- **Issue redirect** — after a PR is created from an issue, a note directs users to the PR

## Follow-up prompts

After the first run creates a PR, add follow-up `@netlify` comments on the PR. The agent iterates on existing code. Commenting on the original issue shows a redirect to the PR.

## Security

- Only repository collaborators, members, and owners can trigger the agent
- Bot accounts (`github-actions[bot]`, `netlify-coding[bot]`) are excluded
- Concurrency control ensures one run per issue/PR at a time
- The `allowed-users` input can further restrict access to specific users
- Common `@netlify` typos (`@nelify`, `@netlfy`, etc.) are recognised
