const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const getContext = require('./get-context');

function mockCore() {
  const outputs = {};
  return {
    setOutput: (k, v) => { outputs[k] = v; },
    outputs,
  };
}

function mockGithub() {
  return {
    rest: {
      pulls: { get: async () => ({ data: { head: { ref: 'feat', sha: 'abc' }, base: { ref: 'main' } } }) },
      issues: { listEventsForTimeline: async () => ({ data: [] }) },
    },
  };
}

describe('getContext', () => {
  let core;
  beforeEach(() => {
    core = mockCore();
    delete process.env.DEFAULT_AGENT;
    process.env.DEFAULT_MODEL = 'codex';
    process.env.DRY_RUN = 'false';
  });

  it('extracts context from issue_comment on a PR', async () => {
    const context = {
      eventName: 'issue_comment',
      payload: {
        issue: { number: 42, pull_request: { url: 'https://api.github.com/repos/o/r/pulls/42' } },
        comment: { body: '@netlify claude fix it', html_url: 'https://github.com/o/r/issues/42#comment-1' },
      },
      repo: { owner: 'o', repo: 'r' },
    };
    await getContext({ github: mockGithub(), context, core });
    assert.equal(core.outputs['issue-number'], 42);
    assert.equal(core.outputs['is-pr'], 'true');
    assert.equal(core.outputs['agent'], 'claude');
    assert.equal(core.outputs['model'], 'claude');
    assert.equal(core.outputs['is-dry-run'], 'false');
  });

  it('extracts context from issues event', async () => {
    const context = {
      eventName: 'issues',
      payload: {
        issue: {
          number: 10,
          title: 'Build a page',
          body: '@netlify codex make it nice',
          html_url: 'https://github.com/o/r/issues/10',
        },
      },
      repo: { owner: 'o', repo: 'r' },
    };
    await getContext({ github: mockGithub(), context, core });
    assert.equal(core.outputs['issue-number'], 10);
    assert.equal(core.outputs['is-pr'], 'false');
    assert.equal(core.outputs['model'], 'codex');
  });

  it('preserves issue title spaces when body has @netlify', async () => {
    const context = {
      eventName: 'issues',
      payload: {
        issue: {
          number: 72,
          title: 'Build site',
          body: '@netlify Build a fun retro arcade website',
          html_url: 'https://github.com/o/r/issues/72',
        },
      },
      repo: { owner: 'o', repo: 'r' },
    };
    await getContext({ github: mockGithub(), context, core });
    assert.ok(
      core.outputs['trigger-text'].startsWith('Build site'),
      `Expected title "Build site" but got: ${core.outputs['trigger-text'].split('\n')[0]}`
    );
  });

  it('strips model name from issue title when duplicated', async () => {
    const context = {
      eventName: 'issues',
      payload: {
        issue: {
          number: 73,
          title: '@netlify claude Build a page',
          body: '@netlify claude Build a page with details',
          html_url: 'https://github.com/o/r/issues/73',
        },
      },
      repo: { owner: 'o', repo: 'r' },
    };
    await getContext({ github: mockGithub(), context, core });
    assert.ok(
      core.outputs['trigger-text'].startsWith('Build a page'),
      `Expected clean title but got: ${core.outputs['trigger-text'].split('\n')[0]}`
    );
  });

  it('detects dry-run from @netlify preview', async () => {
    const context = {
      eventName: 'issue_comment',
      payload: {
        issue: { number: 5, pull_request: null },
        comment: { body: '@netlify preview build a page', html_url: 'https://github.com/o/r/issues/5#c' },
      },
      repo: { owner: 'o', repo: 'r' },
    };
    await getContext({ github: mockGithub(), context, core });
    assert.equal(core.outputs['is-dry-run'], 'true');
  });

  it('detects dry-run from @netlify dry-run', async () => {
    const context = {
      eventName: 'issue_comment',
      payload: {
        issue: { number: 5, pull_request: null },
        comment: { body: '@netlify dry-run add a footer', html_url: 'https://github.com/o/r/issues/5#c' },
      },
      repo: { owner: 'o', repo: 'r' },
    };
    await getContext({ github: mockGithub(), context, core });
    assert.equal(core.outputs['is-dry-run'], 'true');
  });

  it('detects dry-run from env var', async () => {
    process.env.DRY_RUN = 'true';
    const context = {
      eventName: 'issue_comment',
      payload: {
        issue: { number: 5, pull_request: null },
        comment: { body: '@netlify build', html_url: 'https://github.com/o/r/issues/5#c' },
      },
      repo: { owner: 'o', repo: 'r' },
    };
    await getContext({ github: mockGithub(), context, core });
    assert.equal(core.outputs['is-dry-run'], 'true');
  });

  it('uses workflow_dispatch model input', async () => {
    const context = {
      eventName: 'workflow_dispatch',
      payload: {
        inputs: { trigger_text: 'build something', model: 'gemini' },
      },
      repo: { owner: 'o', repo: 'r' },
    };
    await getContext({ github: mockGithub(), context, core });
    assert.equal(core.outputs['agent'], 'gemini');
    assert.equal(core.outputs['model'], 'gemini');
  });

  it('uses workflow_dispatch agent input', async () => {
    const context = {
      eventName: 'workflow_dispatch',
      payload: {
        inputs: { trigger_text: 'build something', agent: 'claude' },
      },
      repo: { owner: 'o', repo: 'r' },
    };
    await getContext({ github: mockGithub(), context, core });
    assert.equal(core.outputs['agent'], 'claude');
    assert.equal(core.outputs['model'], 'claude');
  });

  it('defaults agent to DEFAULT_AGENT env', async () => {
    process.env.DEFAULT_AGENT = 'gemini';
    process.env.DEFAULT_MODEL = 'claude';
    const context = {
      eventName: 'issue_comment',
      payload: {
        issue: { number: 1, pull_request: null },
        comment: { body: '@netlify build a page', html_url: 'https://github.com/o/r/issues/1#c' },
      },
      repo: { owner: 'o', repo: 'r' },
    };
    await getContext({ github: mockGithub(), context, core });
    assert.equal(core.outputs['agent'], 'gemini');
    assert.equal(core.outputs['model'], 'gemini');
  });

  it('defaults agent to legacy DEFAULT_MODEL env', async () => {
    process.env.DEFAULT_MODEL = 'claude';
    const context = {
      eventName: 'issue_comment',
      payload: {
        issue: { number: 1, pull_request: null },
        comment: { body: '@netlify build a page', html_url: 'https://github.com/o/r/issues/1#c' },
      },
      repo: { owner: 'o', repo: 'r' },
    };
    await getContext({ github: mockGithub(), context, core });
    assert.equal(core.outputs['agent'], 'claude');
    assert.equal(core.outputs['model'], 'claude');
  });

  it('appends source URL', async () => {
    const context = {
      eventName: 'issue_comment',
      payload: {
        issue: { number: 1, pull_request: null },
        comment: { body: '@netlify build', html_url: 'https://github.com/o/r/issues/1#issuecomment-123' },
      },
      repo: { owner: 'o', repo: 'r' },
    };
    await getContext({ github: mockGithub(), context, core });
    assert.ok(core.outputs['trigger-text'].includes('◌ https://github.com/o/r/issues/1#issuecomment-123'));
  });
});
