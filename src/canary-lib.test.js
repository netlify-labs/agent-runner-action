// Executes the pure helpers of scripts/canary-lib.sh with fixture input.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const LIB = path.join(__dirname, '..', 'scripts', 'canary-lib.sh');

/**
 * @param {string} script bash to run after sourcing the library
 * @param {{ input?: string, env?: Record<string, string> }} [options]
 */
function bash(script, options = {}) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'canary-lib-'));
  try {
    const result = spawnSync('bash', ['-c', `source "${LIB}"\n${script}`], {
      input: options.input || '',
      encoding: 'utf8',
      env: { ...process.env, RUNNER_TEMP: temp, GITHUB_OUTPUT: path.join(temp, 'out'), GITHUB_STEP_SUMMARY: path.join(temp, 'summary'), ...(options.env || {}) },
    });
    const read = (/** @type {string} */ name) => (fs.existsSync(path.join(temp, name)) ? fs.readFileSync(path.join(temp, name), 'utf8') : '');
    return { status: result.status, stdout: result.stdout, stderr: result.stderr, checks: read('canary-checks.md'), output: read('out'), summary: read('summary') };
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

describe('canary-lib helpers', () => {
  it('finds the PR number from status or result comments', () => {
    const comments = 'Netlify Agent Run Status\n[Agent run](https://app.netlify.com/x) | [Pull Request](https://github.com/o/r/pull/84)';
    assert.equal(bash('pr_number_from_comments', { input: comments }).stdout.trim(), '84');
    assert.equal(bash('pr_number_from_comments', { input: 'Pull Request #12 opened' }).stdout.trim(), '12');
    assert.equal(bash('pr_number_from_comments', { input: 'no links here' }).stdout.trim(), '');
  });

  it('reads the checkpoint state from a status comment', () => {
    const body = 'status\n<!-- netlify-agent-run-checkpoint:{"v":1,"state":"stop-pending","runnerId":"r1"} -->\n<!-- netlify-agent-run-status -->';
    assert.equal(bash('checkpoint_state_from_body', { input: body }).stdout.trim(), 'stop-pending');
    assert.equal(bash('checkpoint_state_from_body', { input: 'no checkpoint' }).stdout.trim(), '');
  });

  it('records passing and failing checks in the summary table and flags failure', () => {
    const result = bash([
      'expect_contains c1 "comment" "hello world" "world"',
      'expect_not_contains c2 "comment" "hello" "Review"',
      'expect_equal c3 "conclusion" "failure" "success"',
      'echo "failed=$CANARY_FAILED"',
    ].join('\n'));
    assert.match(result.checks, /\| c1 \| comment contains `world` \| found \| ✅ \|/);
    assert.match(result.checks, /\| c2 \| comment does not contain `Review` \| absent \| ✅ \|/);
    assert.match(result.checks, /\| c3 \| conclusion is `success` \| `failure` \| ❌ \|/);
    assert.match(result.stdout, /::error title=Canary check failed::c3/);
    assert.match(result.stdout, /failed=1/);
  });

  it('rejects unknown scenarios and fails fast for unimplemented ones', () => {
    const unknown = bash('run_scenario nope; echo "status=$?"');
    assert.match(unknown.stdout, /::error::Unknown canary scenario: nope/);
    assert.match(unknown.stdout, /status=1/);
    // Stub out the network-touching pin step for the unimplemented case.
    const stub = bash('pin_canary_workflow() { log pinned; }\nscenario_ask() { not_implemented ask; }\nrun_scenario ask; echo "status=$?"');
    assert.match(stub.stdout, /status=1/);
    assert.match(stub.summary, /### Scenario `ask`/);
    assert.match(stub.summary, /\| ask \| scenario is implemented \| not implemented yet \| ❌ \|/);
  });

  it('maps every documented scenario name to a function', () => {
    const names = ['default', 'scope-creep', 'cancel-stops', 'orphan-recovery', 'stop-command', 'ask'];
    const result = bash(names.map((name) => `declare -F "scenario_${name.replace(/-/g, '_')}" >/dev/null && echo ok-${name}`).join('\n'));
    for (const name of names) assert.match(result.stdout, new RegExp(`ok-${name}`), name);
  });
});

describe('canary-lib checkpoint helpers', () => {
  it('extracts the checkpoint runner id', () => {
    const body = '<!-- netlify-agent-run-checkpoint:{"v":1,"state":"running","runnerId":"6ab5de0c2660172e9b17b86f"} -->';
    assert.equal(bash('checkpoint_runner_from_body', { input: body }).stdout.trim(), '6ab5de0c2660172e9b17b86f');
    assert.equal(bash('checkpoint_runner_from_body', { input: 'none' }).stdout.trim(), '');
  });

  it('reports backend state as unknown without a token', () => {
    assert.equal(bash('backend_session_states r1', { env: { NETLIFY_AUTH_TOKEN: '' } }).stdout.trim(), 'unknown');
  });
});

describe('canary-lib orphan-recovery scenario', () => {
  // gh is stubbed: the orphaned job leaves a "running" checkpoint, the scan
  // dispatches run 900, and afterwards the thread shows the recovered result.
  const stub = String.raw`
start_issue_case() { CASE_ISSUE_NUMBER=7; CASE_ISSUE_URL=https://github.com/o/r/issues/7; CASE_RUN_ID=100; CASE_RUN_URL=u; }
wait_run_completed() { return 0; }
RECOVERED=0
status_comment_body() {
  if [ "$RECOVERED" = 1 ]; then echo '<!-- netlify-agent-run-checkpoint:{"v":1,"state":"finalized","runnerId":"r1"} -->'
  else echo '<!-- netlify-agent-run-checkpoint:{"v":1,"state":"running","runnerId":"r1"} -->'; fi
}
gh() {
  case "$1 $2" in
    "workflow run") echo "dispatch $*" >&2; RECOVERED=1 ;;
    "run list") echo 900 ;;
    "run view") echo "$RESULT_CONCLUSION" ;;
    "issue view")
      if [ "$RECOVERED" = 1 ]; then printf '### Netlify Agent Run Completed · recovered\n\n@me, your earlier request finished.\n[Pull Request](https://github.com/o/r/pull/9)\n'
      else echo 'status only'; fi ;;
    "pr diff") echo "+Canary marker: $RUN_MARKER" ;;
  esac
}
sleep() { :; }
`;

  it('passes when the scan dispatches a recovery that lands the PR', () => {
    const result = bash(`${stub}\nscenario_orphan_recovery; echo "status=$? failed=$CANARY_FAILED"`, { env: { RUN_MARKER: 'm1', RESULT_CONCLUSION: 'success', CANARY_REPO: 'o/r', CANARY_WORKFLOW_NAME: 'w' } });
    assert.match(result.stdout, /failed=0/, result.checks);
    assert.match(result.stderr, /dispatch workflow run netlify-agents-recover\.yml/);
    assert.match(result.checks, /checkpoint left by the orphaned job is `running`/);
    assert.match(result.checks, /\| orphan-recovery \| recovery lands a PR \| #9 \| ✅ \|/);
    assert.match(result.output, /recover-run-url=https:\/\/github.com\/o\/r\/actions\/runs\/900/);
  });

  it('fails when the recover run fails', () => {
    const result = bash(`${stub}\nscenario_orphan_recovery; echo "failed=$CANARY_FAILED"`, { env: { RUN_MARKER: 'm1', RESULT_CONCLUSION: 'failure', CANARY_REPO: 'o/r', CANARY_WORKFLOW_NAME: 'w' } });
    assert.match(result.stdout, /failed=1/);
    assert.match(result.checks, /recover run conclusion is `success` \| `failure` \| ❌/);
  });
});


describe('canary-lib stop-command scenario', () => {
  const stub = String.raw`
start_issue_case() { CASE_ISSUE_NUMBER=7; CASE_ISSUE_URL=https://github.com/o/r/issues/7; CASE_RUN_ID=100; CASE_RUN_URL=u; }
wait_run_completed() { [ "$1" = 100 ] && OWNER_DONE=1; return 0; }
OWNER_DONE=0
status_comment_body() {
  if [ "$OWNER_DONE" = 1 ]; then printf 'Stopped by @me.\n<!-- netlify-agent-run-checkpoint:{"v":1,"state":"stopped","runnerId":"r1"} -->'
  else echo '<!-- netlify-agent-run-checkpoint:{"v":1,"state":"running","runnerId":"r1"} -->'; fi
}
gh() {
  case "$1 $2" in
    "issue comment") echo "commented $*" >&2 ;;
    "run list") echo 900 ;;
    "run view")
      case "$*" in
        *conclusion*) echo success ;;
        *) if [ "$OWNER_DONE" = 1 ]; then echo completed; else echo "$OWNER_STATUS"; fi ;;
      esac ;;
    "issue view") printf '⏹ Stopping the agent run, requested by @me.\n' ;;
  esac
}
sleep() { :; }
backend_session_states() { echo stopped; }
`;
  it('passes when the stop runs alongside the owner and the owner reports it', () => {
    const result = bash(`${stub}\nscenario_stop_command; echo "failed=$CANARY_FAILED"`, { env: { RUN_MARKER: 'm1', OWNER_STATUS: 'in_progress', CANARY_REPO: 'o/r', CANARY_WORKFLOW_NAME: 'w' } });
    assert.match(result.stdout, /failed=0/, result.checks);
    assert.match(result.stderr, /commented issue comment 7 --repo o\/r --body @netlify stop/);
    assert.match(result.checks, /stop ran while the owner was still running \| owner in_progress \| ✅/);
  });
  it('fails when the stop only ran after the owner finished (stop queued behind it)', () => {
    const result = bash(`${stub}\nscenario_stop_command; echo "failed=$CANARY_FAILED"`, { env: { RUN_MARKER: 'm1', OWNER_STATUS: 'completed', CANARY_REPO: 'o/r', CANARY_WORKFLOW_NAME: 'w' } });
    assert.match(result.stdout, /failed=1/);
  });
});

describe('canary-lib ask scenario', () => {
  const stub = String.raw`
run_issue_case() { CASE_ISSUE_NUMBER=7; CASE_ISSUE_URL=u; CASE_RUN_URL=u; CASE_CONCLUSION=success; CASE_PR_NUMBER="$PR"; CASE_COMMENTS=$(printf '### [Run #1 | codex | Agent Run answered](x) 💬\n\n### Answer\n\ndocs/index.html is the main page.'); }
status_comment_body() { printf '💬 Answered.\n<!-- netlify-agent-run-checkpoint:{"v":1,"state":"finalized","runnerId":"r1","mode":"ask"} -->'; }
backend_session_modes() { echo ask; }
`;
  it('passes for an answered question with no PR', () => {
    const result = bash(`${stub}\nscenario_ask; echo "failed=$CANARY_FAILED"`, { env: { RUN_MARKER: 'm1', PR: '' } });
    assert.match(result.stdout, /failed=0/, result.checks);
  });
  it('fails when a PR was opened', () => {
    const result = bash(`${stub}\nscenario_ask; echo "failed=$CANARY_FAILED"`, { env: { RUN_MARKER: 'm1', PR: '9' } });
    assert.match(result.stdout, /failed=1/);
    assert.match(result.checks, /no PR was opened \| #9 \| ❌/);
  });
});

describe('canary-lib pin_canary_workflow', () => {
  // gh clone is stubbed to create a local repo; git push to a bare remote
  // fails on the first attempt (a racing canary), then succeeds.
  it('retries a rejected push and pins every workflow that uses the action', () => {
    const script = String.raw`
REMOTE="$RUNNER_TEMP/remote.git"
git init -q --bare "$REMOTE"
seed="$RUNNER_TEMP/seed"; git init -q "$seed"; mkdir -p "$seed/.github/workflows"
printf 'uses: netlify-labs/agent-runner-action@old\n' > "$seed/.github/workflows/netlify-agents.yml"
printf 'uses: netlify-labs/agent-runner-action@old\n' > "$seed/.github/workflows/netlify-agents-recover.yml"
printf 'name: other\n' > "$seed/.github/workflows/cleanup.yml"
git -C "$seed" -c user.email=a@b -c user.name=a add -A; git -C "$seed" -c user.email=a@b -c user.name=a commit -qm seed; git -C "$seed" push -q "$REMOTE" HEAD:main
gh() { git clone -q --branch main "$REMOTE" "$4"; }
git() {
  if [ "$1" = remote ]; then return 0; fi
  if [ "$1" = push ]; then n=$(( $(cat "$RUNNER_TEMP/attempts" 2>/dev/null || echo 0) + 1 )); echo "$n" > "$RUNNER_TEMP/attempts"; [ "$n" -lt 2 ] && return 1; command git push -q "$REMOTE" HEAD:main; return $?; fi
  command git "$@"
}
sleep() { :; }
CANARY_REPO=o/r CANARY_WORKFLOW_PATH=.github/workflows/netlify-agents.yml ACTION_REF=newsha pin_canary_workflow; echo "status=$?"
command git -C "$seed" pull -q "$REMOTE" main
cat "$seed/.github/workflows/netlify-agents.yml" "$seed/.github/workflows/netlify-agents-recover.yml"
`;
    const result = bash(script);
    assert.match(result.stdout, /status=0/, result.stdout + result.stderr);
    assert.match(result.stdout, /Pin push was rejected \(attempt 1\); retrying\./);
    assert.equal((result.stdout.match(/agent-runner-action@newsha/g) || []).length, 2, result.stdout);
  });
});
