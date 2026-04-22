const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { reconcileAgentState } = require('./state-reconciliation');

describe('reconcileAgentState', () => {
  it('returns start-new-run with none confidence for empty state', () => {
    const result = reconcileAgentState();
    assert.equal(result.runnerId, '');
    assert.equal(result.linkedPrNumber, '');
    assert.equal(result.agentRunUrl, '');
    assert.equal(result.confidence, 'none');
    assert.equal(result.recoveryAction, 'start-new-run');
    assert.deepEqual(result.sessionDataMap, {});
    assert.deepEqual(result.warnings, []);
  });

  it('prefers status comment runner over PR body runner', () => {
    const result = reconcileAgentState({
      isPr: true,
      statusCommentBody: '<!-- netlify-agent-runner-id:status-runner -->',
      prBody: '<!-- netlify-agent-runner-id:pr-runner -->',
      siteName: 'my-site',
    });

    assert.equal(result.runnerId, 'status-runner');
    assert.equal(
      result.agentRunUrl,
      'https://app.netlify.com/projects/my-site/agent-runs/status-runner'
    );
    assert.equal(result.confidence, 'high');
    assert.equal(result.recoveryAction, 'resume-runner');
    assert.ok(result.warnings.some(w => w.includes('different runner IDs')));
  });

  it('uses PR body runner when status comment has no runner marker', () => {
    const result = reconcileAgentState({
      isPr: true,
      statusCommentBody: 'no runner marker',
      prBody: '<!-- netlify-agent-runner-id:from-pr -->',
    });
    assert.equal(result.runnerId, 'from-pr');
    assert.equal(result.recoveryAction, 'resume-runner');
    assert.equal(result.confidence, 'high');
  });

  it('treats malformed status session marker as warning and safe fallback', () => {
    const result = reconcileAgentState({
      statusCommentBody: '<!-- netlify-agent-session-data:{not-json} -->',
      existingSessionDataOutput: '{"session-1":{"gh_action_url":"https://github.com/o/r/actions/runs/1"}}',
    });

    assert.deepEqual(result.sessionDataMap, {});
    assert.ok(result.warnings.some(w => w.includes('malformed netlify-agent-session-data marker')));
    assert.equal(result.recoveryAction, 'manual-review');
  });

  it('detects linked PR from plain text reference', () => {
    const result = reconcileAgentState({
      isPr: false,
      statusCommentBody: 'Changes in Pull Request #123',
    });
    assert.equal(result.linkedPrNumber, '123');
    assert.equal(result.recoveryAction, 'redirect-to-pr');
  });

  it('detects linked PR from markdown URL', () => {
    const result = reconcileAgentState({
      isPr: false,
      statusCommentBody: 'Changes in [Pull Request](https://github.com/netlify-labs/agent-runner-action-example/pull/88)',
    });
    assert.equal(result.linkedPrNumber, '88');
    assert.equal(result.recoveryAction, 'redirect-to-pr');
  });

  it('does not throw on unknown/legacy marker formats', () => {
    assert.doesNotThrow(() => {
      reconcileAgentState({
        statusCommentBody: '<!-- legacy-runner:123 -->\n<!-- unknown-marker -->',
        prBody: '<!-- netlify-agent-runner-id:old-runner',
      });
    });
  });

  it('reconstructs run URL when site and runner are available from outputs', () => {
    const result = reconcileAgentState({
      existingRunnerIdOutput: 'runner-555',
      siteName: 'example-site',
      contextOutputs: { 'linked-pr-number': '21' },
    });

    assert.equal(result.runnerId, 'runner-555');
    assert.equal(result.agentRunUrl, 'https://app.netlify.com/projects/example-site/agent-runs/runner-555');
    assert.equal(result.confidence, 'medium');
    assert.equal(result.recoveryAction, 'resume-runner');
    assert.equal(result.linkedPrNumber, '21');
  });
});
