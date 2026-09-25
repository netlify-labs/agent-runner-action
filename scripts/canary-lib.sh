#!/usr/bin/env bash
# Canary scenario library for .github/workflows/canary.yml.
#
# Each scenario is a function "scenario_<name>" that uses the shared helpers
# below. Helpers log every step with a timestamp and record checks in a
# Markdown table written to $GITHUB_STEP_SUMMARY, so a failure is diagnosable
# from the run page alone.
#
# Required env (set by canary.yml): GH_TOKEN, CANARY_REPO, CANARY_WORKFLOW_PATH,
# CANARY_WORKFLOW_NAME, TIMEOUT_MINUTES, ACTION_REF, RUN_MARKER, GITHUB_OUTPUT.
# Optional: NETLIFY_AUTH_TOKEN (backend assertions), REQUESTED_PROMPT.

CANARY_CHECKS_FILE="${RUNNER_TEMP:-/tmp}/canary-checks.md"
CANARY_FAILED=0

log() {
  printf '[%s] %s\n' "$(date -u +%H:%M:%S)" "$*"
}

output() {
  # output <name> <value>
  printf '%s=%s\n' "$1" "$2" >> "${GITHUB_OUTPUT:-/dev/null}"
}

record_check() {
  # record_check <case> <expectation> <observed> <pass|fail>
  local icon='✅'
  if [ "$4" != "pass" ]; then
    icon='❌'
    CANARY_FAILED=1
    echo "::error title=Canary check failed::$1: expected $2, observed $3"
  fi
  printf '| %s | %s | %s | %s |\n' "$1" "$2" "$3" "$icon" >> "$CANARY_CHECKS_FILE"
  log "check [$1] $2 -> $3 ($4)"
}

expect_contains() {
  # expect_contains <case> <label> <haystack> <needle>
  if printf '%s' "$3" | grep -F -- "$4" >/dev/null; then
    record_check "$1" "$2 contains \`$4\`" "found" pass
  else
    record_check "$1" "$2 contains \`$4\`" "missing" fail
  fi
}

expect_equal() {
  # expect_equal <case> <label> <actual> <expected>
  if [ "$3" = "$4" ]; then
    record_check "$1" "$2 is \`$4\`" "\`$3\`" pass
  else
    record_check "$1" "$2 is \`$4\`" "\`$3\`" fail
  fi
}

expect_not_contains() {
  # expect_not_contains <case> <label> <haystack> <needle>
  if printf '%s' "$3" | grep -F -- "$4" >/dev/null; then
    record_check "$1" "$2 does not contain \`$4\`" "found" fail
  else
    record_check "$1" "$2 does not contain \`$4\`" "absent" pass
  fi
}

pr_number_from_comments() {
  # Reads comment text on stdin; prints the first PR number it links to.
  perl -ne 'if (/Pull Request.*?#([0-9]+)/i) { print "$1\n"; exit } if (/pull\/([0-9]+)/) { print "$1\n"; exit }'
}

checkpoint_state_from_body() {
  # Reads a status comment body on stdin; prints the checkpoint "state" or "".
  perl -0ne 'if (/<!-- netlify-agent-run-checkpoint:(\{.*?\}) -->/s) { my $j = $1; if ($j =~ /"state"\s*:\s*"([a-z-]+)"/) { print "$1\n" } }'
}

pin_canary_workflow() {
  local workdir="${RUNNER_TEMP:-/tmp}/agent-runner-action-canary"
  rm -rf "$workdir"
  gh repo clone "$CANARY_REPO" "$workdir" -- --depth 1
  (
    cd "$workdir" || exit 1
    git config user.name "github-actions[bot]"
    git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
    if [ ! -f "$CANARY_WORKFLOW_PATH" ]; then
      echo "::error::Canary workflow file not found: ${CANARY_WORKFLOW_PATH}"
      exit 1
    fi
    ACTION_REF="$ACTION_REF" perl -0pi -e \
      's#netlify-labs/agent-runner-action@[A-Za-z0-9._/-]+#"netlify-labs/agent-runner-action@".$ENV{ACTION_REF}#ge' \
      "$CANARY_WORKFLOW_PATH"
    if git diff --quiet -- "$CANARY_WORKFLOW_PATH"; then
      log "Canary workflow already pinned to ${ACTION_REF}."
    else
      git add "$CANARY_WORKFLOW_PATH"
      git commit -m "chore: pin Agent Runners canary to ${ACTION_REF}"
      git remote set-url origin "https://x-access-token:${GH_TOKEN}@github.com/${CANARY_REPO}.git"
      git push origin HEAD:main
      log "Pinned canary workflow to ${ACTION_REF}."
    fi
  )
}

# run_issue_case <case> <prompt>
# Creates an issue, waits for the downstream run, and sets:
#   CASE_ISSUE_NUMBER CASE_ISSUE_URL CASE_RUN_ID CASE_RUN_URL CASE_CONCLUSION CASE_PR_NUMBER CASE_COMMENTS
run_issue_case() {
  local case_name="$1" prompt="$2"
  local title="Agent Runners canary ${case_name} ${RUN_MARKER}"
  local timeout_seconds=$((TIMEOUT_MINUTES * 60))
  local start=$SECONDS
  local body
  body=$(printf '%s\n\nCanary metadata:\n- source_repo: %s\n- action_ref: %s\n- marker: %s\n- case: %s\n' \
    "$prompt" "${GITHUB_REPOSITORY:-}" "$ACTION_REF" "$RUN_MARKER" "$case_name")

  CASE_ISSUE_URL=$(gh issue create --repo "$CANARY_REPO" --title "$title" --body "$body")
  CASE_ISSUE_NUMBER="${CASE_ISSUE_URL##*/}"
  log "[$case_name] created issue ${CASE_ISSUE_URL}"

  CASE_RUN_ID=""
  while [ -z "$CASE_RUN_ID" ]; do
    if [ $((SECONDS - start)) -gt "$timeout_seconds" ]; then
      record_check "$case_name" "downstream run starts" "timed out" fail
      return 1
    fi
    CASE_RUN_ID=$(gh run list --repo "$CANARY_REPO" --workflow "$CANARY_WORKFLOW_NAME" --event issues --limit 20 \
      --json databaseId,displayTitle --jq ".[] | select(.displayTitle == \"${title}\") | .databaseId" | head -n 1)
    [ -z "$CASE_RUN_ID" ] && sleep 10
  done
  CASE_RUN_URL="https://github.com/${CANARY_REPO}/actions/runs/${CASE_RUN_ID}"
  log "[$case_name] downstream run ${CASE_RUN_URL}"

  while true; do
    if [ $((SECONDS - start)) -gt "$timeout_seconds" ]; then
      record_check "$case_name" "downstream run completes" "timed out" fail
      return 1
    fi
    if [ "$(gh run view "$CASE_RUN_ID" --repo "$CANARY_REPO" --json status --jq .status)" = "completed" ]; then
      break
    fi
    sleep 20
  done
  CASE_CONCLUSION=$(gh run view "$CASE_RUN_ID" --repo "$CANARY_REPO" --json conclusion --jq .conclusion)
  log "[$case_name] downstream run concluded ${CASE_CONCLUSION}"
  if [ "$CASE_CONCLUSION" != "success" ]; then
    echo "::group::[$case_name] failed downstream logs"
    gh run view "$CASE_RUN_ID" --repo "$CANARY_REPO" --log-failed || true
    echo "::endgroup::"
  fi

  CASE_COMMENTS=$(gh issue view "$CASE_ISSUE_NUMBER" --repo "$CANARY_REPO" --json comments --jq '[.comments[].body] | join("\n")')
  CASE_PR_NUMBER=$(printf '%s\n' "$CASE_COMMENTS" | pr_number_from_comments || true)
  return 0
}

status_comment_body() {
  # status_comment_body <issue number>: newest comment carrying the status marker.
  gh api "repos/${CANARY_REPO}/issues/$1/comments?per_page=100" \
    --jq '[.[] | select(.body | contains("<!-- netlify-agent-run-status -->"))] | last | .body // ""'
}

checkpoint_runner_from_body() {
  # Reads a status comment body on stdin; prints the checkpoint runnerId or "".
  perl -0ne 'if (/<!-- netlify-agent-run-checkpoint:(\{.*?\}) -->/s) { my $j = $1; if ($j =~ /"runnerId"\s*:\s*"([A-Za-z0-9_-]+)"/) { print "$1\n" } }'
}

backend_session_states() {
  # backend_session_states <runner id>: prints each session state (needs NETLIFY_AUTH_TOKEN).
  if [ -z "${NETLIFY_AUTH_TOKEN:-}" ]; then
    echo "unknown"
    return 0
  fi
  curl -fsS -H "Authorization: Bearer ${NETLIFY_AUTH_TOKEN}" \
    "https://api.netlify.com/api/v1/agent_runners/$1/sessions" | jq -r '.[].state'
}

# start_issue_case <case> <prompt>: create the issue and wait until the
# downstream run starts. Sets CASE_ISSUE_NUMBER CASE_ISSUE_URL CASE_RUN_ID CASE_RUN_URL.
start_issue_case() {
  local case_name="$1" prompt="$2"
  local title="Agent Runners canary ${case_name} ${RUN_MARKER}"
  local start=$SECONDS
  local body
  body=$(printf '%s\n\nCanary metadata:\n- action_ref: %s\n- marker: %s\n- case: %s\n' "$prompt" "$ACTION_REF" "$RUN_MARKER" "$case_name")
  CASE_ISSUE_URL=$(gh issue create --repo "$CANARY_REPO" --title "$title" --body "$body")
  CASE_ISSUE_NUMBER="${CASE_ISSUE_URL##*/}"
  log "[$case_name] created issue ${CASE_ISSUE_URL}"
  CASE_RUN_ID=""
  while [ -z "$CASE_RUN_ID" ]; do
    if [ $((SECONDS - start)) -gt 600 ]; then
      record_check "$case_name" "downstream run starts" "timed out" fail
      return 1
    fi
    CASE_RUN_ID=$(gh run list --repo "$CANARY_REPO" --workflow "$CANARY_WORKFLOW_NAME" --event issues --limit 20 \
      --json databaseId,displayTitle --jq ".[] | select(.displayTitle == \"${title}\") | .databaseId" | head -n 1)
    [ -z "$CASE_RUN_ID" ] && sleep 10
  done
  CASE_RUN_URL="https://github.com/${CANARY_REPO}/actions/runs/${CASE_RUN_ID}"
  log "[$case_name] downstream run ${CASE_RUN_URL}"
}

wait_run_completed() {
  # wait_run_completed <run id> <timeout seconds>
  local start=$SECONDS
  while [ "$(gh run view "$1" --repo "$CANARY_REPO" --json status --jq .status)" != "completed" ]; do
    if [ $((SECONDS - start)) -gt "$2" ]; then return 1; fi
    sleep 15
  done
}

wait_checkpoint_state() {
  # wait_checkpoint_state <issue> <state> <timeout seconds>: echo the body when reached.
  local start=$SECONDS body
  while true; do
    body=$(status_comment_body "$1")
    if [ "$(printf '%s' "$body" | checkpoint_state_from_body)" = "$2" ]; then
      printf '%s' "$body"
      return 0
    fi
    if [ $((SECONDS - start)) -gt "$3" ]; then return 1; fi
    sleep 10
  done
}

pr_comments() {
  gh pr view "$1" --repo "$CANARY_REPO" --json comments --jq '[.comments[].body] | join("\n")'
}

# ---------------------------------------------------------------- scenarios

scenario_default() {
  local prompt="${REQUESTED_PROMPT:-@netlify codex mini low in README.md, replace or add one line exactly: Canary marker: ${RUN_MARKER}. Do not edit other files.}"
  run_issue_case default "$prompt" || return 1
  output issue-url "$CASE_ISSUE_URL"
  output run-url "$CASE_RUN_URL"
  output run-conclusion "$CASE_CONCLUSION"
  if [ "$CASE_CONCLUSION" = "success" ]; then record_check default "downstream run succeeds" "$CASE_CONCLUSION" pass
  else record_check default "downstream run succeeds" "$CASE_CONCLUSION" fail; return 1; fi
  if [ -z "$CASE_PR_NUMBER" ]; then record_check default "a PR is linked from the issue" "none" fail; return 1; fi
  output pr-url "https://github.com/${CANARY_REPO}/pull/${CASE_PR_NUMBER}"
  record_check default "a PR is linked from the issue" "#${CASE_PR_NUMBER}" pass
  if gh pr diff "$CASE_PR_NUMBER" --repo "$CANARY_REPO" | grep -F "$RUN_MARKER" >/dev/null; then
    record_check default "PR diff contains the marker" "found" pass
  else
    record_check default "PR diff contains the marker" "missing" fail
  fi
}

scenario_scope_creep() {
  # (a) Unrequested change: the prompt asks for a build-config edit without
  # naming the file, so netlify.toml must be flagged.
  run_issue_case scope-unrequested "@netlify codex mini low in README.md, replace or add one line exactly: Canary marker: ${RUN_MARKER}-a. Also add the comment line '# canary ${RUN_MARKER}-a' at the very top of this repository's Netlify build configuration file. Do not edit other files." || return 1
  output issue-url "$CASE_ISSUE_URL"
  output run-url "$CASE_RUN_URL"
  output run-conclusion "$CASE_CONCLUSION"
  expect_equal scope-unrequested "downstream run conclusion" "$CASE_CONCLUSION" success
  expect_contains scope-unrequested "issue result comment" "$CASE_COMMENTS" "Review these changes"
  # shellcheck disable=SC2016 # literal backticks: the rendered code span
  expect_contains scope-unrequested "issue result comment" "$CASE_COMMENTS" '`netlify.toml`'
  if [ -n "$CASE_PR_NUMBER" ]; then
    output pr-url "https://github.com/${CANARY_REPO}/pull/${CASE_PR_NUMBER}"
    local pr_text
    pr_text=$(pr_comments "$CASE_PR_NUMBER")
    expect_contains scope-unrequested "PR scope comment" "$pr_text" "netlify-agent-scope:"
    expect_contains scope-unrequested "PR scope comment" "$pr_text" "Protected path \`**/netlify.toml\`"
  else
    record_check scope-unrequested "a PR is linked from the issue" "none" fail
  fi

  # (b) Requested change: naming netlify.toml moves it to "Requested".
  run_issue_case scope-requested "@netlify codex mini low add the comment line '# canary ${RUN_MARKER}-b' at the very top of netlify.toml. Do not edit other files." || return 1
  expect_equal scope-requested "downstream run conclusion" "$CASE_CONCLUSION" success
  expect_contains scope-requested "issue result comment" "$CASE_COMMENTS" "Protected files changed on request"
  expect_not_contains scope-requested "issue result comment" "$CASE_COMMENTS" "Review these changes"
}

not_implemented() {
  record_check "$1" "scenario is implemented" "not implemented yet" fail
  return 1
}
scenario_cancel_stops() {
  start_issue_case cancel-stops "@netlify codex mini low Create docs/canary-cancel-${RUN_MARKER}.md with a numbered list of 200 short, distinct facts about static site hosting, one per line. Do not edit other files." || return 1
  output issue-url "$CASE_ISSUE_URL"
  output run-url "$CASE_RUN_URL"
  local body runner
  if ! body=$(wait_checkpoint_state "$CASE_ISSUE_NUMBER" running 600); then
    record_check cancel-stops "checkpoint reaches running" "never seen" fail
    return 1
  fi
  runner=$(printf '%s' "$body" | checkpoint_runner_from_body)
  record_check cancel-stops "checkpoint reaches running" "runner ${runner}" pass
  log "[cancel-stops] cancelling downstream run ${CASE_RUN_ID}"
  gh run cancel "$CASE_RUN_ID" --repo "$CANARY_REPO"
  if ! wait_run_completed "$CASE_RUN_ID" 300; then
    record_check cancel-stops "downstream run completes after cancel" "timed out" fail
    return 1
  fi
  expect_equal cancel-stops "downstream run conclusion" "$(gh run view "$CASE_RUN_ID" --repo "$CANARY_REPO" --json conclusion --jq .conclusion)" cancelled
  body=$(status_comment_body "$CASE_ISSUE_NUMBER")
  expect_equal cancel-stops "checkpoint state" "$(printf '%s' "$body" | checkpoint_state_from_body)" stopped
  expect_contains cancel-stops "status comment" "$body" "The workflow was cancelled, so the agent run was stopped."
  local states
  states=$(backend_session_states "$runner" | tr '\n' ' ')
  if printf '%s' "$states" | grep -Eq 'running|pending|queued'; then
    record_check cancel-stops "backend session no longer running" "$states" fail
  else
    record_check cancel-stops "backend session no longer running" "${states:-none}" pass
  fi
  local comments
  comments=$(gh issue view "$CASE_ISSUE_NUMBER" --repo "$CANARY_REPO" --json comments --jq '[.comments[].body] | join("\n")')
  if [ -z "$(printf '%s\n' "$comments" | pr_number_from_comments || true)" ]; then
    record_check cancel-stops "no PR was opened" "none" pass
  else
    record_check cancel-stops "no PR was opened" "a PR is linked" fail
  fi
}
scenario_orphan_recovery() { not_implemented orphan-recovery; }
scenario_stop_command() { not_implemented stop-command; }
scenario_ask() { not_implemented ask; }

run_scenario() {
  local name="$1"
  local fn="scenario_${name//-/_}"
  : > "$CANARY_CHECKS_FILE"
  if ! declare -F "$fn" >/dev/null; then
    echo "::error::Unknown canary scenario: ${name}"
    return 1
  fi
  log "Running canary scenario ${name} against ${ACTION_REF}"
  pin_canary_workflow
  "$fn" || CANARY_FAILED=1
  {
    echo "### Scenario \`${name}\`"
    echo
    echo "| Case | Expectation | Observed | Result |"
    echo "| --- | --- | --- | --- |"
    cat "$CANARY_CHECKS_FILE"
  } >> "${GITHUB_STEP_SUMMARY:-/dev/null}"
  return "$CANARY_FAILED"
}
