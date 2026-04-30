const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const extractAgentId = require('./extract-agent-id');

function mockCore() {
  const outputs = {};
  return {
    setOutput: (k, v) => { outputs[k] = v; },
    outputs,
  };
}

function mockGithub({ commentBody = '', prBody = '', isFork = false } = {}) {
  const baseRepo = { full_name: 'owner/repo' };
  const headRepo = isFork ? { full_name: 'forker/repo' } : baseRepo;
  return {
    rest: {
      issues: {
        getComment: async () => ({ data: { body: commentBody } }),
      },
      pulls: {
        get: async () => ({
          data: {
            body: prBody,
            head: { repo: headRepo },
            base: { repo: baseRepo },
          },
        }),
      },
    },
  };
}

function context() {
  return {
    repo: { owner: 'owner', repo: 'repo' },
  };
}

describe('extractAgentId', () => {
  /** @type {string[]} */
  let logs = [];
  let originalLog;

  beforeEach(() => {
    logs = [];
    originalLog = console.log;
    console.log = (msg) => { logs.push(String(msg)); };
  });

  afterEach(() => {
    console.log = originalLog;
  });

  it('prefers status comment marker data and preserves url extraction', async () => {
    const core = mockCore();
    const github = mockGithub({
      commentBody: [
        '<!-- netlify-agent-runner-id:runner-status -->',
        '<!-- netlify-agent-session-data:{"s1":{"commit_sha":"abc123"}} -->',
        '[Netlify agent run](https://app.netlify.com/projects/site-a/agent-runs/runner-status)',
      ].join('\n'),
      prBody: '<!-- netlify-agent-runner-id:runner-pr -->',
    });

    await extractAgentId({
      github,
      context: context(),
      core,
      inputs: { isPR: 'true', commentId: '10', prNumber: '10' },
    });

    assert.equal(core.outputs['agent-runner-id'], 'runner-status');
    assert.equal(core.outputs['session-data-map'], '{"s1":{"commit_sha":"abc123"}}');
    assert.equal(
      core.outputs['agent-run-url'],
      'https://app.netlify.com/projects/site-a/agent-runs/runner-status'
    );
    assert.equal(core.outputs['has-linked-pr'], 'false');
    assert.equal(core.outputs['linked-pr-number'], '');
  });

  it('falls back to PR body when status comment has no runner marker', async () => {
    const core = mockCore();
    const github = mockGithub({
      commentBody: 'status body without markers',
      prBody: '<!-- netlify-agent-runner-id:runner-from-pr -->',
    });

    await extractAgentId({
      github,
      context: context(),
      core,
      inputs: { isPR: 'true', commentId: '20', prNumber: '20' },
    });

    assert.equal(core.outputs['agent-runner-id'], 'runner-from-pr');
    assert.equal(core.outputs['session-data-map'], '{}');
  });

  it('ignores PR body markers on fork PRs to prevent state poisoning', async () => {
    const core = mockCore();
    const github = mockGithub({
      commentBody: 'status body without markers',
      prBody: '<!-- netlify-agent-runner-id:planted-by-fork -->',
      isFork: true,
    });

    await extractAgentId({
      github,
      context: context(),
      core,
      inputs: { isPR: 'true', commentId: '21', prNumber: '21' },
    });

    assert.equal(core.outputs['agent-runner-id'], '');
    assert.ok(logs.some(line => line.includes('Skipping PR body fallback for fork PR')));
  });

  it('rejects malformed runner-id markers that contain JSON-breaking characters', async () => {
    const core = mockCore();
    const github = mockGithub({
      commentBody: '<!-- netlify-agent-runner-id:x","prompt":"smuggled -->',
    });

    await extractAgentId({
      github,
      context: context(),
      core,
      inputs: { isPR: 'false', commentId: '40', prNumber: '' },
    });

    assert.equal(core.outputs['agent-runner-id'], '');
  });

  it('sets linked-pr outputs from reconciled state', async () => {
    const core = mockCore();
    const github = mockGithub({
      commentBody: 'Changes in Pull Request #123',
    });

    await extractAgentId({
      github,
      context: context(),
      core,
      inputs: { isPR: 'false', commentId: '31', prNumber: '' },
    });

    assert.equal(core.outputs['has-linked-pr'], 'true');
    assert.equal(core.outputs['linked-pr-number'], '123');
  });

  it('logs warnings for malformed state markers without throwing', async () => {
    const core = mockCore();
    const github = mockGithub({
      commentBody: '<!-- netlify-agent-session-data:{not-json} -->',
    });

    await extractAgentId({
      github,
      context: context(),
      core,
      inputs: { isPR: 'false', commentId: '50', prNumber: '' },
    });

    assert.equal(core.outputs['agent-runner-id'], '');
    assert.equal(core.outputs['session-data-map'], '{}');
    assert.ok(logs.some(line => line.includes('State reconciliation warnings')));
  });
});
