const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const contracts = require('./contracts');

describe('contracts COMMENT_MARKERS', () => {
  it('exports expected status/history marker literals', () => {
    assert.equal(contracts.COMMENT_MARKERS.status, '<!-- netlify-agent-run-status -->');
    assert.equal(contracts.COMMENT_MARKERS.history, '<!-- netlify-agent-run-history -->');
    assert.equal(contracts.COMMENT_MARKERS.runnerIdPrefix, '<!-- netlify-agent-runner-id:');
    assert.equal(contracts.COMMENT_MARKERS.sessionDataPrefix, '<!-- netlify-agent-session-data:');
  });

  it('keeps marker object immutable', () => {
    assert.equal(Object.isFrozen(contracts.COMMENT_MARKERS), true);
  });
});

describe('contracts category/stage/severity lists', () => {
  it('includes required failure categories', () => {
    const required = [
      'missing-auth-token',
      'missing-site-id',
      'site-lookup-failed',
      'netlify-cli-missing',
      'netlify-cli-install-failed',
      'model-unavailable',
      'agent-create-failed',
      'session-create-failed',
      'agent-timeout',
      'agent-failed',
      'deploy-preview-unavailable',
      'commit-to-branch-failed',
      'pull-request-create-failed',
      'github-permission-denied',
      'github-api-failed',
      'malformed-api-response',
      'unknown',
    ];
    for (const category of required) {
      assert.ok(
        contracts.FAILURE_CATEGORIES.includes(category),
        `missing category ${category}`
      );
    }
  });

  it('normalizes unknown values to stable defaults', () => {
    assert.equal(contracts.normalizeFailureCategory('made-up'), 'unknown');
    assert.equal(contracts.normalizeFailureStage('fake-stage'), 'unknown');
    assert.equal(contracts.normalizeFailureSeverity('panic'), 'error');
  });
});

describe('createFailureClassification', () => {
  it('returns stable defaults', () => {
    const result = contracts.createFailureClassification();
    assert.equal(result.category, 'unknown');
    assert.equal(result.title, 'Netlify Agent Runner failed');
    assert.equal(result.summary, 'The run failed before completion.');
    assert.deepEqual(result.remediation, []);
    assert.equal(result.severity, 'error');
    assert.equal(result.retryable, false);
    assert.equal(result.userActionRequired, true);
    assert.equal(result.stage, 'unknown');
  });

  it('normalizes nested override values', () => {
    const result = contracts.createFailureClassification({
      category: 'agent-timeout',
      severity: 'warning',
      stage: 'poll-agent',
      remediation: ['Try again'],
      retryable: true,
      userActionRequired: false,
    });
    assert.equal(result.category, 'agent-timeout');
    assert.equal(result.severity, 'warning');
    assert.equal(result.stage, 'poll-agent');
    assert.deepEqual(result.remediation, ['Try again']);
    assert.equal(result.retryable, true);
    assert.equal(result.userActionRequired, false);
  });
});

describe('createReconciledState', () => {
  it('returns expected reconciliation contract defaults', () => {
    const state = contracts.createReconciledState();
    assert.equal(state.runnerId, '');
    assert.deepEqual(state.sessionDataMap, {});
    assert.equal(state.linkedPrNumber, '');
    assert.equal(state.agentRunUrl, '');
    assert.equal(state.confidence, 'none');
    assert.deepEqual(state.sources, []);
    assert.deepEqual(state.warnings, []);
    assert.equal(state.recoveryAction, 'start-new-run');
  });
});

describe('createPreflightResult', () => {
  it('normalizes checks into stable check contracts', () => {
    const result = contracts.createPreflightResult({
      ok: true,
      checks: [
        { id: 'netlify-auth-token', status: 'pass', message: 'Token present' },
        { id: 'bogus', status: 'weird', message: 'bad status' },
      ],
      warnings: ['warn'],
      failures: ['fail'],
    });

    assert.equal(result.ok, true);
    assert.equal(result.checks[0].status, 'pass');
    assert.equal(result.checks[1].status, 'fail');
    assert.deepEqual(result.warnings, ['warn']);
    assert.deepEqual(result.failures, ['fail']);
  });
});

describe('createStepSummaryInput', () => {
  it('normalizes nested failure/preflight payloads', () => {
    const result = contracts.createStepSummaryInput({
      outcome: 'success',
      failure: {
        category: 'made-up',
        stage: 'weird',
        severity: 'panic',
      },
      preflight: {
        ok: true,
        checks: [{ id: 'site', status: 'pass', message: 'ok' }],
      },
    });

    assert.equal(result.outcome, 'success');
    assert.ok(result.failure);
    assert.equal(result.failure.category, 'unknown');
    assert.equal(result.failure.stage, 'unknown');
    assert.equal(result.failure.severity, 'error');
    assert.ok(result.preflight);
    assert.equal(result.preflight.ok, true);
    assert.equal(result.preflight.checks[0].id, 'site');
  });
});

describe('createScenarioTrace', () => {
  it('returns a deterministic trace shape', () => {
    const trace = contracts.createScenarioTrace({
      scenario: 'fixture:issue-opened',
      failures: [{ category: 'agent-failed', stage: 'poll-agent' }],
    });

    assert.equal(trace.scenario, 'fixture:issue-opened');
    assert.deepEqual(trace.outputs, {});
    assert.deepEqual(trace.logs, []);
    assert.deepEqual(trace.comments, []);
    assert.deepEqual(trace.state, {});
    assert.deepEqual(trace.warnings, []);
    assert.equal(trace.failures.length, 1);
    assert.equal(trace.failures[0].category, 'agent-failed');
    assert.equal(trace.failures[0].stage, 'poll-agent');
  });
});
