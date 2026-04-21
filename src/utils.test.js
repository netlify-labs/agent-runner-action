const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const utils = require('./utils');

// ---------------------------------------------------------------------------
// matchesTrigger
// ---------------------------------------------------------------------------
describe('matchesTrigger', () => {
  it('matches @netlify', () => {
    assert.ok(utils.matchesTrigger('@netlify build a page'));
  });

  it('matches common typos', () => {
    const typos = ['@nelify', '@netlfy', '@netify', '@netlif', '@netfly'];
    for (const typo of typos) {
      assert.ok(utils.matchesTrigger(`${typo} do something`), `should match ${typo}`);
    }
  });

  it('matches aliases with suffixes', () => {
    const aliases = [
      '@netlify-agent', '@netlify-agents', '@netlify-agent-run',
      '@netlify-agent-runs', '@netlify-ai',
      '@netlify_agent', '@netlify_agents',
    ];
    for (const alias of aliases) {
      assert.ok(utils.matchesTrigger(`${alias} do something`), `should match ${alias}`);
    }
  });

  it('is case-insensitive', () => {
    assert.ok(utils.matchesTrigger('@Netlify build'));
    assert.ok(utils.matchesTrigger('@NETLIFY build'));
  });

  it('returns false for non-triggers', () => {
    assert.ok(!utils.matchesTrigger('just a regular comment'));
    assert.ok(!utils.matchesTrigger(''));
    assert.ok(!utils.matchesTrigger(null));
    assert.ok(!utils.matchesTrigger(undefined));
  });

  it('does not match package scopes or email-like text', () => {
    assert.ok(!utils.matchesTrigger('Install `@netlify/pkg` before testing'));
    assert.ok(!utils.matchesTrigger('See @netlify-labs/test-dep for context'));
    assert.ok(!utils.matchesTrigger('email me@netlify.com'));
  });

  it('matches trigger mid-text', () => {
    assert.ok(utils.matchesTrigger('please @netlify build a page'));
  });
});

// ---------------------------------------------------------------------------
// extractModel
// ---------------------------------------------------------------------------
describe('extractModel', () => {
  it('extracts model after @netlify', () => {
    assert.equal(utils.extractModel('@netlify claude fix the bug'), 'claude');
    assert.equal(utils.extractModel('@netlify codex add tests'), 'codex');
    assert.equal(utils.extractModel('@netlify gemini refactor'), 'gemini');
  });

  it('extracts model with prepositions', () => {
    assert.equal(utils.extractModel('@netlify with claude fix it'), 'claude');
    assert.equal(utils.extractModel('@netlify using codex'), 'codex');
    assert.equal(utils.extractModel('@netlify via gemini'), 'gemini');
    assert.equal(utils.extractModel('@netlify use claude'), 'claude');
  });

  it('returns default when no model specified', () => {
    assert.equal(utils.extractModel('@netlify build a page'), 'codex');
    assert.equal(utils.extractModel('@netlify build a page', 'claude'), 'claude');
  });

  it('is case-insensitive', () => {
    assert.equal(utils.extractModel('@netlify Claude fix'), 'claude');
    assert.equal(utils.extractModel('@NETLIFY CODEX fix'), 'codex');
  });

  it('works with typos', () => {
    assert.equal(utils.extractModel('@nelify claude fix'), 'claude');
    assert.equal(utils.extractModel('@netlfy codex fix'), 'codex');
  });

  it('handles empty/null input', () => {
    assert.equal(utils.extractModel(''), 'codex');
    assert.equal(utils.extractModel(null), 'codex');
    assert.equal(utils.extractModel(undefined, 'gemini'), 'gemini');
  });
});

// ---------------------------------------------------------------------------
// cleanPrompt
// ---------------------------------------------------------------------------
describe('cleanPrompt', () => {
  it('strips @netlify prefix', () => {
    assert.equal(utils.cleanPrompt('@netlify build a page'), 'build a page');
  });

  it('strips @netlify with model', () => {
    assert.equal(utils.cleanPrompt('@netlify claude fix the bug'), 'fix the bug');
    assert.equal(utils.cleanPrompt('@netlify with codex add tests'), 'add tests');
  });

  it('strips typo variants', () => {
    assert.equal(utils.cleanPrompt('@nelify build a page'), 'build a page');
    assert.equal(utils.cleanPrompt('@netlfy codex do it'), 'do it');
  });

  it('replaces ◌ marker with via', () => {
    assert.equal(
      utils.cleanPrompt('@netlify do it\n\n◌ https://github.com/foo'),
      'do it\n\nvia https://github.com/foo'
    );
  });

  it('handles empty/null input', () => {
    assert.equal(utils.cleanPrompt(''), '');
    assert.equal(utils.cleanPrompt(null), '');
    assert.equal(utils.cleanPrompt(undefined), '');
  });

  it('handles text without trigger', () => {
    assert.equal(utils.cleanPrompt('just some text'), 'just some text');
  });
});

// ---------------------------------------------------------------------------
// randomFlavor
// ---------------------------------------------------------------------------
describe('randomFlavor', () => {
  it('returns an array of [text, emoji]', () => {
    const result = utils.randomFlavor();
    assert.ok(Array.isArray(result));
    assert.equal(result.length, 2);
    assert.ok(typeof result[0] === 'string');
    assert.ok(typeof result[1] === 'string');
  });
});

// ---------------------------------------------------------------------------
// formatPromptBlock
// ---------------------------------------------------------------------------
describe('formatPromptBlock', () => {
  it('formats a single-line prompt', () => {
    const result = utils.formatPromptBlock('build a page');
    assert.ok(result.includes('**build a page**'));
    assert.ok(result.includes('> **build a page**'));
    assert.ok(result.includes('**Prompt:**'));
  });

  it('formats a multi-line prompt', () => {
    const result = utils.formatPromptBlock('line one\nline two');
    assert.ok(result.includes('> **line one**'));
    assert.ok(result.includes('> line two'));
  });

  it('returns empty for empty input', () => {
    assert.equal(utils.formatPromptBlock(''), '');
    assert.equal(utils.formatPromptBlock(null), '');
  });
});

// ---------------------------------------------------------------------------
// buildInProgressComment
// ---------------------------------------------------------------------------
describe('buildInProgressComment', () => {
  it('builds a basic in-progress comment', () => {
    const result = utils.buildInProgressComment({
      prompt: '@netlify build it', model: 'codex'
    });
    assert.ok(result.includes('Netlify Agent Runner'));
    assert.ok(result.includes('`codex`'));
    assert.ok(result.includes('<!-- netlify-agent-run-status -->'));
  });

  it('includes agent run URL when provided', () => {
    const result = utils.buildInProgressComment({
      agentRunUrl: 'https://app.netlify.com/projects/foo/agent-runs/123',
      prompt: '@netlify build',
      model: 'claude',
      runnerId: '123'
    });
    assert.ok(result.includes('https://app.netlify.com/projects/foo/agent-runs/123'));
    assert.ok(result.includes('<!-- netlify-agent-runner-id:123 -->'));
  });
});

// ---------------------------------------------------------------------------
// FLAVOR_MESSAGES
// ---------------------------------------------------------------------------
describe('FLAVOR_MESSAGES', () => {
  it('has entries', () => {
    assert.ok(utils.FLAVOR_MESSAGES.length > 0);
  });

  it('each entry is [string, string]', () => {
    for (const [text, emoji] of utils.FLAVOR_MESSAGES) {
      assert.ok(typeof text === 'string' && text.length > 0);
      assert.ok(typeof emoji === 'string' && emoji.length > 0);
    }
  });
});

// ---------------------------------------------------------------------------
// TRIGGER_PATTERN
// ---------------------------------------------------------------------------
describe('TRIGGER_PATTERN', () => {
  it('is a valid regex', () => {
    assert.ok(utils.TRIGGER_PATTERN instanceof RegExp);
  });

  it('matches expected patterns', () => {
    const shouldMatch = [
      '@netlify', '@nelify', '@netlfy', '@netify', '@netlif', '@netfly',
      '@netlify-agent', '@netlify-agents', '@netlify-ai',
      '@netlify_agent', '@netlify_agents',
      '@netlify-agent-run', '@netlify-agent-runs',
    ];
    for (const s of shouldMatch) {
      assert.ok(utils.TRIGGER_PATTERN.test(s), `should match: ${s}`);
    }
  });

  it('rejects partial matches inside longer identifiers', () => {
    const shouldNotMatch = [
      '@netlify/pkg',
      '@netlify-labs',
      '@netlify_agents_extra',
      'me@netlify.com',
    ];
    for (const s of shouldNotMatch) {
      assert.ok(!utils.TRIGGER_PATTERN.test(s), `should not match: ${s}`);
    }
  });
});
