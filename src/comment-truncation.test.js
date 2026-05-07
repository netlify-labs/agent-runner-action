const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  STATUS_COMMENT_VISIBLE_BYTES,
  MAX_RESULT_BODY_LENGTH,
  byteLength,
  truncateAtBoundary,
  assembleStatusBody,
  truncateResultBody,
} = require('./comment-truncation');

describe('comment-truncation constants', () => {
  it('exports the comment size budgets', () => {
    assert.equal(STATUS_COMMENT_VISIBLE_BYTES, 1000);
    assert.equal(MAX_RESULT_BODY_LENGTH, 60000);
  });
});

describe('truncateAtBoundary', () => {
  it('keeps text that already fits', () => {
    assert.equal(truncateAtBoundary('short text', 50), 'short text');
  });

  it('prefers paragraph boundaries', () => {
    const text = 'First paragraph.\n\nSecond paragraph is very long and should not fit.';
    assert.equal(truncateAtBoundary(text, 25), 'First paragraph....');
  });

  it('falls back to sentence and word boundaries', () => {
    assert.equal(
      truncateAtBoundary('First sentence. Second sentence is much longer.', 25),
      'First sentence....'
    );
    assert.equal(truncateAtBoundary('alpha beta gamma delta', 15), 'alpha beta...');
  });

  it('uses byte-safe fallback for long unbroken text', () => {
    const out = truncateAtBoundary('abcdefghij', 7);
    assert.equal(out, 'abcd...');
    assert.ok(byteLength(out) <= 7);
  });

  it('does not cut inside a markdown link when a prior boundary exists', () => {
    const text = 'See [important link](https://example.com/very/long/path) after';
    const out = truncateAtBoundary(text, 35);
    assert.equal(out, 'See...');
  });
});

describe('assembleStatusBody', () => {
  const markers = [
    '<!-- netlify-agent-session-data:{} -->',
    '<!-- netlify-agent-runner-id:runner -->',
    '<!-- netlify-agent-run-status -->',
  ];

  it('emits required fields and trailing markers', () => {
    const body = assembleStatusBody({
      header: '### [Netlify Agent Run Status](https://app.netlify.com/runs/1) ✅',
      subtitle: 'Netlify Agent Run completed.',
      screenshot: '<img src="https://example.com/preview.png" width="250">',
      resultCommentLink: '[Read full result](#issuecomment-1)',
      links: ['[Agent run](https://app.netlify.com/runs/1)'],
      title: 'Run #1 | codex | completed at 2026-05-07T00:00:00Z\n\n**Prompt summary:** Updated the page',
      markers,
      budget: 1000,
    });

    assert.ok(body.indexOf('<img src="https://example.com/preview.png"') < body.indexOf('Run #1 | codex'));
    assert.ok(body.indexOf('**Prompt summary:** Updated the page') < body.indexOf('[Read full result](#issuecomment-1)'));
    assert.ok(body.includes('[Read full result](#issuecomment-1)'));
    assert.ok(body.endsWith(markers.join('\n')));
  });

  it('drops optional fields in documented order under tight budgets', () => {
    const body = assembleStatusBody({
      header: '### Done',
      subtitle: 'Run #1 | codex',
      resultCommentLink: '[Read full result](#issuecomment-1)',
      screenshot: '<img src="https://example.com/preview.png" width="250">',
      title: 'A moderately long title that should be truncated',
      links: '[Agent run](https://app.netlify.com/runs/1)',
      markers,
      budget: 70,
    });

    assert.ok(!body.includes('<img'));
    assert.ok(!body.includes('moderately long title that should be truncated'));
    assert.ok(body.includes('[Read full result](#issuecomment-1)'));
    assert.ok(body.includes('<!-- netlify-agent-run-status -->'));
  });

  it('keeps redirect notes as required fields when present', () => {
    const body = assembleStatusBody({
      header: '### Done',
      subtitle: 'Run #1 | codex',
      resultCommentLink: '[Read full result](#issuecomment-1)',
      redirectNote: '> Continue on PR #4.',
      markers,
      budget: 1000,
    });
    assert.ok(body.includes('> Continue on PR #4.'));
  });
});

describe('truncateResultBody', () => {
  it('leaves result bodies below the limit unchanged', () => {
    assert.equal(truncateResultBody('small body'), 'small body');
  });

  it('adds a dashboard tail when truncating long results', () => {
    const body = 'x'.repeat(MAX_RESULT_BODY_LENGTH + 100);
    const out = truncateResultBody(body, 'https://app.netlify.com/projects/site/agent-runs/run');
    assert.ok(byteLength(out) <= MAX_RESULT_BODY_LENGTH);
    assert.ok(out.includes('Result truncated for GitHub'));
    assert.ok(out.includes('https://app.netlify.com/projects/site/agent-runs/run'));
  });
});
