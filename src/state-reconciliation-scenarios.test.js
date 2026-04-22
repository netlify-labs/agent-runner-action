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
  it('redirects issue flow to linked PR when timeline has cross-reference', () => {
    const eventFixture = readFixture('fixtures/events/issue-comment-on-issue.json');
    const timelineFixture = readFixture('fixtures/github/timeline-linked-pr.json');
    const linkedEvent = timelineFixture.find(entry => entry.event === 'cross-referenced');
    const linkedPrNumber = String(linkedEvent.source.issue.number);

    const reconciled = reconcileAgentState({
      isPr: false,
      statusCommentBody: '',
      prBody: '',
      issueTimelineLinkedPrNumber: linkedPrNumber,
      contextOutputs: {
        issueNumber: eventFixture.issue.number,
      },
    });

    assert.equal(reconciled.linkedPrNumber, linkedPrNumber);
    assert.equal(reconciled.recoveryAction, 'redirect-to-pr');
    assert.equal(reconciled.runnerId, '');
  });

  it('prefers resuming known runner over redirect when status state exists', () => {
    const statusFixture = readFixture('fixtures/github/existing-status-comment-with-runner.json');
    const timelineFixture = readFixture('fixtures/github/timeline-linked-pr.json');
    const linkedEvent = timelineFixture.find(entry => entry.event === 'cross-referenced');

    const reconciled = reconcileAgentState({
      isPr: false,
      statusCommentBody: statusFixture.data.body,
      issueTimelineLinkedPrNumber: String(linkedEvent.source.issue.number),
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
