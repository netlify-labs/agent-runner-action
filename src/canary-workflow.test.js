const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..');
const WORKFLOW_PATH = path.join(REPO_ROOT, '.github', 'workflows', 'canary.yml');
const workflow = fs.readFileSync(WORKFLOW_PATH, 'utf8');

describe('programmatic canary workflow', () => {
  it('targets the canonical canary repository by default', () => {
    assert.match(workflow, /default:\s+'netlify-labs\/agent-runner-action-canary'/);
  });

  it('requires an explicit cross-repository token', () => {
    assert.match(workflow, /CANARY_REPO_TOKEN/);
    assert.match(workflow, /Missing CANARY_REPO_TOKEN secret/);
  });

  it('updates the canary workflow pin before creating a test issue', () => {
    assert.match(workflow, /netlify-labs\/agent-runner-action@/);
    assert.match(workflow, /git push origin HEAD:main/);
    assert.match(workflow, /gh issue create/);
  });

  it('waits for the issue-triggered workflow and verifies a PR diff marker', () => {
    assert.match(workflow, /gh run list/);
    assert.match(workflow, /gh run view/);
    assert.match(workflow, /gh pr diff/);
    assert.match(workflow, /Canary PR .* did not contain marker/);
  });
});
