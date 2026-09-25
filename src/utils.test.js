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

  it('ignores @netlify mentions inside inline code spans', () => {
    assert.ok(!utils.matchesTrigger('See `@netlify` documentation for context'));
    assert.ok(!utils.matchesTrigger('the ``@netlify`` token is a marker'));
    assert.ok(!utils.matchesTrigger('one `@netlify` and another `@netlify` quoted'));
  });

  it('ignores @netlify mentions inside fenced code blocks', () => {
    const fenced = [
      'Here is some yaml:',
      '```yaml',
      'on: issue_comment # @netlify',
      '```',
    ].join('\n');
    assert.ok(!utils.matchesTrigger(fenced));

    const tildeFenced = '~~~\n@netlify run\n~~~';
    assert.ok(!utils.matchesTrigger(tildeFenced));
  });

  it('still matches when an unbacticked @netlify appears alongside quoted ones', () => {
    assert.ok(utils.matchesTrigger('the `@netlify` mention is what fires; please @netlify do the thing'));
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

  it('does not truncate prompts at or under 350 characters', () => {
    const prompt = 'a'.repeat(350);
    const result = utils.formatPromptBlock(prompt, 'https://github.com/foo/bar/issues/1');
    assert.ok(!result.includes('…'));
    assert.ok(!result.includes('See full prompt'));
  });

  it('truncates prompts over 350 characters and links to source', () => {
    const prompt = 'a'.repeat(500);
    const sourceUrl = 'https://github.com/foo/bar/issues/1#issue-123';
    const result = utils.formatPromptBlock(prompt, sourceUrl);
    assert.ok(result.includes('…'));
    assert.ok(result.includes(`[See full prompt](${sourceUrl})`));
    assert.ok(!result.includes('a'.repeat(351)));
  });

  it('truncates without link when no sourceUrl provided', () => {
    const prompt = 'a'.repeat(500);
    const result = utils.formatPromptBlock(prompt);
    assert.ok(result.includes('…'));
    assert.ok(!result.includes('See full prompt'));
  });

  it('truncates at last newline before limit to avoid mid-line cuts', () => {
    // 300 chars on first line, newline, then 200 more chars
    const prompt = 'a'.repeat(300) + '\n' + 'x'.repeat(200);
    const result = utils.formatPromptBlock(prompt);
    assert.ok(result.includes('…'));
    // Should cut at the newline (char 300), not mid-way through the x's
    assert.ok(!result.includes('x'), 'should not include content after the newline');
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
    assert.ok(result.includes('### Netlify Agent Run Status'));
    assert.ok(!/^### Netlify Agent Run Status \S/m.test(result));
    assert.ok(utils.FLAVOR_MESSAGES.some(([flavor, emoji]) => result.includes(`Netlify Agent Runners ${flavor} ${emoji}`)));
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

// ---------------------------------------------------------------------------
// escapeAttr / safeHttpUrl / escapeMarkdownLinks
// ---------------------------------------------------------------------------
describe('escapeAttr', () => {
  it('escapes the four attribute-breaking characters', () => {
    assert.equal(utils.escapeAttr('a"b<c>d&e'), 'a&quot;b&lt;c&gt;d&amp;e');
  });

  it('blocks the issue #16 attribute-injection payload', () => {
    const payload = 'https://evil.tld" onmouseover="alert(1)" data-x="';
    assert.ok(!utils.escapeAttr(payload).includes('"'));
  });

  it('handles null/undefined', () => {
    assert.equal(utils.escapeAttr(null), '');
    assert.equal(utils.escapeAttr(undefined), '');
  });
});

describe('safeHttpUrl', () => {
  it('accepts plain http(s) URLs', () => {
    assert.equal(utils.safeHttpUrl('https://netlify.com/x'), 'https://netlify.com/x');
    assert.equal(utils.safeHttpUrl('http://example.com'), 'http://example.com');
  });

  it('rejects URLs with quotes, whitespace, or angle brackets', () => {
    assert.equal(utils.safeHttpUrl('https://evil.tld" onmouseover="alert(1)'), '');
    assert.equal(utils.safeHttpUrl('https://a b.com'), '');
    assert.equal(utils.safeHttpUrl('https://a<b>.com'), '');
  });

  it('rejects non-http(s) schemes', () => {
    assert.equal(utils.safeHttpUrl('javascript:alert(1)'), '');
    assert.equal(utils.safeHttpUrl('data:text/html,foo'), '');
    assert.equal(utils.safeHttpUrl('file:///etc/passwd'), '');
  });

  it('handles empty input', () => {
    assert.equal(utils.safeHttpUrl(''), '');
    assert.equal(utils.safeHttpUrl(null), '');
  });
});

describe('escapeMarkdownLinks', () => {
  it('escapes [ so [label](url) cannot form', () => {
    assert.equal(utils.escapeMarkdownLinks('[click](https://evil.tld)'), '\\[click](https://evil.tld)');
  });

  it('leaves prose without brackets unchanged', () => {
    assert.equal(utils.escapeMarkdownLinks('Result complete.'), 'Result complete.');
  });
});

// ---------------------------------------------------------------------------
// extractEffort / normalizeEffort
// ---------------------------------------------------------------------------
describe('extractEffort', () => {
  it('reads the effort word directly after the agent', () => {
    assert.equal(utils.extractEffort('@netlify claude high fix the bug'), 'high');
    assert.equal(utils.extractEffort('@netlify codex xhigh add tests'), 'xhigh');
    assert.equal(utils.extractEffort('@netlify with gemini LOW refactor'), 'low');
    assert.equal(utils.extractEffort('@netlify claude max'), 'max');
  });

  it('accepts a colon boundary after the effort word', () => {
    assert.equal(utils.extractEffort('@netlify codex low: fix the typo'), 'low');
  });

  it('defaults to Auto (empty string) when no effort is given', () => {
    assert.equal(utils.extractEffort('@netlify claude fix the bug'), '');
    assert.equal(utils.extractEffort('@netlify fix the bug'), '');
    assert.equal(utils.extractEffort(''), '');
    assert.equal(utils.extractEffort(null), '');
  });

  it('does not treat hyphenated or embedded words as effort', () => {
    assert.equal(utils.extractEffort('@netlify codex low-hanging fixes'), '');
    assert.equal(utils.extractEffort('@netlify claude highlight the nav'), '');
    assert.equal(utils.extractEffort('@netlify claude maximize images'), '');
  });

  it('requires an agent before a positional effort word', () => {
    assert.equal(utils.extractEffort('@netlify high contrast mode'), '');
  });

  it('lets an explicit effort token win over the positional word', () => {
    assert.equal(utils.extractEffort('@netlify claude high priority: fix login effort:low'), 'low');
    assert.equal(utils.extractEffort('@netlify add pagination effort=medium'), 'medium');
    assert.equal(utils.extractEffort('@netlify claude high fix effort:auto', 'max'), '');
  });

  it('only reads effort from lines that mention @netlify', () => {
    assert.equal(utils.extractEffort('Thanks!\n@netlify claude high fix it'), 'high');
    assert.equal(utils.extractEffort('@netlify claude fix it\n\nnotes: effort:high'), '');
  });

  it('ignores effort inside code spans', () => {
    assert.equal(utils.extractEffort('@netlify claude fix `effort:high` parsing'), '');
  });

  it('uses a valid default when nothing matches', () => {
    assert.equal(utils.extractEffort('@netlify claude fix it', 'medium'), 'medium');
    assert.equal(utils.extractEffort('@netlify claude fix it', 'bogus'), '');
    assert.equal(utils.extractEffort('@netlify claude low fix it', 'max'), 'low');
  });
});

describe('normalizeEffort', () => {
  it('maps empty and auto to Auto, and rejects unknown values', () => {
    assert.equal(utils.normalizeEffort(''), '');
    assert.equal(utils.normalizeEffort(undefined), '');
    assert.equal(utils.normalizeEffort(' AUTO '), '');
    assert.equal(utils.normalizeEffort('High'), 'high');
    assert.equal(utils.normalizeEffort('extreme'), null);
  });
});

describe('cleanPrompt with effort', () => {
  it('strips the agent and effort prefix', () => {
    assert.equal(utils.cleanPrompt('@netlify claude high Fix the header'), 'Fix the header');
    assert.equal(utils.cleanPrompt('@netlify codex low: Fix the typo'), 'Fix the typo');
  });

  it('keeps words that are not effort levels', () => {
    assert.equal(utils.cleanPrompt('@netlify codex low-hanging fixes'), 'low-hanging fixes');
  });

  it('strips an explicit effort token', () => {
    assert.equal(utils.cleanPrompt('@netlify Add pagination effort:medium'), 'Add pagination');
  });
});

describe('buildInProgressComment effort', () => {
  it('shows effort next to the agent when set', () => {
    const body = utils.buildInProgressComment({ prompt: '@netlify claude high Fix it', model: 'claude', effort: 'high' });
    assert.match(body, /\*\*Agent:\*\* `claude` · \*\*Effort:\*\* `high`/);
  });

  it('omits effort when Auto', () => {
    const body = utils.buildInProgressComment({ prompt: '@netlify claude Fix it', model: 'claude', effort: '' });
    assert.doesNotMatch(body, /Effort/);
  });
});

// ---------------------------------------------------------------------------
// Model selection: parseSelection / resolveSelection
// ---------------------------------------------------------------------------
describe('model selection', () => {
  /** @param {string} text @param {object} [defaults] */
  function pick(text, defaults = {}) {
    return utils.resolveSelection(utils.parseSelection(text), { defaultAgent: 'codex', ...defaults });
  }

  it('reads a standalone Claude model alias and infers the agent', () => {
    const r = pick('@netlify fable high Fix it');
    assert.equal(r.agent, 'claude');
    assert.equal(r.modelId, 'claude-fable-5');
    assert.equal(r.modelLabel, 'Fable 5');
    assert.equal(r.effort, 'high');
    assert.deepEqual(r.warnings, []);
  });

  it('reads agent, model, and effort in order', () => {
    const r = pick('@netlify claude fable high Fix it');
    assert.deepEqual([r.agent, r.modelId, r.effort], ['claude', 'claude-fable-5', 'high']);
  });

  it('reads a selector suffix such as @netlify-fable', () => {
    const r = pick('@netlify-fable high Fix it');
    assert.deepEqual([r.agent, r.modelId, r.effort], ['claude', 'claude-fable-5', 'high']);
    const c = pick('@netlify-claude sonnet Fix it');
    assert.deepEqual([c.agent, c.modelId], ['claude', 'claude-sonnet-5']);
  });

  it('keeps model Auto when only agent and effort are named', () => {
    const r = pick('@netlify claude high Fix it');
    assert.deepEqual([r.agent, r.modelId, r.effort], ['claude', '', 'high']);
  });

  it('requires the agent for short Codex and Gemini aliases', () => {
    assert.equal(pick('@netlify codex sol medium: tune').modelId, 'gpt-5.6-sol');
    assert.equal(pick('@netlify gemini flash Fix').modelId, 'gemini-3.6-flash');
    assert.equal(pick('@netlify gemini flash-lite Fix').modelId, 'gemini-3.5-flash-lite');
    assert.equal(pick('@netlify pro tip: fix it').modelId, '');
    assert.equal(pick('@netlify sol fix it').modelId, '');
  });

  it('accepts versioned aliases and exact model IDs', () => {
    assert.equal(pick('@netlify opus-4.8 low go').modelId, 'claude-opus-4-8');
    assert.equal(pick('@netlify claude-fable-5 high x').modelId, 'claude-fable-5');
    assert.equal(pick('@netlify gpt-5.4-mini x').agent, 'codex');
  });

  it('switches to the model agent with a warning on a mismatch', () => {
    const r = pick('@netlify codex fable high x');
    assert.deepEqual([r.agent, r.modelId, r.effort], ['claude', 'claude-fable-5', 'high']);
    assert.match(r.warnings[0], /Fable 5 runs on claude, not codex/);
  });

  it('drops an effort the model does not support', () => {
    const r = pick('@netlify fable max Fix');
    assert.equal(r.modelId, 'claude-fable-5');
    assert.equal(r.effort, '');
    assert.match(r.warnings[0], /"max" is not supported by Fable 5/);
  });

  it('passes an explicit uncataloged model through with a warning', () => {
    const r = pick('@netlify Build model:gpt-9 effort:low');
    assert.deepEqual([r.agent, r.modelId, r.effort], ['codex', 'gpt-9', 'low']);
    assert.match(r.warnings[0], /not in the action's catalog/);
  });

  it('does not read ordinary prompt words as selectors', () => {
    for (const text of ['@netlify high contrast mode', '@netlify use flexbox for layout', '@netlify codex low-hanging fixes']) {
      const r = pick(text);
      assert.equal(r.modelId, '', text);
      assert.equal(r.effort, '', text);
    }
  });

  it('applies default-model-id only when it matches the mention agent', () => {
    assert.equal(pick('@netlify Fix it', { defaultModelId: 'fable' }).modelId, 'claude-fable-5');
    assert.equal(pick('@netlify Fix it', { defaultModelId: 'fable' }).agent, 'claude');
    const other = pick('@netlify codex Fix it', { defaultModelId: 'fable' });
    assert.deepEqual([other.agent, other.modelId], ['codex', '']);
    assert.deepEqual(other.warnings, []);
    assert.equal(pick('@netlify fable Fix it', { defaultModelId: 'auto' }).modelId, 'claude-fable-5');
  });

  it('resolves any alias in default-model-id', () => {
    const r = pick('@netlify Fix it', { defaultModelId: 'sol' });
    assert.deepEqual([r.agent, r.modelId], ['codex', 'gpt-5.6-sol']);
  });

  it('lets a mention model override default-model-id', () => {
    assert.equal(pick('@netlify sonnet Fix', { defaultModelId: 'claude-fable-5' }).modelId, 'claude-sonnet-5');
  });

  it('extractModel returns the agent implied by a model', () => {
    assert.equal(utils.extractModel('@netlify fable fix it', 'codex'), 'claude');
    assert.equal(utils.extractModel('@netlify fix it', 'codex'), 'codex');
  });
});

describe('TRIGGER_PATTERN selector suffixes', () => {
  it('matches agent and model suffixes', () => {
    for (const s of ['@netlify-fable', '@netlify-claude', '@netlify_codex', '@netlify-opus', '@netlify-sonnet']) {
      assert.ok(utils.matchesTrigger(s), s);
    }
  });

  it('still rejects unknown suffixes and scopes', () => {
    for (const s of ['@netlify-fables', '@netlify-foo', '@netlify/fable']) {
      assert.ok(!utils.matchesTrigger(s), s);
    }
  });
});

describe('cleanPrompt with models', () => {
  it('strips agent, model, effort, and a trailing separator', () => {
    assert.equal(utils.cleanPrompt('@netlify claude fable high Fix it'), 'Fix it');
    assert.equal(utils.cleanPrompt('@netlify-fable high: Fix it'), 'Fix it');
    assert.equal(utils.cleanPrompt('@netlify fable, fix it'), 'fix it');
    assert.equal(utils.cleanPrompt('@netlify Build model:gpt-9 effort:low'), 'Build');
  });

  it('keeps text before the mention', () => {
    assert.equal(utils.cleanPrompt('Thanks!\n@netlify sonnet fix'), 'Thanks!\nfix');
  });
});

describe('buildInProgressComment model', () => {
  it('shows model label and warnings', () => {
    const body = utils.buildInProgressComment({
      prompt: '@netlify codex fable high Fix it',
      model: 'claude',
      modelLabel: 'Fable 5',
      effort: 'high',
      configWarnings: 'Model Fable 5 runs on claude, not codex; using claude.',
    });
    assert.match(body, /\*\*Agent:\*\* `claude` · \*\*Model:\*\* Fable 5 · \*\*Effort:\*\* `high`/);
    assert.match(body, /> ⚠️ Model Fable 5 runs on claude/);
  });
});

describe('scope block', () => {
  it('builds the default, custom, and disabled blocks', () => {
    assert.equal(utils.buildScopeBlock('default'), `\n\n---\n${utils.SCOPE_BLOCK_HEADER}\n${utils.DEFAULT_SCOPE_GUIDANCE}`);
    assert.equal(utils.buildScopeBlock(undefined), utils.buildScopeBlock('default'));
    assert.equal(utils.buildScopeBlock('  Keep changes small.  '), `\n\n---\n${utils.SCOPE_BLOCK_HEADER}\nKeep changes small.`);
    assert.equal(utils.buildScopeBlock(''), '');
    assert.equal(utils.buildScopeBlock('none'), '');
    assert.equal(utils.buildScopeBlock(' NONE '), '');
  });

  it('is stripped from every displayed prompt, including CRLF bodies', () => {
    const block = utils.buildScopeBlock('default');
    assert.equal(utils.cleanPrompt(`@netlify fable fix it\n\n◌ https://github.com/o/r/issues/1${block}`), 'fix it\n\nvia https://github.com/o/r/issues/1');
    assert.equal(utils.stripScopeBlock(`fix it${block.replace(/\n/g, '\r\n')}`), 'fix it');
  });

  it('does not truncate a user prompt that contains its own --- separator', () => {
    const prompt = '@netlify write docs\n\n---\nKeep this part';
    assert.equal(utils.cleanPrompt(prompt), 'write docs\n\n---\nKeep this part');
  });
});

describe('describeRunConfig', () => {
  it('uses catalog labels and user-facing effort levels', () => {
    assert.equal(utils.describeRunConfig({ agent: 'claude', model: 'claude-fable-5', effort: 'high' }), 'claude · Fable 5 · high');
    assert.equal(utils.describeRunConfig({ agent: 'opencode', model: 'z-ai/glm-5.2', effort: 'xhigh' }), 'opencode · GLM 5.2 · max');
    assert.equal(utils.describeRunConfig({ agent: 'codex' }), 'codex');
    assert.equal(utils.describeRunConfig({ agent: 'claude', effort: 'high' }), 'claude · high');
    assert.equal(utils.describeRunConfig({ agent: 'opencode', model: 'vendor/new-model', effort: 'max' }), 'opencode · vendor/new-model · max');
    assert.equal(utils.describeRunConfig({}), 'codex');
  });
});
