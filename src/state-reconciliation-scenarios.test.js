const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { reconcileAgentState } = require('./state-reconciliation');

function readFixture(relativePath) {
  const fullPath = path.join(__dirname, '..', relativePath);
  return JSON.parse(fs.readFileSync(fullPath, 'utf8'));
}

describe('state reconciliation scenarios (fixture-backed)', () => {
  it('redirects issue flow when the status comment explicitly records a linked PR', () => {
    const eventFixture = readFixture('fixtures/events/issue-comment-on-issue.json');
    const statusFixture = readFixture('fixtures/github/existing-status-comment-with-linked-pr.json');

    const reconciled = reconcileAgentState({
      isPr: false,
      statusCommentBody: statusFixture.data.body,
      prBody: '',
      contextOutputs: {
        issueNumber: eventFixture.issue.number,
      },
    });

    assert.equal(reconciled.linkedPrNumber, '58');
    assert.equal(reconciled.recoveryAction, 'redirect-to-pr');
    assert.equal(reconciled.runnerId, '');
  });

  it('prefers resuming known runner when status state exists', () => {
    const statusFixture = readFixture('fixtures/github/existing-status-comment-with-runner.json');

    const reconciled = reconcileAgentState({
      isPr: false,
      statusCommentBody: statusFixture.data.body,
      siteName: 'agent-runner-action-example',
    });

    assert.equal(reconciled.runnerId, 'runner-abc123');
    assert.equal(reconciled.recoveryAction, 'resume-runner');
    assert.equal(reconciled.confidence, 'high');
    assert.equal(
      reconciled.agentRunUrl,
      'https://app.netlify.com/projects/agent-runner-action-example/agent-runs/runner-abc123'
    );
  });
});
