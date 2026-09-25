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

The default agent is `codex`. Specify `claude`, `codex`, `gemini`, or `opencode` after `@netlify` to choose an agent.

### Choosing a model and effort

After `@netlify`, you can name an agent, a model, and an effort level, in that order. Each one is optional:

```
@netlify fable high Refactor the checkout flow          # claude + Fable 5, high effort
@netlify claude fable high Refactor the checkout flow   # same thing
@netlify-fable high Refactor the checkout flow          # same thing
@netlify codex sol medium Add retry logic               # codex + GPT 5.6 Sol
@netlify claude high Fix the header                     # claude, model Auto, high effort
@netlify gemini flash Summarize the changelog           # gemini + Gemini 3.6 Flash
```

A model picks its own agent, so `fable` means Claude. If you name a model from a different agent (`@netlify codex fable`), the model wins and the status comment says so. Anything you leave out is chosen by the backend (Auto), unless you set `default-model-id` or `default-effort`.

| Agent | Model | Say |
|---|---|---|
| claude | `claude-fable-5` (Fable 5) | `fable` |
| claude | `claude-opus-5` (Opus 5) | `opus` |
| claude | `claude-opus-4-8` (Opus 4.8) | `opus-4.8` |
| claude | `claude-sonnet-5` (Sonnet 5) | `sonnet` |
| claude | `claude-haiku-4-5` (Haiku 4.5) | `haiku` |
| codex | `gpt-5.6-sol` / `gpt-5.6-terra` / `gpt-5.6-luna` | `codex sol` / `codex terra` / `codex luna` |
| codex | `gpt-5.4-mini` | `codex mini` |
| gemini | `gemini-3.1-pro-preview` | `gemini pro` |
| gemini | `gemini-3.6-flash` / `gemini-3.5-flash-lite` | `gemini flash` / `gemini flash-lite` |
| opencode | `moonshotai/kimi-k3` (Kimi K3) | `kimi` or `k3` |
| opencode | `moonshotai/kimi-k2.7-code` (Kimi K2.7 Code) | `kimi-code` |
| opencode | `z-ai/glm-5.2` (GLM 5.2) | `glm` |
| opencode | `deepseek/deepseek-v4-pro` / `~deepseek/deepseek-v4-flash-latest` | `deepseek` / `deepseek-flash` |
| opencode | `x-ai/grok-4.5` (Grok 4.5) | `grok` |
| opencode | `minimax/minimax-m3` (MiniMax M3) | `minimax` |

The Claude and OpenCode names (`fable`, `opus`, `sonnet`, `haiku`, `kimi`, `glm`, `deepseek`, `grok`, `minimax`, and so on) work on their own, and the single-word ones also work as `@netlify-fable`-style mentions. The shorter Codex and Gemini names need the agent in front, so a prompt starting with "pro tip" isn't read as a model. Exact model IDs always work, and `model:<id>` anywhere on the `@netlify` line requests any model, including ones missing from this list. Those are passed through for Agent Runner to validate.

Effort levels go after an agent or model. Claude, Codex, and Gemini models take `low`, `medium`, or `high`. OpenCode models vary: Kimi K3 and DeepSeek V4 Flash take `low`, `high`, or `max`; GLM 5.2 and DeepSeek V4 Pro take `high` or `max` (sent to Agent Runner as `xhigh`); Grok 4.5 takes `low`, `medium`, or `high`; Kimi K2.7 Code and MiniMax M3 take no effort level. A level only counts when a space, `:`, `,`, or the end of the line follows it, so `@netlify codex low-hanging fixes` leaves effort on Auto. `effort:<level>` anywhere on the line overrides the positional word (use it for prompts like `@netlify claude high priority: ...`), and `effort:auto` forces Auto. If a level isn't supported for the chosen model, the action falls back to Auto and posts a warning in the status comment. A follow-up comment on a PR only changes the model or effort when it names one.

The model list mirrors the Netlify UI's model picker as of 2026-08-06 (`src/agent-catalog.js`).

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
| `default-agent` | No | `codex` | Default agent (`claude`, `codex`, `gemini`, or `opencode`) |
| `default-model` | No | `codex` | Backward-compatible alias for `default-agent` |
| `default-model-id` | No | `''` | Default model ID or alias (e.g. `claude-fable-5`, `fable`). Empty or `auto` lets the backend choose. Ignored when a mention names a different agent |
| `default-effort` | No | `''` | Default effort level (`low`, `medium`, `high`; some OpenCode models take `max`). Empty or `auto` lets the backend choose |
| `manage-labels` | No | `false` | Auto-create and apply labels on agent runs |
| `protected-paths` | No | `default` | Files to flag for review when a run changes them (globs; `default` = built-in list, `none` disables, `!pattern` excludes). See [Scope guard](#scope-guard) |
| `flag-new-top-level` | No | `true` | Also flag files added at the repository root and new top-level folders |
| `protected-paths-action` | No | `comment` | `comment` (always on), plus optionally `label` and/or `draft` |
| `scope-instructions` | No | `default` | Guidance appended to every agent prompt; `default` = report unrelated build/deploy failures instead of working around them, `none` disables |
| `simulate-orphan` | No | `false` | Test-only (used by the canary): exit right after the run checkpoint is written, as if the runner were lost. Never set this in real workflows |
| `operation` | No | `trigger` | `trigger` reacts to `@netlify` mentions; `recover-scan` finds agent runs whose job died and dispatches recovery (see [Recovering unfinished runs](#recovering-unfinished-runs)) |
| `recover-workflow` | No | `netlify-agents.yml` | For `recover-scan`: the main workflow file to dispatch |
| `recover-lookback-hours` | No | `48` | For `recover-scan`: only check issues and PRs updated this recently |
| `recover-max-items` | No | `50` | For `recover-scan`: maximum recently updated issues and PRs to check |
| `dry-run` | No | `false` | Start an agent run but skip commit/PR creation |
| `preflight-only` | No | `false` | Validate setup and exit without creating/resuming an agent run |
| `job-timeout-minutes` | No | `''` | The job's `timeout-minutes`. When set, the agent limit is shortened to leave 5 minutes for setup, so the agent times out cleanly before GitHub cancels the job |
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
- `default-agent` selects one of the supported agents: `claude`, `codex`, `gemini`, or `opencode`
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
| `model-id` | Model ID that was requested (empty when the backend chose Auto) |
| `effort` | Effort level sent to Agent Runner (empty when the backend chose Auto; `max` is sent as `xhigh` for GLM 5.2 and DeepSeek V4 Pro) |
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
| `scope-flags` | JSON array of files the scope check flagged (`path`, `display`, `reason`, `rule`) |
| `scope-flag-count` | Number of files the scope check flagged |
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

## Scope guard

Agents sometimes change files nobody asked for. In early tests, two of three runs added deploy workarounds (`netlify.toml`, `redwood.toml`, a placeholder page) or edited `AGENTS.md` while doing an unrelated one-line task. The scope guard makes that visible. It never blocks a run.

After a successful run, the action looks at the files **that run** changed: the PR's files for a new PR, the landed commit for a follow-up, or the agent's diff for a dry run. The result comment then gets a **⚠️ Review these changes** table. For runs started from an issue, the same section is also posted on the PR, where review happens. The status comment gets a one-line summary.

What gets flagged:

| Pattern | Why |
|---|---|
| `.github/**` | Workflows run with repository secrets |
| `**/netlify.toml` | Build and deploy configuration |
| `*.toml` | Root-level tool configuration (root only) |
| `**/package-lock.json`, `**/pnpm-lock.yaml`, `**/yarn.lock`, `**/bun.lock`, `**/bun.lockb` | Lockfile churn hides dependency changes |
| `**/pnpm-workspace.yaml` | Changes the workspace graph |
| `AGENTS.md`, `CLAUDE.md`, `**/AGENTS.md` | Changes how future agents behave in this repo |
| `**/.env*` | Likely secrets |

With `flag-new-top-level` (on by default), new files at the repository root and new top-level folders are flagged too.

If the request itself names a flagged file ("fix the redirect in `netlify.toml`"), it's listed as **Requested** instead of as a warning. A file counts as named when its full path or its file name (with extension) appears. A folder counts when it's written with a slash, for example `.github/workflows` or `netlify/`. Ordinary words like "netlify" don't count.

Configure it with `protected-paths`:

- Patterns are globs on repo-relative paths: `**` crosses folders, `*` doesn't, and `{a,b}` is alternation.
- **A pattern without a `/` matches only at the repository root**, so `AGENTS.md` means the root file. This is stricter than `.gitignore`; write `**/AGENTS.md` to match anywhere.
- `default` expands to the list above, so `default, infra/**` adds to it. `!pattern` excludes (the last matching pattern wins), and `none` turns pattern checks off.

`protected-paths-action` adds escalations: `label` applies `netlify-agent:review-scope`, and `draft` converts a PR this run opened back to a draft. Both are best-effort and never fail the run.

`scope-instructions` (on by default) adds this to every prompt the agent receives:

> Only modify files needed for this task. If a build or deploy fails for reasons unrelated to your task, do not change build, deploy, or workspace configuration to work around it; finish the task and describe the failure in your result.

The block is hidden from the prompt shown in comments. Set your own text to replace it, or `none` to turn it off.

## Run checkpoints and stopping

As soon as an agent run starts, the status comment shows **View the in progress agent run** and stores a hidden checkpoint for it. The checkpoint holds the runner and session IDs, the requested agent, model and effort, the time limit, and the SDK's resumable run handle. The handle is **encrypted**:
- It's sealed with AES-256-GCM under a key derived from your `NETLIFY_AUTH_TOKEN`.
- It's bound to this repository, thread, and runner, so a copy pasted into another thread fails to open.
- The prompt and site ID never appear in the comment in plain text.

**Cancelling the workflow stops the agent.** If you cancel the workflow run (from the Actions tab), the action stops the agent run and the status comment says "⏹ The workflow was cancelled, so the agent run was stopped." This is best-effort: GitHub gives cancelled jobs only a short grace period.

**Set `job-timeout-minutes`.** GitHub also cancels a job when it hits its own `timeout-minutes`, and that looks the same as a human cancel. Set `job-timeout-minutes` to your job's `timeout-minutes`. The action then shortens the agent's limit, leaving 5 minutes for setup, so the agent times out cleanly first. The templates already do this.

**Polling is resilient.** Rate limits and other transient API errors while waiting for the agent are retried with backoff until the run's time limit, instead of failing the job while the agent keeps working.

Result and status headers show what each run used, for example `Run #3 | claude · Fable 5 · high`. For follow-ups, the effort you requested is shown even though Netlify doesn't report it back.

**Trust model.** The action reads checkpoints only from comments written by its own bot identity. GitHub lets anyone with write access edit comments, and repository write access already allows starting and steering runs. Given that, a tampered checkpoint can at most point the action at another run on the same Netlify site: the sealed handle is authenticated, and its IDs are checked against the public fields and your configured site.

## Recovering unfinished runs

Sometimes the agent keeps working on Netlify after its GitHub job is gone: the runner machine was lost, or the job crashed after the run started. The run's checkpoint in the status comment records that it never finished, and there are two ways it gets finished.

**On the next `@netlify` comment in that thread.** Before starting the new request, the action finishes the previous run:
- It waits for the previous run if it's still working, using up to 40% of the agent time limit so the new request still has time to run.
- It opens the PR, or reports the result, and mentions the person who asked for it.
- If the branch changed since the run started, it reports the result instead of landing it.
- It stops the run instead of landing anything if the thread was closed, if the workflow was cancelled, or if the run passed its time limit.

If the previous run is still working after that, the comment says so and the new request isn't started.

**On a schedule (optional).** Copy [`workflow-templates/netlify-agents-recover.yml`](workflow-templates/netlify-agents-recover.yml) into `.github/workflows/`. GitHub starts it every 30 minutes; it doesn't react to comments. Each time, it:
1. checks issues and PRs updated in the last 48 hours for unfinished runs whose job is gone
2. dispatches your main workflow for each such thread with `recover_thread`

Recovery then happens inside that thread's own concurrency group, one job at a time. A scan with nothing to do takes about 20–30 seconds of Actions time. GitHub may delay scheduled runs, and it disables schedules in public repositories after 60 days without activity.

For recovery dispatches to work, your main workflow needs the `recover_thread` input and the thread-scoped `concurrency` group from the current templates.

## Versioning

Releases are tagged `vX.Y.Z`, and the major tag `v1` always points at the latest `v1.Y.Z` release.

- **Follow v1 automatically:** `uses: netlify-labs/agent-runner-action@v1` picks up every minor and patch release.
- **Pin and review upgrades:** pin a release commit with a version comment, and let Dependabot open a PR for each new release:

  ```yaml
  - uses: netlify-labs/agent-runner-action@<sha> # v1.2.0
  ```

  ```yaml
  # .github/dependabot.yml
  version: 2
  updates:
    - package-ecosystem: github-actions
      directory: /
      schedule:
        interval: weekly
  ```

What counts as a breaking change (it needs a new major tag):

- removing or renaming an input or output, or changing the values an input accepts
- changing the hidden comment markers so older and newer versions can't read each other's comments
- changing the mention syntax so a mention that worked before now selects a different agent, model, or effort

Everything else ships in minor releases. That includes new inputs and outputs, new mention forms that used to be plain prompt text, and changes to agent guidance or comment content. Release notes list those under **Behavior changes**. Workflow-file edits that are needed only to use a new feature are listed under **Action required to use new features**; existing workflows keep working without them.

Maintainers cut releases with the **Release** workflow (`.github/workflows/release.yml`): run it with a version and `dry_run: true` first, then again with `dry_run: false`. It runs the tests, the type check, the docs check, the simulator, and a live canary against the exact commit before it tags anything.

Tag protection (repository settings): the ruleset **Release tags are immutable** blocks creating, moving, or deleting `v*.*.*` tags, and **Major tag v1 moves only via release workflow** does the same for `v1`. Only repository admins and deploy keys can bypass them. The release workflow pushes tags over SSH with the `RELEASE_DEPLOY_KEY` secret, the private half of the write deploy key "release.yml tag pusher". Repository rulesets can't list the GitHub Actions app as a bypass actor, which is why a deploy key is used.

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
`nax-agent-runner-sdk@0.3.0`. The action does not use a workspace link or a
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
