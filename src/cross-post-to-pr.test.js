const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const crossPostToPR = require('./cross-post-to-pr');
const { STATUS_COMMENT_MARKER, HISTORY_COMMENT_MARKER } = require('./comment-markers');

const OLD_ENV = Object.assign({}, process.env);

function context() {
  return { repo: { owner: 'netlify-labs', repo: 'agent-runner-action-example' } };
}

beforeEach(() => {
  process.env = Object.assign({}, OLD_ENV);
});

afterEach(() => {
  process.env = Object.assign({}, OLD_ENV);
});

describe('crossPostToPR', () => {
  it('posts PR-local result/status/TOC and preserves issue-local result link', async () => {
    const created = [];
    const updated = [];
    const resultBody = '### [Run #1 | codex | Agent Run completed](https://app) OK\n\nResult\n\n<!-- netlify-agent-run-result:runner:session1 -->';

    const github = {
      rest: {
        issues: {
          createComment: async params => {
            created.push(params);
            const id = 100 + created.length;
            return {
              data: {
                id,
                html_url: `https://github.com/netlify-labs/agent-runner-action-example/issues/${params.issue_number}#issuecomment-${id}`,
              },
            };
          },
          updateComment: async params => {
            updated.push(params);
            return { data: { id: params.comment_id, body: params.body } };
          },
          listComments: async params => ({
            data: [{
              id: 101,
              user: { login: 'github-actions[bot]' },
              created_at: '2026-05-07T12:00:00Z',
              body: resultBody,
            }],
          }),
        },
      },
    };

    process.env.AGENT_PR_URL = 'https://github.com/netlify-labs/agent-runner-action-example/pull/7';
    process.env.AGENT_ID = 'runner';
    process.env.SITE_NAME = 'site';
    process.env.RESULT_BODY = resultBody;
    process.env.STATUS_BODY = [
      '### Done',
      '',
      '[Read full result](https://github.com/netlify-labs/agent-runner-action-example/issues/1#issuecomment-55)',
      '',
      '<!-- netlify-agent-runner-id:runner -->',
      STATUS_COMMENT_MARKER,
    ].join('\n');
    process.env.STATUS_COMMENT_ID = '55';
    process.env.BOT_LOGIN = 'github-actions[bot]';
    process.env.SESSION_DATA_MAP = '{}';

    await crossPostToPR({ github, context: context(), core: {} });

    assert.equal(created.length, 3);
    assert.equal(created[0].issue_number, 7);
    assert.equal(created[0].body, resultBody);
    assert.equal(created[1].issue_number, 7);
    assert.ok(created[1].body.includes('https://github.com/netlify-labs/agent-runner-action-example/issues/7#issuecomment-101'));
    assert.ok(created[1].body.includes(STATUS_COMMENT_MARKER));
    assert.equal(created[2].issue_number, 7);
    assert.ok(created[2].body.includes(HISTORY_COMMENT_MARKER));
    assert.equal(updated.length, 1);
    assert.ok(updated[0].body.includes('issues/1#issuecomment-55'));
    assert.ok(updated[0].body.includes('Leave follow-up `@netlify` prompts on PR #7'));
  });

  it('does not duplicate redirect notes', () => {
    const body = crossPostToPR.insertRedirectNote(
      '### Done\n\n> Leave follow-up `@netlify` prompts on PR #7, or use dashboard.',
      7,
      'https://app'
    );
    assert.equal(
      body,
      '### Done\n\n> Leave follow-up `@netlify` prompts on PR #7, or use dashboard.'
    );
  });
});
