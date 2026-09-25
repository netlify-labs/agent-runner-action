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
    const stub = bash('pin_canary_workflow() { log pinned; }\nrun_scenario ask; echo "status=$?"');
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
