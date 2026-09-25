const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..');
const WORKFLOW_PATH = path.join(REPO_ROOT, '.github', 'workflows', 'canary.yml');
const workflow = fs.readFileSync(WORKFLOW_PATH, 'utf8');
// Scenario logic lives in scripts/canary-lib.sh, sourced by canary.yml.
const lib = fs.readFileSync(path.join(REPO_ROOT, 'scripts', 'canary-lib.sh'), 'utf8');

describe('programmatic canary workflow', () => {
  it('runs on pull requests that touch the action or source code', () => {
    assert.match(workflow, /pull_request:\n\s+paths:\n\s+- 'action\.yml'\n\s+- 'action\.yaml'\n\s+- 'src\/\*\*'/);
  });

  it('targets the canonical canary repository by default', () => {
    assert.match(workflow, /default:\s+'netlify-labs\/agent-runner-action-canary'/);
    assert.match(workflow, /CANARY_REPO: \$\{\{ inputs\.canary_repo \|\| 'netlify-labs\/agent-runner-action-canary' \}\}/);
    assert.match(workflow, /TIMEOUT_MINUTES: \$\{\{ inputs\.timeout_minutes \|\| '20' \}\}/);
  });

  it('requires an explicit cross-repository token', () => {
    assert.match(workflow, /CANARY_REPO_TOKEN/);
    assert.match(workflow, /Missing CANARY_REPO_TOKEN secret/);
  });

  it('supports a manual simulated failure path', () => {
    assert.match(workflow, /simulate_failure:/);
    assert.match(workflow, /SIMULATE_FAILURE: \$\{\{ github\.event_name == 'workflow_dispatch' && inputs\.simulate_failure \|\| 'false' \}\}/);
    assert.match(workflow, /Simulated canary failure requested after successful downstream verification/);
  });

  it('optionally notifies Slack when the canary controller fails', () => {
    assert.match(workflow, /name: Notify Slack on canary failure/);
    assert.match(workflow, /if: failure\(\)/);
    assert.match(workflow, /SLACK_WEBHOOK_URL: \$\{\{ secrets\.SLACK_WEBHOOK_URL \}\}/);
    assert.match(workflow, /No SLACK_WEBHOOK_URL configured; skipping Slack notification/);
    assert.match(workflow, /curl -fsS -X POST -H 'Content-Type: application\/json'/);
  });

  it('updates the canary workflow pin before creating a test issue', () => {
    assert.match(workflow, /PR_ACTION_REF: \$\{\{ github\.event_name == 'pull_request' && github\.event\.pull_request\.head\.sha \|\| '' \}\}/);
    assert.match(workflow, /ACTION_REF="\$\{PR_ACTION_REF:-\$GITHUB_SHA\}"/);
    assert.match(workflow, /source scripts\/canary-lib\.sh\n\s+run_scenario "\$SCENARIO"/);
    assert.match(lib, /netlify-labs\/agent-runner-action@/);
    assert.match(lib, /in README\.md, replace or add one line exactly/);
    assert.match(lib, /Do not edit other files/);
    assert.match(lib, /x-access-token:\$\{GH_TOKEN\}@github\.com\/\$\{CANARY_REPO\}\.git/);
    assert.match(lib, /git push origin HEAD:main/);
    assert.match(lib, /gh issue create/);
    // The pin happens before any scenario creates issues.
    const runScenario = lib.slice(lib.indexOf('run_scenario() {'));
    assert.ok(runScenario.indexOf('pin_canary_workflow') < runScenario.indexOf('"$fn" ||'));
  });

  it('waits for the issue-triggered workflow and verifies a PR diff marker', () => {
    assert.match(lib, /gh run list/);
    assert.match(lib, /gh run view/);
    assert.match(lib, /gh pr diff/);
    assert.match(lib, /PR diff contains the marker/);
  });

  it('defaults to the default scenario for PR and release canaries', () => {
    assert.match(workflow, /SCENARIO: \$\{\{ inputs\.scenario \|\| 'default' \}\}/);
    assert.equal((workflow.match(/^      scenario:$/gm) || []).length, 2, 'scenario input on dispatch and workflow_call');
  });
});
