const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const checkTrigger = require('./check-trigger');

// ---------------------------------------------------------------------------
// Test helpers — mock github, context, core
// ---------------------------------------------------------------------------
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
      repos: {
        getCollaboratorPermissionLevel: async () => ({ data: { permission: 'admin' } }),
      },
    },
  };
}

function makeContext(eventName, payload = {}) {
  return {
    eventName,
    payload: { sender: { login: 'testuser' }, repository: { full_name: 'owner/repo' }, ...payload },
    repo: { owner: 'owner', repo: 'repo' },
    actor: 'testuser',
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('checkTrigger', () => {
  let core;
  beforeEach(() => {
    core = mockCore();
    delete process.env.ALLOWED_USERS;
  });

  it('triggers on issue_comment with @netlify', async () => {
    const context = makeContext('issue_comment', {
      comment: { body: '@netlify build a page', author_association: 'OWNER' },
    });
    await checkTrigger({ github: mockGithub(), context, core });
    assert.equal(core.outputs['should-run'], 'true');
  });

  it('triggers on issue_comment with typo @nelify', async () => {
    const context = makeContext('issue_comment', {
      comment: { body: '@nelify fix it', author_association: 'MEMBER' },
    });
    await checkTrigger({ github: mockGithub(), context, core });
    assert.equal(core.outputs['should-run'], 'true');
  });

  it('does NOT trigger without @netlify mention', async () => {
    const context = makeContext('issue_comment', {
      comment: { body: 'just a comment', author_association: 'OWNER' },
    });
    await checkTrigger({ github: mockGithub(), context, core });
    assert.equal(core.outputs['should-run'], 'false');
  });

  it('does NOT trigger from bot accounts', async () => {
    const context = makeContext('issue_comment', {
      sender: { login: 'github-actions[bot]' },
      comment: { body: '@netlify do something', author_association: 'OWNER' },
    });
    await checkTrigger({ github: mockGithub(), context, core });
    assert.equal(core.outputs['should-run'], 'false');
  });

  it('does NOT trigger from netlify-coding bot', async () => {
    const context = makeContext('issue_comment', {
      sender: { login: 'netlify-coding[bot]' },
      comment: { body: '@netlify build', author_association: 'OWNER' },
    });
    await checkTrigger({ github: mockGithub(), context, core });
    assert.equal(core.outputs['should-run'], 'false');
  });

  it('does NOT trigger from netlify bot', async () => {
    const context = makeContext('issue_comment', {
      sender: { login: 'netlify[bot]' },
      comment: { body: '@netlify deploy preview ready', author_association: 'OWNER' },
    });
    await checkTrigger({ github: mockGithub(), context, core });
    assert.equal(core.outputs['should-run'], 'false');
  });

  it('blocks users without valid association', async () => {
    const context = makeContext('issue_comment', {
      sender: { login: 'random-user' },
      comment: { body: '@netlify hack', author_association: 'NONE' },
    });
    await checkTrigger({ github: mockGithub(), context, core });
    assert.equal(core.outputs['should-run'], 'false');
  });

  it('allows COLLABORATOR association', async () => {
    const context = makeContext('issue_comment', {
      sender: { login: 'collaborator' },
      comment: { body: '@netlify build', author_association: 'COLLABORATOR' },
    });
    await checkTrigger({ github: mockGithub(), context, core });
    assert.equal(core.outputs['should-run'], 'true');
  });

  it('allows repo owner regardless of association', async () => {
    const context = makeContext('issue_comment', {
      sender: { login: 'owner' },
      comment: { body: '@netlify build', author_association: 'NONE' },
    });
    await checkTrigger({ github: mockGithub(), context, core });
    assert.equal(core.outputs['should-run'], 'true');
  });

  it('always triggers workflow_dispatch', async () => {
    const context = makeContext('workflow_dispatch', {
      inputs: { trigger_text: 'build it', actor: 'testuser' },
    });
    await checkTrigger({ github: mockGithub(), context, core });
    assert.equal(core.outputs['should-run'], 'true');
  });

  it('triggers on issues with @netlify in body', async () => {
    const context = makeContext('issues', {
      issue: { title: 'New feature', body: '@netlify build it', author_association: 'OWNER' },
      sender: { login: 'owner' },
    });
    await checkTrigger({ github: mockGithub(), context, core });
    assert.equal(core.outputs['should-run'], 'true');
  });

  it('triggers on issues with @netlify in title', async () => {
    const context = makeContext('issues', {
      issue: { title: '@netlify build a page', body: 'details here', author_association: 'OWNER' },
      sender: { login: 'owner' },
    });
    await checkTrigger({ github: mockGithub(), context, core });
    assert.equal(core.outputs['should-run'], 'true');
  });

  it('triggers on pull_request_review with @netlify', async () => {
    const context = makeContext('pull_request_review', {
      review: { body: '@netlify fix this', author_association: 'MEMBER' },
      sender: { login: 'reviewer' },
    });
    await checkTrigger({ github: mockGithub(), context, core });
    assert.equal(core.outputs['should-run'], 'true');
  });

  it('blocks fork PRs without valid association', async () => {
    const context = makeContext('pull_request_target', {
      pull_request: {
        body: '@netlify build',
        author_association: 'NONE',
        head: { repo: { full_name: 'forker/repo' } },
      },
      sender: { login: 'forker' },
    });
    await checkTrigger({ github: mockGithub(), context, core });
    assert.equal(core.outputs['should-run'], 'false');
  });

  it('allows same-repo PRs regardless of association', async () => {
    const context = makeContext('pull_request_target', {
      pull_request: {
        body: '@netlify build',
        author_association: 'NONE',
        head: { repo: { full_name: 'owner/repo' } },
      },
      sender: { login: 'anyone' },
    });
    await checkTrigger({ github: mockGithub(), context, core });
    assert.equal(core.outputs['should-run'], 'true');
  });

  it('respects ALLOWED_USERS for workflow_dispatch', async () => {
    process.env.ALLOWED_USERS = 'alice,bob';
    const context = makeContext('workflow_dispatch', {
      inputs: { trigger_text: 'build', actor: 'charlie' },
    });
    const github = {
      rest: {
        repos: {
          getCollaboratorPermissionLevel: async () => ({ data: { permission: 'read' } }),
        },
      },
    };
    await checkTrigger({ github, context, core });
    assert.equal(core.outputs['should-run'], 'false');
  });

  it('allows ALLOWED_USERS member for workflow_dispatch', async () => {
    process.env.ALLOWED_USERS = 'alice,bob';
    const context = makeContext('workflow_dispatch', {
      inputs: { trigger_text: 'build', actor: 'alice' },
    });
    await checkTrigger({ github: mockGithub(), context, core });
    assert.equal(core.outputs['should-run'], 'true');
  });
});
