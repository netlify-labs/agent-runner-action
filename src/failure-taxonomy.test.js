const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { FAILURE_CATEGORIES } = require('./contracts');
const { FAILURE_TAXONOMY, detectFailureCategory, classifyFailure } = require('./failure-taxonomy');

describe('failure taxonomy coverage', () => {
  it('defines a profile for every declared failure category', () => {
    for (const category of FAILURE_CATEGORIES) {
      assert.ok(FAILURE_TAXONOMY[category], `missing taxonomy profile for ${category}`);
      assert.ok(FAILURE_TAXONOMY[category].title.length > 0);
      assert.ok(FAILURE_TAXONOMY[category].summary.length > 0);
      assert.ok(Array.isArray(FAILURE_TAXONOMY[category].remediation));
    }
  });
});

describe('detectFailureCategory', () => {
  it('detects each required category from representative signals', () => {
    /** @type {{category: string, signal: Record<string, unknown>}[]} */
    const cases = [
      {
        category: 'missing-auth-token',
        signal: { error: 'Missing netlify-auth-token input from NETLIFY_AUTH_TOKEN secret' },
      },
      {
        category: 'missing-site-id',
        signal: { error: 'Missing netlify-site-id input from NETLIFY_SITE_ID secret' },
      },
      {
        category: 'site-lookup-failed',
        signal: { stage: 'resolve-site', error: 'getSite attempt 1 failed: site not found' },
      },
      {
        category: 'netlify-cli-missing',
        signal: { error: '/bin/bash: netlify: command not found while running agents:create' },
      },
      {
        category: 'netlify-cli-install-failed',
        signal: { error: 'bun install -g netlify-cli failed with exit code 1' },
      },
      {
        category: 'agent-unavailable',
        signal: { error: 'Agent Runner Claude is not available right now' },
      },
      {
        category: 'agent-unavailable',
        signal: { errorMessage: 'Agent Runner codex is not available for this account' },
      },
      {
        category: 'agent-create-failed',
        signal: { stage: 'create-agent', error: 'Failed to create agent task' },
      },
      {
        category: 'session-create-failed',
        signal: { stage: 'create-session', error: 'Failed to create follow-up session after 3 attempts' },
      },
      {
        category: 'agent-timeout',
        signal: { outcome: 'timeout', error: 'Agent timed out after 600s' },
      },
      {
        category: 'agent-failed',
        signal: { stage: 'poll-agent', error: 'Agent finished with state: failed' },
      },
      {
        category: 'agent-failed',
        signal: { state: 'failed' },
      },
      {
        category: 'deploy-preview-unavailable',
        signal: { error: 'Deploy preview URL returned status 503' },
      },
      {
        category: 'commit-to-branch-failed',
        signal: { stage: 'commit', error: 'Commit error: merge_commit_error permission denied' },
      },
      {
        category: 'pull-request-create-failed',
        signal: { stage: 'create-pr', error: 'PR creation finished but no URL returned' },
      },
      {
        category: 'github-permission-denied',
        signal: { statusCode: 403, error: 'GitHub: Resource not accessible by integration' },
      },
      {
        category: 'github-api-failed',
        signal: { error: 'GitHub API request failed with status 500 on gh api repos/o/r/issues' },
      },
      {
        category: 'malformed-api-response',
        signal: { error: 'jq: parse error: Invalid numeric literal at line 1, column 6' },
      },
      {
        category: 'netlify-cli-missing',
        signal: { exitCode: 127, stderr: 'netlify: command not found' },
      },
      {
        category: 'unknown',
        signal: { error: 'A totally unrelated failure string' },
      },
    ];

    for (const testCase of cases) {
      assert.equal(
        detectFailureCategory(testCase.signal),
        testCase.category,
        `expected ${testCase.category}`
      );
    }
  });

  it('respects explicit valid category override', () => {
    const category = detectFailureCategory({
      category: 'agent-timeout',
      error: 'Missing netlify-auth-token input',
    });
    assert.equal(category, 'agent-timeout');
  });

  it('accepts legacy model-unavailable category overrides', () => {
    const category = detectFailureCategory({
      category: 'model-unavailable',
      error: 'Agent Runner codex is not available right now',
    });
    assert.equal(category, 'model-unavailable');
  });
});

describe('classifyFailure', () => {
  it('returns actionable fields for required high-value scenarios', () => {
    /** @type {{name: string, signal: Record<string, unknown>, category: string, retryable: boolean, userActionRequired: boolean}[]} */
    const cases = [
      {
        name: 'missing auth token',
        signal: { error: 'Missing netlify-auth-token input from NETLIFY_AUTH_TOKEN secret' },
        category: 'missing-auth-token',
        retryable: false,
        userActionRequired: true,
      },
      {
        name: 'missing site id',
        signal: { error: 'Missing netlify-site-id input from NETLIFY_SITE_ID secret' },
        category: 'missing-site-id',
        retryable: false,
        userActionRequired: true,
      },
      {
        name: 'agent unavailable',
        signal: { error: 'Agent Runner codex is not available right now' },
        category: 'agent-unavailable',
        retryable: true,
        userActionRequired: false,
      },
      {
        name: 'no agent id from create',
        signal: { stage: 'create-agent', error: 'Failed to create agent task: no id returned' },
        category: 'agent-create-failed',
        retryable: true,
        userActionRequired: false,
      },
      {
        name: 'follow-up session retry exhaustion',
        signal: { stage: 'create-session', error: 'Failed to create follow-up session after 3 attempts' },
        category: 'session-create-failed',
        retryable: true,
        userActionRequired: false,
      },
      {
        name: 'timeout',
        signal: { outcome: 'timeout', error: 'Agent timed out after 600s' },
        category: 'agent-timeout',
        retryable: true,
        userActionRequired: false,
      },
      {
        name: 'pr create no url',
        signal: { stage: 'create-pr', error: 'PR creation finished but no URL returned' },
        category: 'pull-request-create-failed',
        retryable: true,
        userActionRequired: true,
      },
      {
        name: 'commit merge error',
        signal: { stage: 'commit', error: 'Commit error: merge_commit_error permission denied' },
        category: 'commit-to-branch-failed',
        retryable: true,
        userActionRequired: true,
      },
      {
        name: 'github 403 permission denied',
        signal: { statusCode: 403, error: 'GitHub: Resource not accessible by integration' },
        category: 'github-permission-denied',
        retryable: false,
        userActionRequired: true,
      },
      {
        name: 'github 404 permission denied',
        signal: { statusCode: 404, error: 'GitHub API returned 404 Resource not accessible by integration' },
        category: 'github-permission-denied',
        retryable: false,
        userActionRequired: true,
      },
      {
        name: 'malformed json',
        signal: { error: 'JSON parse error: invalid json payload' },
        category: 'malformed-api-response',
        retryable: true,
        userActionRequired: false,
      },
      {
        name: 'unknown fallback',
        signal: { error: 'some unexpected edge-case failure' },
        category: 'unknown',
        retryable: true,
        userActionRequired: false,
      },
    ];

    for (const testCase of cases) {
      const classification = classifyFailure(testCase.signal);
      assert.equal(classification.category, testCase.category, testCase.name);
      assert.equal(classification.retryable, testCase.retryable, `${testCase.name} retryability`);
      assert.equal(
        classification.userActionRequired,
        testCase.userActionRequired,
        `${testCase.name} userActionRequired`
      );
      assert.ok(classification.title.length > 0, `${testCase.name} title`);
      assert.ok(classification.summary.length > 0, `${testCase.name} summary`);
      assert.ok(classification.remediation.length > 0, `${testCase.name} remediation`);
    }
  });

  it('returns deterministic classification fields', () => {
    const classification = classifyFailure({
      stage: 'create-pr',
      error: 'PR creation finished but no URL returned',
    });

    assert.equal(classification.category, 'pull-request-create-failed');
    assert.equal(classification.stage, 'create-pr');
    assert.equal(typeof classification.title, 'string');
    assert.equal(typeof classification.summary, 'string');
    assert.ok(Array.isArray(classification.remediation));
    assert.equal(typeof classification.retryable, 'boolean');
    assert.equal(typeof classification.userActionRequired, 'boolean');
  });

  it('applies profile defaults for category-only calls', () => {
    const classification = classifyFailure({ category: 'agent-timeout' });
    assert.equal(classification.category, 'agent-timeout');
    assert.equal(classification.stage, 'poll-agent');
    assert.equal(classification.retryable, true);
    assert.equal(classification.userActionRequired, false);
  });

  it('supports explicit override of remediation and booleans', () => {
    const classification = classifyFailure({
      category: 'github-api-failed',
      remediation: ['Retry once'],
      retryable: false,
      userActionRequired: true,
    });

    assert.deepEqual(classification.remediation, ['Retry once']);
    assert.equal(classification.retryable, false);
    assert.equal(classification.userActionRequired, true);
  });

  it('accepts state and timeoutSeconds contract fields', () => {
    const timedOut = classifyFailure({
      stage: 'poll-agent',
      state: 'timeout',
      timeoutSeconds: 900,
      errorMessage: 'Agent timed out after 900s',
    });
    assert.equal(timedOut.category, 'agent-timeout');

    const failed = classifyFailure({
      stage: 'poll-agent',
      state: 'failed',
      errorMessage: 'Agent completed with failure',
    });
    assert.equal(failed.category, 'agent-failed');
  });
});
