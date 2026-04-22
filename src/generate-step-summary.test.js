const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  escapeMarkdownTableValue,
  normalizeStepSummaryInput,
  renderStepSummary,
} = require('./generate-step-summary');

describe('renderStepSummary', () => {
  it('renders success run overview, agent, runner, and links', () => {
    const markdown = renderStepSummary({
      outcome: 'success',
      eventName: 'issue_comment',
      isPr: true,
      issueNumber: '42',
      model: 'codex',
      runnerId: 'runner-123',
      siteName: 'example-site',
      dashboardUrl: 'https://app.netlify.com/projects/example-site/agent-runs/runner-123',
      deployUrl: 'https://example-site.netlify.app',
      pullRequestUrl: 'https://github.com/o/r/pull/9',
      prompt: 'Build a landing page',
    });

    assert.ok(markdown.includes('| Outcome | success |'));
    assert.ok(markdown.includes('| Context | PR #42 |'));
    assert.ok(markdown.includes('| Agent | codex |'));
    assert.ok(markdown.includes('runner-123'));
    assert.ok(markdown.includes('[Open deploy](https://example-site.netlify.app)'));
    assert.ok(markdown.includes('[Open PR](https://github.com/o/r/pull/9)'));
  });

  it('renders failure category and remediation', () => {
    const markdown = renderStepSummary({
      outcome: 'failure',
      eventName: 'issue_comment',
      issueNumber: '11',
      failureCategory: 'agent-timeout',
      failureStage: 'poll-agent',
      agentError: 'Agent timed out after 600s',
    });

    assert.ok(markdown.includes('## Failure'));
    assert.ok(markdown.includes('`agent-timeout`'));
    assert.ok(markdown.includes('Retryable:** yes'));
    assert.ok(markdown.includes('Suggested next steps:'));
    assert.ok(markdown.includes('Increase `timeout-minutes`'));
  });

  it('includes timeout duration when provided', () => {
    const markdown = renderStepSummary({
      outcome: 'timeout',
      timeoutMinutes: 15,
    });

    assert.ok(markdown.includes('Timeout: run did not complete within 15 minutes.'));
  });

  it('explains dry-run mode behavior', () => {
    const markdown = renderStepSummary({
      outcome: 'success',
      isDryRun: true,
    });

    assert.ok(markdown.includes('Preview mode: no commit or pull request creation is performed.'));
  });

  it('renders preflight-only checks and explanation', () => {
    const markdown = renderStepSummary({
      outcome: 'success',
      isPreflightOnly: true,
      preflight: {
        ok: true,
        checks: [
          { id: 'netlify-auth-token', status: 'pass', message: 'Token input is present' },
          { id: 'netlify-site-id', status: 'pass', message: 'Site ID input is present' },
        ],
        warnings: [],
        failures: [],
      },
    });

    assert.ok(markdown.includes('Preflight-only mode: configuration was validated without starting an agent run.'));
    assert.ok(markdown.includes('## Preflight Checks'));
    assert.ok(markdown.includes('| netlify-auth-token | pass | Token input is present |'));
    assert.ok(markdown.includes('| netlify-site-id | pass | Site ID input is present |'));
  });

  it('escapes pipe and newline content for markdown tables', () => {
    const markdown = renderStepSummary({
      outcome: 'success',
      contextLabel: 'Issue #1|2',
      preflight: {
        ok: true,
        checks: [{ id: 'site|id', status: 'pass', message: 'Line one\nline two' }],
        warnings: [],
        failures: [],
      },
    });

    assert.ok(markdown.includes('Issue #1\\|2'));
    assert.ok(markdown.includes('site\\|id'));
    assert.ok(markdown.includes('Line one<br>line two'));
  });
});

describe('normalizeStepSummaryInput', () => {
  it('normalizes env-style input keys and infers context', () => {
    const normalized = normalizeStepSummaryInput({
      OUTCOME: 'success',
      GITHUB_EVENT_NAME: 'issue_comment',
      IS_PR: 'true',
      ISSUE_NUM: '55',
      AGENT: 'claude',
      MODEL: 'legacy-codex',
      AGENT_ID: 'abc123',
      SITE_NAME: 'my-site',
      AGENT_RUN_URL: 'https://app.netlify.com/projects/my-site/agent-runs/abc123',
      AGENT_DEPLOY_URL: 'https://my-site.netlify.app',
      AGENT_PR_URL: 'https://github.com/o/r/pull/55',
      TRIGGER_TEXT: 'Ship it',
    });

    assert.equal(normalized.outcome, 'success');
    assert.equal(normalized.eventName, 'issue_comment');
    assert.equal(normalized.contextLabel, 'PR #55');
    assert.equal(normalized.model, 'claude');
    assert.equal(normalized.runnerId, 'abc123');
    assert.equal(normalized.siteName, 'my-site');
    assert.equal(normalized.prompt, 'Ship it');
  });

  it('normalizes failure object through taxonomy classifier', () => {
    const normalized = normalizeStepSummaryInput({
      failure: { error: 'Missing netlify-site-id input' },
    });
    assert.ok(normalized.failure);
    assert.equal(normalized.failure.category, 'missing-site-id');
    assert.equal(normalized.failure.userActionRequired, true);
  });
});

describe('escapeMarkdownTableValue', () => {
  it('escapes markdown table delimiters and newlines', () => {
    assert.equal(escapeMarkdownTableValue('a|b\nc'), 'a\\|b<br>c');
  });
});
