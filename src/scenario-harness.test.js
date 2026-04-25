const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { runScenario } = require('./scenario-harness');

describe('scenario harness', () => {
  it('covers new issue trigger path and summary output', async () => {
    const trace = await runScenario({
      name: 'issue-opened body trigger',
      eventName: 'issues',
      eventFixture: 'fixtures/events/issue-opened-body-trigger.json',
      env: {
        DEFAULT_MODEL: 'codex',
        OUTCOME: 'success',
        SITE_NAME: 'agent-runner-action-example',
        AGENT_ID: 'runner-abc123',
      },
      commentMode: 'success',
    });

    assert.equal(trace.outputs['should-run'], 'true');
    assert.equal(trace.outputs['is-pr'], 'false');
    assert.equal(trace.outputs.agent, 'codex');
    assert.equal(trace.outputs.model, 'codex');
    assert.equal(trace.failures.length, 0);
    assert.ok(trace.summary.includes('# Netlify Agent Runners'));
    assert.ok(trace.summary.includes('| Outcome | success |'));
    assert.ok(trace.comments.length > 0);
  });

  it('covers PR follow-up issue comment with recovered PR context', async () => {
    const trace = await runScenario({
      name: 'issue-comment on PR follow-up',
      eventName: 'issue_comment',
      eventFixture: 'fixtures/events/issue-comment-on-pr.json',
      githubFixtures: {
        'issues.getComment': 'fixtures/github/existing-status-comment-with-runner.json',
        'pulls.get': 'fixtures/github/pr-body-with-runner-marker.json',
      },
      env: {
        OUTCOME: 'success',
        SITE_NAME: 'agent-runner-action-example',
      },
      runExtractAgentId: true,
      extractInputs: {
        commentId: '7001',
      },
      commentMode: 'none',
    });

    assert.equal(trace.outputs['should-run'], 'true');
    assert.equal(trace.outputs['is-pr'], 'true');
    assert.equal(trace.outputs['pr-number'], '58');
    assert.equal(trace.outputs['head-ref'], 'feature/workflow-fixes');
    assert.equal(trace.state.reconciled.runnerId, 'runner-abc123');
  });

  it('ignores unrelated cross-referenced pull requests for issue comments on issues', async () => {
    const trace = await runScenario({
      name: 'issue comment with unrelated cross-reference',
      eventName: 'issue_comment',
      eventFixture: 'fixtures/events/issue-comment-on-issue.json',
      githubFixtures: {
        'issues.listEventsForTimeline': 'fixtures/github/timeline-linked-pr.json',
      },
      env: {
        OUTCOME: 'success',
      },
      commentMode: 'none',
    });

    assert.equal(trace.outputs['should-run'], 'true');
    assert.equal(trace.outputs['is-pr'], 'false');
    assert.equal(trace.outputs['has-linked-pr'], 'false');
    assert.equal(trace.outputs['linked-pr-number'], '');
    assert.equal(trace.state.reconciled.linkedPrNumber, '');
    assert.equal(trace.state.reconciled.recoveryAction, 'start-new-run');
  });

  it('redirects issue follow-ups only when the status comment records a linked PR', async () => {
    const trace = await runScenario({
      name: 'issue comment with action-owned linked PR',
      eventName: 'issue_comment',
      eventFixture: 'fixtures/events/issue-comment-on-issue.json',
      githubFixtures: {
        'issues.getComment': 'fixtures/github/existing-status-comment-with-linked-pr.json',
      },
      env: {
        OUTCOME: 'success',
      },
      runExtractAgentId: true,
      commentMode: 'none',
    });

    assert.equal(trace.outputs['should-run'], 'true');
    assert.equal(trace.outputs['is-pr'], 'false');
    assert.equal(trace.outputs['has-linked-pr'], 'true');
    assert.equal(trace.outputs['linked-pr-number'], '58');
    assert.equal(trace.state.reconciled.linkedPrNumber, '58');
    assert.equal(trace.state.reconciled.recoveryAction, 'redirect-to-pr');
  });

  it('covers workflow_dispatch explicit agent selection', async () => {
    const trace = await runScenario({
      name: 'workflow dispatch explicit agent',
      eventName: 'workflow_dispatch',
      eventFixture: 'fixtures/events/workflow-dispatch.json',
      env: {
        DEFAULT_MODEL: 'codex',
        OUTCOME: 'success',
      },
      commentMode: 'none',
    });

    assert.equal(trace.outputs['should-run'], 'true');
    assert.equal(trace.outputs.agent, 'gemini');
    assert.equal(trace.outputs.model, 'gemini');
  });

  it('covers bot sender skip guardrail', async () => {
    const trace = await runScenario({
      name: 'bot comment skip',
      eventName: 'issue_comment',
      eventFixture: 'fixtures/events/bot-comment.json',
      env: {
        OUTCOME: 'skipped',
      },
      commentMode: 'none',
    });

    assert.equal(trace.outputs['should-run'], 'false');
    assert.equal(trace.comments.length, 0);
  });

  it('covers untrusted fork PR skip guardrail', async () => {
    const trace = await runScenario({
      name: 'untrusted fork skip',
      eventName: 'pull_request_target',
      eventFixture: 'fixtures/events/fork-pr-untrusted.json',
      githubFixtures: {
        'repos.getCollaboratorPermissionLevel': 'fixtures/github/collaborator-read.json',
      },
      env: {
        OUTCOME: 'skipped',
      },
      commentMode: 'none',
    });

    assert.equal(trace.outputs['should-run'], 'false');
  });

  it('handles malformed session marker with safe fallback warning', async () => {
    const trace = await runScenario({
      name: 'malformed marker fallback',
      eventName: 'issue_comment',
      eventFixture: 'fixtures/events/issue-comment-on-issue.json',
      githubFixtures: {
        'issues.getComment': 'fixtures/github/existing-status-comment-malformed-session-data.json',
      },
      env: {
        OUTCOME: 'failure',
      },
      runExtractAgentId: true,
      extractInputs: {
        commentId: '7002',
      },
      commentMode: 'failure',
    });

    assert.ok(
      trace.warnings.some(warning => warning.includes('malformed netlify-agent-session-data marker')),
      'expected malformed marker warning in trace'
    );
    assert.deepEqual(trace.state.reconciled.sessionDataMap, {});
    assert.ok(trace.comments[0].includes('<!-- netlify-agent-run-status -->'));
  });

  it('warns when seeded existing session data output is malformed', async () => {
    const trace = await runScenario({
      name: 'missing session data warning',
      eventName: 'issues',
      eventFixture: 'fixtures/events/issue-opened-body-trigger.json',
      seedOutputs: {
        'session-data-map': '{broken-json',
      },
      env: {
        OUTCOME: 'success',
      },
      commentMode: 'none',
    });

    assert.ok(
      trace.warnings.some(warning => warning.includes('existing session data output is malformed JSON')),
      'expected malformed existing output warning'
    );
    assert.deepEqual(trace.state.reconciled.sessionDataMap, {});
    assert.equal(trace.state.reconciled.recoveryAction, 'manual-review');
  });

  it('maps model unavailable fixture to failure taxonomy category', async () => {
    const trace = await runScenario({
      name: 'model unavailable taxonomy mapping',
      eventName: 'issue_comment',
      eventFixture: 'fixtures/events/issue-comment-on-issue.json',
      netlifyFixtures: {
        'agent.create': 'fixtures/netlify/agent-create-model-unavailable.json',
      },
      env: {
        OUTCOME: 'failure',
      },
      commentMode: 'none',
    });

    assert.equal(trace.failures.length, 1);
    assert.equal(trace.failures[0].category, 'agent-unavailable');
    assert.ok(trace.summary.includes('`agent-unavailable`'));
  });

  it('maps timeout runs to taxonomy and summary timeout section', async () => {
    const trace = await runScenario({
      name: 'timeout taxonomy mapping',
      eventName: 'issues',
      eventFixture: 'fixtures/events/issue-opened-title-trigger.json',
      env: {
        OUTCOME: 'timeout',
        TIMEOUT_MINUTES: '15',
      },
      timeoutMinutes: 15,
      commentMode: 'none',
    });

    assert.equal(trace.failures.length, 1);
    assert.equal(trace.failures[0].category, 'agent-timeout');
    assert.ok(trace.summary.includes('Timeout: run did not complete within 15 minutes.'));
    assert.ok(trace.summary.includes('## Failure'));
  });

  it('covers preflight-only plus dry-run warning with no-agent summary output', async () => {
    const trace = await runScenario({
      name: 'preflight-only no-agent summary',
      eventName: 'workflow_dispatch',
      eventFixture: 'fixtures/events/workflow-dispatch.json',
      env: {
        OUTCOME: 'skipped',
        DRY_RUN: 'true',
        IS_PREFLIGHT_ONLY: 'true',
      },
      preflight: {
        ok: true,
        checks: [
          { id: 'netlify-auth-token', status: 'pass', message: 'Token input is present.' },
          { id: 'netlify-site-id', status: 'pass', message: 'Site ID input is present.' },
        ],
        warnings: ['Both dry-run=true and preflight-only=true were set; preflight-only takes precedence.'],
        failures: [],
      },
      commentMode: 'none',
    });

    assert.equal(trace.outputs['should-run'], 'true');
    assert.equal(trace.failures.length, 0);
    assert.equal(trace.comments.length, 0);
    assert.ok(trace.summary.includes('Preview mode: no commit or pull request creation is performed.'));
    assert.ok(trace.summary.includes('Preflight-only mode: configuration was validated without starting an agent run.'));
    assert.ok(trace.summary.includes('Both dry-run=true and preflight-only=true were set; preflight-only takes precedence.'));
    assert.ok(trace.summary.includes('| Runner ID | n/a |'));
    assert.ok(trace.summary.includes('| Dashboard | n/a |'));
  });

  it('renders preflight failure details alongside failure taxonomy summary', async () => {
    const trace = await runScenario({
      name: 'preflight failure summary',
      eventName: 'workflow_dispatch',
      eventFixture: 'fixtures/events/workflow-dispatch.json',
      env: {
        OUTCOME: 'failure',
        IS_PREFLIGHT_ONLY: 'true',
      },
      failureSignal: {
        category: 'missing-site-id',
        stage: 'validate-env',
        error: 'Missing netlify-site-id input.',
      },
      preflight: {
        ok: false,
        checks: [
          { id: 'netlify-auth-token', status: 'pass', message: 'Token input is present.' },
          { id: 'netlify-site-id', status: 'fail', message: 'Missing netlify-site-id input.' },
        ],
        warnings: [],
        failures: ['missing-site-id'],
      },
      commentMode: 'none',
    });

    assert.equal(trace.failures.length, 1);
    assert.equal(trace.failures[0].category, 'missing-site-id');
    assert.ok(trace.summary.includes('## Failure'));
    assert.ok(trace.summary.includes('`missing-site-id`'));
    assert.ok(trace.summary.includes('## Preflight Checks'));
    assert.ok(trace.summary.includes('| netlify-site-id | fail | Missing netlify-site-id input. |'));
    assert.ok(trace.summary.includes('Failures:'));
    assert.ok(trace.summary.includes('- missing-site-id'));
  });
});
