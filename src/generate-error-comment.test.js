const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const generateErrorComment = require('./generate-error-comment');

const TRACKED_ENV_KEYS = [
  'IS_PR',
  'ISSUE_NUMBER',
  'AGENT_ERROR',
  'AGENT_ID',
  'RUNNER_ID',
  'SITE_NAME',
  'GH_ACTION_URL',
  'FAILURE_CATEGORY',
  'AGENT_FAILURE_CATEGORY',
  'FAILURE_STAGE',
  'AGENT_FAILURE_STAGE',
  'FAILURE_STATUS_CODE',
  'STATUS_CODE',
];

/**
 * @param {Record<string, string>} values
 */
function setEnv(values = {}) {
  for (const key of TRACKED_ENV_KEYS) {
    delete process.env[key];
  }
  for (const [key, value] of Object.entries(values)) {
    process.env[key] = value;
  }
}

/**
 * @returns {Promise<string>}
 */
async function renderComment() {
  let body = '';
  await generateErrorComment({
    core: {
      setOutput(name, value) {
        if (name === 'comment-body') body = value;
      },
    },
  });
  return body;
}

afterEach(() => {
  setEnv({});
});

describe('generate-error-comment', () => {
  it('renders missing-auth-token setup failures with actionable remediation', async () => {
    setEnv({
      ISSUE_NUMBER: '3',
      FAILURE_CATEGORY: 'missing-auth-token',
    });

    const body = await renderComment();
    assert.ok(body.includes('### ❌ Missing Netlify auth token'));
    assert.ok(body.includes('The action cannot authenticate to Netlify because netlify-auth-token is missing.'));
    assert.ok(body.includes('- **Category:** `missing-auth-token`'));
    assert.ok(body.includes('- **Stage:** `validate-env`'));
    assert.ok(body.includes('- **Retryable:** no'));
    assert.ok(body.includes('- **User action required:** yes'));
    assert.ok(body.includes('Add the `netlify-auth-token` input to the workflow step.'));
  });

  it('infers missing-site-id from raw error text when category is absent', async () => {
    setEnv({
      ISSUE_NUMBER: '4',
      AGENT_ERROR: 'Missing netlify-site-id input from NETLIFY_SITE_ID secret',
    });

    const body = await renderComment();
    assert.ok(body.includes('Missing Netlify site ID'));
    assert.ok(body.includes('- **Category:** `missing-site-id`'));
    assert.ok(body.includes('- **Stage:** `validate-env`'));
  });

  it('renders taxonomy-backed failure details and remediation', async () => {
    setEnv({
      IS_PR: 'false',
      ISSUE_NUMBER: '17',
      FAILURE_CATEGORY: 'missing-site-id',
      GH_ACTION_URL: 'https://github.com/org/repo/actions/runs/17',
    });

    const body = await renderComment();
    assert.ok(body.includes('### ❌ Missing Netlify site ID'));
    assert.ok(body.includes('The action cannot resolve the target site because netlify-site-id is missing.'));
    assert.ok(body.includes('- **Category:** `missing-site-id`'));
    assert.ok(body.includes('- **Retryable:** no'));
    assert.ok(body.includes('Suggested next steps:'));
    assert.ok(body.includes('Add the `netlify-site-id` input to the workflow step.'));
    assert.ok(body.includes('[GitHub Action logs](https://github.com/org/repo/actions/runs/17)'));
  });

  it('preserves model-unavailability fallback hints', async () => {
    setEnv({
      IS_PR: 'true',
      ISSUE_NUMBER: '42',
      AGENT_ID: 'runner-42',
      SITE_NAME: 'example-site',
      GH_ACTION_URL: 'https://github.com/org/repo/actions/runs/42',
      AGENT_ERROR: 'Agent Runner claude is not available right now',
    });

    const body = await renderComment();
    assert.ok(body.includes('Requested agent is unavailable'));
    assert.ok(body.includes('`@netlify codex` or `@netlify gemini`'));
    assert.ok(body.includes('[Agent run](https://app.netlify.com/projects/example-site/agent-runs/runner-42)'));
    assert.ok(body.includes('<!-- netlify-agent-runner-id:runner-42 -->'));
    assert.ok(body.includes('<!-- netlify-agent-run-status -->'));
  });

  it('renders timeout failures with timeout guidance', async () => {
    setEnv({
      ISSUE_NUMBER: '51',
      FAILURE_STAGE: 'poll-agent',
      AGENT_ERROR: 'Agent timed out after 600s (last state: running)',
    });

    const body = await renderComment();
    assert.ok(body.includes('Agent timed out before completion'));
    assert.ok(body.includes('- **Category:** `agent-timeout`'));
    assert.ok(body.includes('- **Stage:** `poll-agent`'));
    assert.ok(body.includes('Increase `timeout-minutes` if longer runs are expected.'));
  });

  it('renders github permission failures from status code and message', async () => {
    setEnv({
      ISSUE_NUMBER: '88',
      AGENT_ERROR: 'GitHub API failed: Resource not accessible by integration',
      FAILURE_STATUS_CODE: '403',
    });

    const body = await renderComment();
    assert.ok(body.includes('GitHub permission denied'));
    assert.ok(body.includes('- **Category:** `github-permission-denied`'));
    assert.ok(body.includes('- **Retryable:** no'));
    assert.ok(body.includes('- **User action required:** yes'));
  });

  it('falls back to unknown classification for unmatched errors', async () => {
    setEnv({
      ISSUE_NUMBER: '99',
      AGENT_ERROR: 'totally unrelated failure text',
    });

    const body = await renderComment();
    assert.ok(body.includes('Netlify Agent Runners run failed'));
    assert.ok(body.includes('- **Category:** `unknown`'));
  });

  it('sanitizes and truncates error excerpts for public comments', async () => {
    const unsafe = `\u001b[31mboom\u001b[0m\nline two with \`\`\`fence\`\`\`\n${'x'.repeat(900)}`;
    setEnv({
      ISSUE_NUMBER: '8',
      AGENT_ERROR: unsafe,
      SITE_NAME: 'example-site',
    });

    const body = await renderComment();
    assert.ok(body.includes('**Error excerpt:**'));
    assert.ok(body.includes('```text'));
    assert.ok(!body.includes('\u001b[31m'));
    assert.ok(!body.includes('```fence```'));
    assert.ok(body.includes("'''fence'''"));

    const excerptMatch = body.match(/\*\*Error excerpt:\*\*\n\n```text\n([\s\S]*?)\n```/);
    assert.ok(excerptMatch, 'expected fenced error excerpt');
    assert.ok(excerptMatch[1].length <= 501, 'error excerpt should be truncated to 500 chars plus ellipsis');
    assert.ok(excerptMatch[1].endsWith('…'), 'truncated excerpts should end with ellipsis');
  });

  it('links dashboard when site is known but runner id is missing', async () => {
    setEnv({
      ISSUE_NUMBER: '99',
      SITE_NAME: 'example-site',
      GH_ACTION_URL: 'https://github.com/org/repo/actions/runs/99',
    });

    const body = await renderComment();
    assert.ok(body.includes('[Netlify Agent Runners dashboard](https://app.netlify.com/projects/example-site/agent-runs)'));
    assert.ok(body.includes('[GitHub Action logs](https://github.com/org/repo/actions/runs/99)'));
  });

  it('renders Netlify run links and preserves hidden markers', async () => {
    setEnv({
      ISSUE_NUMBER: '120',
      RUNNER_ID: 'runner-120',
      SITE_NAME: 'example-site',
      GH_ACTION_URL: 'https://github.com/org/repo/actions/runs/120',
    });

    const body = await renderComment();
    assert.ok(body.includes('[Agent run](https://app.netlify.com/projects/example-site/agent-runs/runner-120)'));
    assert.ok(body.includes('[GitHub Action logs](https://github.com/org/repo/actions/runs/120)'));
    assert.ok(body.includes('<!-- netlify-agent-runner-id:runner-120 -->'));
    assert.ok(body.includes('<!-- netlify-agent-run-status -->'));
  });

  it('always preserves status marker and does not emit runner marker without id', async () => {
    setEnv({
      ISSUE_NUMBER: '121',
    });

    const body = await renderComment();
    assert.ok(body.includes('<!-- netlify-agent-run-status -->'));
    assert.ok(!body.includes('<!-- netlify-agent-runner-id:'));
  });
});
