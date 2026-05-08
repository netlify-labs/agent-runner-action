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
      parseResultSummary('### [Run #3 | codex | Agent Run completed](https://app) ✅\n\nbody'),
      {
        runNumber: '3',
        model: 'codex',
        status: 'completed',
        agentRunUrl: 'https://app',
        title: '',
        promptBlock: '',
        screenshotHtml: '',
        links: '',
      }
    );
    assert.deepEqual(
      parseResultSummary('### [Run #4 | claude | Agent Run failed](https://app) ❌\n\nbody'),
      {
        runNumber: '4',
        model: 'claude',
        status: 'failed',
        agentRunUrl: 'https://app',
        title: '',
        promptBlock: '',
        screenshotHtml: '',
        links: '',
      }
    );
  });
});

describe('renderHistoryTocFromComments', () => {
  it('renders bot-authored result comments as a rich newest-first history', () => {
    const comments = [
      {
        id: 1,
        issue_number: 9,
        created_at: '2026-05-07T10:00:00Z',
        user: { login: 'github-actions[bot]' },
        body: [
          '### [Run #1 | codex | Agent Run completed](https://app) ✅',
          '',
          '**Prompt:**',
          '',
          '> **build page**',
          '',
          '### Result: First title',
          '',
          '[Agent run](https://app) | [Action logs](https://github.com/o/r/actions/runs/1)',
          '',
          '<!-- netlify-agent-run-result:runner:session1 -->',
        ].join('\n'),
      },
      {
        id: 2,
        issue_number: 9,
        created_at: '2026-05-07T11:00:00Z',
        user: { login: 'github-actions[bot]' },
        body: [
          '### [Run #2 | codex | Agent Run failed](https://app) ❌',
          '',
          '**Prompt:**',
          '',
          '> **fix page**',
          '',
          '### Result: Second title',
          '',
          '[Agent run](https://app) | [Action logs](https://github.com/o/r/actions/runs/2)',
          '',
          '<!-- netlify-agent-run-result:runner:session2 -->',
        ].join('\n'),
      },
    ];

    const body = renderHistoryTocFromComments({
      comments,
      botLogin: 'github-actions[bot]',
      repoUrl: 'https://github.com/o/r',
    });

    assert.ok(body.includes(HISTORY_COMMENT_MARKER));
    assert.ok(body.includes('### Netlify Agent Run History'));
    assert.ok(body.includes('View the full history in [Netlify Agent Run dashboard](https://app)'));
    assert.ok(body.indexOf('Run 2') < body.indexOf('Run 1'));
    assert.ok(body.includes('Second title'));
    assert.ok(body.includes('**Prompt:**'));
    assert.ok(body.includes('[Netlify Agents run](https://app) • [Action logs](https://github.com/o/r/actions/runs/2)'));
  });

  it('excludes non-bot and invalid marker comments', () => {
    const comments = [
      {
        id: 1,
        issue_number: 9,
        created_at: '2026-05-07T10:00:00Z',
        user: { login: 'attacker' },
        body: '### [Run #1 | codex | Agent Run completed](https://app) ✅\n\n<!-- netlify-agent-run-result:runner:session1 -->',
      },
      {
        id: 2,
        issue_number: 9,
        created_at: '2026-05-07T11:00:00Z',
        user: { login: 'github-actions[bot]' },
        body: '### [Run #2 | codex | Agent Run completed](https://app) ✅\n\n<!-- netlify-agent-run-result:bad/id:session2 -->',
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
        body: '### [Run #1 | codex | Agent Run completed](https://app) ✅\n\n<!-- netlify-agent-run-result:runner:session1 -->',
      }],
      botLogin: 'github-actions[bot]',
      repoUrl: 'https://github.com/o/r',
    });
    assert.ok(body.includes('Run 1'));
    assert.ok(body.includes(HISTORY_COMMENT_MARKER));
  });
});
