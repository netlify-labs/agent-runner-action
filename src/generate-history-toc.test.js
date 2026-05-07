const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  parseResultSummary,
  renderHistoryTocFromComments,
} = require('./generate-history-toc');
const { HISTORY_COMMENT_MARKER } = require('./comment-markers');

describe('parseResultSummary', () => {
  it('extracts run number, model, and status from result comment headers', () => {
    assert.deepEqual(
      parseResultSummary('### [Run #3 | codex | Agent Run completed](https://app) OK\n\nbody'),
      { runNumber: '3', model: 'codex', status: 'completed' }
    );
    assert.deepEqual(
      parseResultSummary('### [Run #4 | claude | Agent Run failed](https://app) FAILED\n\nbody'),
      { runNumber: '4', model: 'claude', status: 'failed' }
    );
  });
});

describe('renderHistoryTocFromComments', () => {
  it('renders bot-authored result comments newest-first', () => {
    const comments = [
      {
        id: 1,
        issue_number: 9,
        created_at: '2026-05-07T10:00:00Z',
        user: { login: 'github-actions[bot]' },
        body: '### [Run #1 | codex | Agent Run completed](https://app) OK\n\n<!-- netlify-agent-run-result:runner:session1 -->',
      },
      {
        id: 2,
        issue_number: 9,
        created_at: '2026-05-07T11:00:00Z',
        user: { login: 'github-actions[bot]' },
        body: '### [Run #2 | codex | Agent Run failed](https://app) FAILED\n\n<!-- netlify-agent-run-result:runner:session2 -->',
      },
    ];

    const body = renderHistoryTocFromComments({
      comments,
      botLogin: 'github-actions[bot]',
      repoUrl: 'https://github.com/o/r',
    });

    assert.ok(body.includes(HISTORY_COMMENT_MARKER));
    assert.ok(body.indexOf('Run #2') < body.indexOf('Run #1'));
    assert.ok(body.includes('https://github.com/o/r/issues/9#issuecomment-2'));
  });

  it('excludes non-bot and invalid marker comments', () => {
    const comments = [
      {
        id: 1,
        issue_number: 9,
        created_at: '2026-05-07T10:00:00Z',
        user: { login: 'attacker' },
        body: '### [Run #1 | codex | Agent Run completed](https://app) OK\n\n<!-- netlify-agent-run-result:runner:session1 -->',
      },
      {
        id: 2,
        issue_number: 9,
        created_at: '2026-05-07T11:00:00Z',
        user: { login: 'github-actions[bot]' },
        body: '### [Run #2 | codex | Agent Run completed](https://app) OK\n\n<!-- netlify-agent-run-result:bad/id:session2 -->',
      },
      {
        id: 3,
        issue_number: 9,
        created_at: '2026-05-07T12:00:00Z',
        user: { login: 'github-actions[bot]' },
        body: 'regular comment',
      },
    ];

    const body = renderHistoryTocFromComments({
      comments,
      botLogin: 'github-actions[bot]',
      repoUrl: 'https://github.com/o/r',
    });

    assert.equal(body, '');
  });

  it('emits a one-row TOC for the first PR run', () => {
    const body = renderHistoryTocFromComments({
      comments: [{
        id: 1,
        issue_number: 9,
        created_at: '2026-05-07T10:00:00Z',
        user: { login: 'github-actions[bot]' },
        body: '### [Run #1 | codex | Agent Run completed](https://app) OK\n\n<!-- netlify-agent-run-result:runner:session1 -->',
      }],
      botLogin: 'github-actions[bot]',
      repoUrl: 'https://github.com/o/r',
    });
    assert.ok(body.includes('Run #1'));
    assert.ok(body.includes(HISTORY_COMMENT_MARKER));
  });
});
