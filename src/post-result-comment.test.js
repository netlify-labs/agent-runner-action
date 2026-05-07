const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const postResultComment = require('./post-result-comment');

const OLD_ENV = Object.assign({}, process.env);

function core() {
  const outputs = {};
  return {
    outputs,
    setOutput(name, value) {
      outputs[name] = value;
    },
  };
}

function context() {
  return { repo: { owner: 'netlify-labs', repo: 'agent-runner-action-example' } };
}

beforeEach(() => {
  process.env = Object.assign({}, OLD_ENV);
});

afterEach(() => {
  process.env = Object.assign({}, OLD_ENV);
});

describe('post-result-comment', () => {
  it('posts a result comment and exposes id/url outputs', async () => {
    const calls = [];
    const github = {
      rest: {
        issues: {
          createComment: async params => {
            calls.push(params);
            return { data: { id: 123, html_url: 'https://github.com/o/r/issues/1#issuecomment-123' } };
          },
        },
      },
    };
    process.env.RESULT_BODY = 'body';
    process.env.ISSUE_NUMBER = '5';
    const c = core();

    await postResultComment({ github, context: context(), core: c });

    assert.equal(c.outputs['result-comment-id'], '123');
    assert.equal(c.outputs['result-comment-url'], 'https://github.com/o/r/issues/1#issuecomment-123');
    assert.equal(calls[0].issue_number, 5);
    assert.equal(calls[0].body, 'body');
  });

  it('skips empty result bodies', async () => {
    let called = false;
    const github = {
      rest: { issues: { createComment: async () => { called = true; } } },
    };
    process.env.RESULT_BODY = '';
    process.env.ISSUE_NUMBER = '5';
    const c = core();

    await postResultComment({ github, context: context(), core: c });

    assert.equal(called, false);
    assert.equal(c.outputs['result-comment-id'], '');
  });

  it('captures create failures without throwing', async () => {
    const github = {
      rest: {
        issues: {
          createComment: async () => {
            throw new Error('api down');
          },
        },
      },
    };
    process.env.RESULT_BODY = 'body';
    process.env.ISSUE_NUMBER = '5';
    const c = core();

    await postResultComment({ github, context: context(), core: c });

    assert.equal(c.outputs['result-comment-id'], '');
    assert.equal(c.outputs['result-comment-error'], 'api down');
  });
});
