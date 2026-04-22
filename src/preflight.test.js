const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { normalizePreflightInput, runPreflight } = require('./preflight');

describe('normalizePreflightInput', () => {
  it('normalizes env-style keys', () => {
    const normalized = normalizePreflightInput({
      NETLIFY_AUTH_TOKEN: 'ntlk_123',
      NETLIFY_SITE_ID: 'site_abc',
      GITHUB_TOKEN: 'ghs_123',
      DEFAULT_AGENT: 'GEMINI',
      DEFAULT_MODEL: 'CLAUDE',
      TIMEOUT_MINUTES: '15',
      TRIGGER_TEXT: 'Ship it',
      ISSUE_NUMBER: '42',
      GITHUB_EVENT_NAME: 'issue_comment',
    });

    assert.equal(normalized.netlifyAuthToken, 'ntlk_123');
    assert.equal(normalized.netlifySiteId, 'site_abc');
    assert.equal(normalized.githubToken, 'ghs_123');
    assert.equal(normalized.defaultAgent, 'gemini');
    assert.equal(normalized.defaultModel, 'gemini');
    assert.equal(normalized.timeoutMinutes, 15);
    assert.equal(normalized.triggerText, 'Ship it');
    assert.equal(normalized.issueNumber, '42');
    assert.equal(normalized.eventName, 'issue_comment');
    assert.equal(normalized.commentsRequired, true);
  });

  it('defaults commentsRequired=false for workflow_dispatch', () => {
    const normalized = normalizePreflightInput({
      eventName: 'workflow_dispatch',
    });
    assert.equal(normalized.commentsRequired, false);
  });
});

describe('runPreflight', () => {
  it('passes static checks and records skipped runtime checks as warnings', async () => {
    const result = await runPreflight({
      netlifyAuthToken: 'token',
      netlifySiteId: 'site-id',
      githubToken: 'gh-token',
      defaultAgent: 'codex',
      timeoutMinutes: 10,
      triggerText: '@netlify fix it',
      issueNumber: '88',
      commentsRequired: true,
    });

    assert.equal(result.ok, true);
    assert.equal(result.failures.length, 0);
    assert.equal(result.failureDetails.length, 0);

    const byId = Object.fromEntries(result.checks.map(check => [check.id, check]));
    assert.equal(byId['netlify-auth-token'].status, 'pass');
    assert.equal(byId['netlify-site-id'].status, 'pass');
    assert.equal(byId['default-agent'].status, 'pass');
    assert.equal(byId['timeout-minutes'].status, 'pass');
    assert.equal(byId['github-token'].status, 'pass');
    assert.equal(byId['trigger-context'].status, 'pass');
    assert.equal(byId['issue-number'].status, 'pass');

    assert.equal(byId['runtime-netlify-cli'].status, 'warn');
    assert.equal(byId['runtime-netlify-site-resolution'].status, 'warn');
    assert.equal(byId['runtime-github-repo-access'].status, 'warn');
    assert.equal(byId['runtime-comment-permission'].status, 'warn');
  });

  it('fails missing required static inputs with taxonomy-compatible failures', async () => {
    const result = await runPreflight({
      defaultAgent: 'unsupported-agent',
      timeoutMinutes: '0',
      commentsRequired: true,
    });

    assert.equal(result.ok, false);
    assert.ok(result.failures.includes('missing-auth-token'));
    assert.ok(result.failures.includes('missing-site-id'));
    assert.ok(result.failures.includes('agent-unavailable'));
    assert.ok(result.failures.includes('github-permission-denied'));
    assert.ok(result.failures.includes('unknown'));
  });

  it('does not require issue number for workflow dispatch contexts', async () => {
    const result = await runPreflight({
      netlifyAuthToken: 'token',
      netlifySiteId: 'site-id',
      githubToken: 'gh-token',
      defaultAgent: 'gemini',
      timeoutMinutes: 10,
      triggerText: 'manual run',
      eventName: 'workflow_dispatch',
    });

    const issueCheck = result.checks.find(check => check.id === 'issue-number');
    assert.ok(issueCheck);
    assert.equal(issueCheck.status, 'pass');
    assert.equal(result.failures.includes('unknown'), false);
  });

  it('supports injected runtime checks and captures runtime failures', async () => {
    const result = await runPreflight(
      {
        netlifyAuthToken: 'token',
        netlifySiteId: 'site-id',
        githubToken: 'gh-token',
        defaultAgent: 'claude',
        timeoutMinutes: 10,
        triggerText: 'please run',
        issueNumber: '3',
        commentsRequired: true,
      },
      {
        checkNetlifyCli: () => ({ ok: true, message: 'Netlify CLI available.' }),
        checkSiteResolution: () => ({
          ok: false,
          message: 'Site lookup failed.',
          failure: { category: 'site-lookup-failed', stage: 'resolve-site' },
        }),
        checkGithubRepoAccess: () => {
          throw new Error('403 from GitHub API');
        },
        checkCommentPermission: () => ({ status: 'warn', message: 'Skipped on this event.' }),
      }
    );

    assert.equal(result.ok, false);

    const byId = Object.fromEntries(result.checks.map(check => [check.id, check]));
    assert.equal(byId['runtime-netlify-cli'].status, 'pass');
    assert.equal(byId['runtime-netlify-site-resolution'].status, 'fail');
    assert.equal(byId['runtime-github-repo-access'].status, 'fail');
    assert.equal(byId['runtime-comment-permission'].status, 'warn');
    assert.ok(result.failures.includes('site-lookup-failed'));
    assert.ok(result.failures.includes('github-api-failed'));
    assert.ok(result.failureDetails.some(failure => failure.category === 'site-lookup-failed'));
    assert.ok(result.failureDetails.some(failure => failure.category === 'github-api-failed'));
  });

  it('records site lookup success without adding failure categories', async () => {
    const result = await runPreflight(
      {
        netlifyAuthToken: 'token',
        netlifySiteId: 'site-id',
        githubToken: 'gh-token',
        defaultAgent: 'codex',
        timeoutMinutes: 10,
        triggerText: '@netlify build',
        issueNumber: '12',
        commentsRequired: true,
      },
      {
        checkSiteResolution: () => ({
          ok: true,
          message: 'Site lookup succeeded.',
        }),
      }
    );

    assert.equal(result.ok, true);
    const siteCheck = result.checks.find(check => check.id === 'runtime-netlify-site-resolution');
    assert.ok(siteCheck);
    assert.equal(siteCheck.status, 'pass');
    assert.ok(result.failures.includes('site-lookup-failed') === false);
  });
});
