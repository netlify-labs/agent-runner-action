const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const catalog = require('./agent-catalog');
const utils = require('./utils');

/**
 * @param {string} text
 * @param {{ defaultAgent?: string, defaultModelId?: string, defaultEffort?: string }} [defaults]
 */
function pick(text, defaults = {}) {
  return utils.resolveSelection(utils.parseSelection(text), { defaultAgent: 'codex', ...defaults });
}

// ---------------------------------------------------------------------------
// Catalog integrity
// ---------------------------------------------------------------------------
describe('agent catalog integrity', () => {
  it('matches the NAX / Netlify UI model snapshot', () => {
    // Update deliberately when re-syncing from NAX src/core/agents/configuration.js.
    assert.deepEqual(catalog.PROVIDERS, ['claude', 'codex', 'gemini', 'opencode']);
    assert.deepEqual(catalog.MODELS.map((model) => `${model.provider}:${model.id}`), [
      'claude:claude-opus-5',
      'claude:claude-opus-4-8',
      'claude:claude-fable-5',
      'claude:claude-sonnet-5',
      'claude:claude-haiku-4-5',
      'codex:gpt-5.6-sol',
      'codex:gpt-5.6-terra',
      'codex:gpt-5.6-luna',
      'codex:gpt-5.4-mini',
      'gemini:gemini-3.1-pro-preview',
      'gemini:gemini-3.6-flash',
      'gemini:gemini-3.5-flash-lite',
      'opencode:moonshotai/kimi-k3',
      'opencode:moonshotai/kimi-k2.7-code',
      'opencode:z-ai/glm-5.2',
      'opencode:deepseek/deepseek-v4-pro',
      'opencode:~deepseek/deepseek-v4-flash-latest',
      'opencode:x-ai/grok-4.5',
      'opencode:minimax/minimax-m3',
    ]);
  });

  it('matches the NAX per-model effort rules and wire translations', () => {
    const efforts = Object.fromEntries(catalog.MODELS.map((model) => [
      model.id,
      model.efforts.map((effort) => (effort.wire ? `${effort.id}->${effort.wire}` : effort.id)).join(','),
    ]));
    for (const model of catalog.MODELS.filter((entry) => entry.provider !== 'opencode')) {
      assert.equal(efforts[model.id], 'low,medium,high', model.id);
    }
    assert.equal(efforts['moonshotai/kimi-k3'], 'low,high,max');
    assert.equal(efforts['moonshotai/kimi-k2.7-code'], '');
    assert.equal(efforts['z-ai/glm-5.2'], 'high,max->xhigh');
    assert.equal(efforts['deepseek/deepseek-v4-pro'], 'high,max->xhigh');
    assert.equal(efforts['~deepseek/deepseek-v4-flash-latest'], 'low,high,max');
    assert.equal(efforts['x-ai/grok-4.5'], 'low,medium,high');
    assert.equal(efforts['minimax/minimax-m3'], '');
  });

  it('has unique, well-formed model IDs owned by known providers', () => {
    const ids = catalog.MODELS.map((model) => model.id);
    assert.equal(new Set(ids).size, ids.length);
    for (const model of catalog.MODELS) {
      assert.ok(catalog.PROVIDERS.includes(model.provider), model.id);
      assert.match(model.id, catalog.MODEL_ID_PATTERN, model.id);
      assert.ok(model.label, model.id);
    }
  });

  it('has aliases that are unique and never collide with agents, efforts, or connectors', () => {
    const reserved = new Set([...catalog.PROVIDERS, ...catalog.EFFORT_WORDS, 'with', 'using', 'use', 'via', 'auto']);
    const seen = new Map();
    for (const model of catalog.MODELS) {
      for (const alias of model.aliases) {
        assert.equal(alias, alias.toLowerCase(), alias);
        assert.ok(!reserved.has(alias), `alias "${alias}" is reserved`);
        assert.ok(!seen.has(alias), `alias "${alias}" used by ${seen.get(alias)} and ${model.id}`);
        assert.ok(!catalog.modelById(alias) || catalog.modelById(alias) === model, alias);
        seen.set(alias, model.id);
      }
    }
  });

  it('only uses known effort words, including wire values', () => {
    for (const model of catalog.MODELS) {
      for (const effort of model.efforts) {
        assert.ok(catalog.EFFORT_WORDS.includes(effort.id), `${model.id} ${effort.id}`);
        if (effort.wire) assert.ok(catalog.EFFORT_WORDS.includes(effort.wire), `${model.id} ${effort.wire}`);
      }
    }
  });

  it('only lists single-word standalone aliases as mention suffixes', () => {
    for (const suffix of catalog.STANDALONE_SUFFIXES) {
      assert.match(suffix, /^[a-z0-9]+$/, suffix);
      const model = catalog.resolveModelWord(suffix, null);
      assert.ok(model && model.standalone, suffix);
    }
  });
});

// ---------------------------------------------------------------------------
// Every catalog model and alias resolves from a mention
// ---------------------------------------------------------------------------
describe('every catalog model resolves from a mention', () => {
  for (const model of catalog.MODELS) {
    it(`${model.id} by exact ID, with and without its agent`, () => {
      for (const text of [`@netlify ${model.id} Fix it`, `@netlify ${model.provider} ${model.id} Fix it`]) {
        const r = pick(text);
        assert.equal(r.agent, model.provider, text);
        assert.equal(r.modelId, model.id, text);
        assert.equal(r.modelLabel, model.label, text);
        assert.deepEqual(r.warnings, [], text);
        assert.equal(utils.cleanPrompt(text), 'Fix it', text);
      }
    });

    for (const alias of model.aliases) {
      it(`${model.id} by alias "${alias}"`, () => {
        const withAgent = pick(`@netlify ${model.provider} ${alias} Fix it`);
        assert.equal(withAgent.modelId, model.id);
        assert.equal(withAgent.agent, model.provider);
        const alone = pick(`@netlify ${alias} Fix it`);
        if (model.standalone) {
          assert.equal(alone.modelId, model.id);
          assert.equal(alone.agent, model.provider);
        } else {
          assert.equal(alone.modelId, '', `"${alias}" must need the agent word`);
          assert.equal(alone.agent, 'codex');
        }
      });
    }

    for (const effort of model.efforts) {
      it(`${model.id} accepts effort "${effort.id}"`, () => {
        const r = pick(`@netlify ${model.provider} ${model.id} ${effort.id} Fix it`);
        assert.equal(r.effort, effort.wire || effort.id);
        assert.equal(r.effortLabel, effort.id);
        assert.deepEqual(r.warnings, []);
      });
    }

    for (const word of catalog.EFFORT_WORDS.filter((level) => !catalog.findEffort(model.efforts, level))) {
      it(`${model.id} rejects effort "${word}" with a warning`, () => {
        const r = pick(`@netlify ${model.id} ${word} Fix it`);
        assert.equal(r.modelId, model.id);
        assert.equal(r.effort, '');
        assert.equal(r.warnings.length, 1);
        assert.match(r.warnings[0], new RegExp(`"${word}" is not supported by ${model.label.replace(/\./g, '\\.')}`));
        assert.equal(utils.cleanPrompt(`@netlify ${model.id} ${word} Fix it`), 'Fix it');
      });
    }
  }
});

// ---------------------------------------------------------------------------
// Mention syntax edge cases
// ---------------------------------------------------------------------------
describe('mention syntax', () => {
  /** [text, agent, modelId, effort, cleaned prompt] */
  const cases = [
    ['@netlify fable high Fix it', 'claude', 'claude-fable-5', 'high', 'Fix it'],
    ['@Netlify Claude Fable HIGH Fix it', 'claude', 'claude-fable-5', 'high', 'Fix it'],
    ['@netlfy fable high Fix it', 'claude', 'claude-fable-5', 'high', 'Fix it'],
    ['@netlify-agent fable high Fix it', 'claude', 'claude-fable-5', 'high', 'Fix it'],
    ['@netlify with fable high Fix it', 'claude', 'claude-fable-5', 'high', 'Fix it'],
    ['@netlify using codex sol Fix it', 'codex', 'gpt-5.6-sol', '', 'Fix it'],
    ['@netlify\tfable\thigh\tFix it', 'claude', 'claude-fable-5', 'high', 'Fix it'],
    ['@netlify fable high', 'claude', 'claude-fable-5', 'high', ''],
    ['@netlify fable\nFix it', 'claude', 'claude-fable-5', '', 'Fix it'],
    ['@netlify fable high\r\nFix it', 'claude', 'claude-fable-5', 'high', 'Fix it'],
    ['@netlify claude\r\nFix it', 'claude', '', '', 'Fix it'],
    ['@netlify fable. Fix it', 'claude', 'claude-fable-5', '', 'Fix it'],
    ['@netlify fable, fix it', 'claude', 'claude-fable-5', '', 'fix it'],
    ['@netlify fable high: Fix it', 'claude', 'claude-fable-5', 'high', 'Fix it'],
    ['@netlify opus-4.8 Fix it', 'claude', 'claude-opus-4-8', '', 'Fix it'],
    ['@netlify kimi max Refactor', 'opencode', 'moonshotai/kimi-k3', 'max', 'Refactor'],
    ['@netlify-kimi max Refactor', 'opencode', 'moonshotai/kimi-k3', 'max', 'Refactor'],
    ['@netlify opencode k3 low Refactor', 'opencode', 'moonshotai/kimi-k3', 'low', 'Refactor'],
    ['@netlify glm max Refactor', 'opencode', 'z-ai/glm-5.2', 'xhigh', 'Refactor'],
    ['@netlify glm xhigh Refactor', 'opencode', 'z-ai/glm-5.2', 'xhigh', 'Refactor'],
    ['@netlify deepseek-flash max go', 'opencode', '~deepseek/deepseek-v4-flash-latest', 'max', 'go'],
    ['@netlify ~deepseek/deepseek-v4-flash-latest low go', 'opencode', '~deepseek/deepseek-v4-flash-latest', 'low', 'go'],
    ['@netlify grok medium go', 'opencode', 'x-ai/grok-4.5', 'medium', 'go'],
    ['@netlify opencode high go', 'opencode', '', 'high', 'go'],
    ['@netlify-opencode go', 'opencode', '', '', 'go'],
    // Ordinary prompt words are left alone.
    ['@netlify high contrast mode', 'codex', '', '', 'high contrast mode'],
    ['@netlify high fable fix', 'codex', '', '', 'high fable fix'],
    ['@netlify use flexbox for layout', 'codex', '', '', 'use flexbox for layout'],
    ['@netlify with care, fix it', 'codex', '', '', 'with care, fix it'],
    ['@netlify codex low-hanging fixes', 'codex', '', '', 'low-hanging fixes'],
    ['@netlify claude highlight the nav', 'claude', '', '', 'highlight the nav'],
    ['@netlify fables are fun', 'codex', '', '', 'fables are fun'],
    ['@netlify pro tip: fix it', 'codex', '', '', 'pro tip: fix it'],
    ['@netlify mini refactor', 'codex', '', '', 'mini refactor'],
    ['@netlify claude codex fix', 'claude', '', '', 'codex fix'],
    ['@netlify claude fable sonnet fix', 'claude', 'claude-fable-5', '', 'sonnet fix'],
    ['@netlify fable high low fix', 'claude', 'claude-fable-5', 'high', 'low fix'],
    // Explicit tokens.
    ['@netlify Add pagination effort:medium', 'codex', '', 'medium', 'Add pagination'],
    ['@netlify Add pagination effort=medium', 'codex', '', 'medium', 'Add pagination'],
    ['@netlify claude high priority: fix login effort:low', 'claude', '', 'low', 'priority: fix login'],
    ['@netlify Build it model:claude-sonnet-5', 'claude', 'claude-sonnet-5', '', 'Build it'],
    ['@netlify Build it model=fable', 'claude', 'claude-fable-5', '', 'Build it'],
    ['@netlify fable Build it model:auto', 'claude', '', '', 'Build it'],
    ['@netlify fable high Build it effort:auto', 'claude', 'claude-fable-5', '', 'Build it'],
    // Mentions later in the text, and multiple mentions.
    ['Thanks!\n@netlify sonnet fix', 'claude', 'claude-sonnet-5', '', 'Thanks!\nfix'],
    ['Please @netlify fable high fix this', 'claude', 'claude-fable-5', 'high', 'Please fix this'],
    ['@netlify fix it\n\ncc @netlify fable', 'claude', 'claude-fable-5', '', 'fix it\n\ncc @netlify fable'],
  ];

  for (const [text, agent, modelId, effort, cleaned] of cases) {
    it(JSON.stringify(text), () => {
      const r = pick(text);
      assert.deepEqual([r.agent, r.modelId, r.effort], [agent, modelId, effort]);
      assert.equal(utils.cleanPrompt(text), cleaned);
    });
  }

  it('ignores mentions inside code spans and fences', () => {
    assert.equal(utils.matchesTrigger('see `@netlify fable high`'), false);
    assert.equal(utils.matchesTrigger('```\n@netlify fable high\n```'), false);
    const r = pick('`@netlify fable` is the syntax\n@netlify codex sol fix');
    assert.deepEqual([r.agent, r.modelId], ['codex', 'gpt-5.6-sol']);
    assert.equal(pick('@netlify claude fix `effort:high` parsing').effort, '');
    assert.equal(pick('@netlify claude fix `model:fable` parsing').modelId, '');
  });

  it('does not accept markup or spaces as a model value', () => {
    assert.equal(pick('@netlify Build model:<img> it').modelId, '');
    assert.equal(pick('@netlify Build model:"fable" it').modelId, '');
    assert.equal(pick('@netlify Build model: fable').modelId, '');
  });

  it('matches every selector suffix with - and _, and rejects near misses', () => {
    for (const suffix of [...catalog.PROVIDERS, ...catalog.STANDALONE_SUFFIXES]) {
      assert.ok(utils.matchesTrigger(`@netlify-${suffix} go`), suffix);
      assert.ok(utils.matchesTrigger(`@netlify_${suffix} go`), suffix);
    }
    for (const text of ['@netlify-fables', '@netlify-fable5', '@netlify-sol', '@netlify/fable', 'me@netlify-fable.com']) {
      assert.equal(utils.matchesTrigger(text), false, text);
    }
  });

  it('combines a suffix with following words', () => {
    assert.deepEqual(
      [pick('@netlify-claude fable high go').modelId, pick('@netlify-claude fable high go').effort],
      ['claude-fable-5', 'high'],
    );
    assert.equal(pick('@netlify-fable sonnet go').modelId, 'claude-fable-5');
    assert.equal(utils.cleanPrompt('@netlify-fable sonnet go'), 'sonnet go');
  });
});

// ---------------------------------------------------------------------------
// Resolution rules
// ---------------------------------------------------------------------------
describe('selection resolution', () => {
  it('switches to the model agent with one warning on a mismatch', () => {
    const r = pick('@netlify codex fable high x');
    assert.deepEqual([r.agent, r.modelId, r.effort], ['claude', 'claude-fable-5', 'high']);
    assert.equal(r.warnings.length, 1);
    assert.match(r.warnings[0], /Fable 5 runs on claude, not codex/);
    const k = pick('@netlify claude kimi x');
    assert.deepEqual([k.agent, k.modelId], ['opencode', 'moonshotai/kimi-k3']);
  });

  it('does not read a non-standalone alias after another agent', () => {
    const r = pick('@netlify claude sol x');
    assert.deepEqual([r.agent, r.modelId], ['claude', '']);
    assert.equal(utils.cleanPrompt('@netlify claude sol x'), 'sol x');
  });

  it('shows max but sends xhigh for GLM 5.2 and DeepSeek V4 Pro', () => {
    for (const text of ['@netlify glm max go', '@netlify deepseek max go']) {
      const r = pick(text);
      assert.equal(r.effort, 'xhigh', text);
      assert.equal(r.effortLabel, 'max', text);
    }
  });

  it('rejects any effort for models without effort levels', () => {
    for (const text of ['@netlify kimi-code high go', '@netlify minimax low go']) {
      const r = pick(text);
      assert.equal(r.effort, '', text);
      assert.match(r.warnings[0], /none; Auto only/, text);
    }
  });

  it('allows low, medium, and high with an Auto model, but not max', () => {
    for (const level of ['low', 'medium', 'high']) {
      assert.equal(pick(`@netlify claude ${level} go`).effort, level);
    }
    const r = pick('@netlify opencode max go');
    assert.equal(r.effort, '');
    assert.match(r.warnings[0], /opencode \(Auto model\)/);
  });

  it('passes an uncataloged model through without validating effort', () => {
    const r = pick('@netlify opencode go model:moonshotai/kimi-k4 effort:max');
    assert.deepEqual([r.agent, r.modelId, r.effort], ['opencode', 'moonshotai/kimi-k4', 'max']);
    assert.equal(r.modelLabel, '`moonshotai/kimi-k4`');
    assert.equal(r.warnings.length, 1);
    const tilde = pick('@netlify opencode go model:~vendor/model-latest');
    assert.equal(tilde.modelId, '~vendor/model-latest');
  });

  describe('defaults', () => {
    it('applies default-model-id and default-effort when the mention names neither', () => {
      const r = pick('@netlify go', { defaultModelId: 'claude-fable-5', defaultEffort: 'high' });
      assert.deepEqual([r.agent, r.modelId, r.effort], ['claude', 'claude-fable-5', 'high']);
    });

    it('resolves any alias in default-model-id, including agent-qualified ones', () => {
      assert.equal(pick('@netlify go', { defaultModelId: 'sol' }).modelId, 'gpt-5.6-sol');
      assert.equal(pick('@netlify go', { defaultModelId: 'KIMI' }).modelId, 'moonshotai/kimi-k3');
    });

    it('ignores default-model-id silently when the mention names another agent', () => {
      const r = pick('@netlify gemini go', { defaultModelId: 'fable', defaultEffort: 'high' });
      assert.deepEqual([r.agent, r.modelId, r.effort], ['gemini', '', 'high']);
      assert.deepEqual(r.warnings, []);
    });

    it('lets mention words override each default independently', () => {
      const r = pick('@netlify sonnet go', { defaultModelId: 'fable', defaultEffort: 'low' });
      assert.deepEqual([r.modelId, r.effort], ['claude-sonnet-5', 'low']);
      const e = pick('@netlify fable medium go', { defaultModelId: 'fable', defaultEffort: 'low' });
      assert.equal(e.effort, 'medium');
    });

    it('treats explicit model:auto and effort:auto as overrides of the defaults', () => {
      const r = pick('@netlify go model:auto effort:auto', { defaultModelId: 'fable', defaultEffort: 'high' });
      assert.deepEqual([r.agent, r.modelId, r.effort], ['codex', '', '']);
    });

    it('treats empty and auto defaults as Auto', () => {
      for (const value of ['', 'auto', ' AUTO ']) {
        const r = pick('@netlify go', { defaultModelId: value, defaultEffort: value });
        assert.deepEqual([r.modelId, r.effort, r.warnings], ['', '', []], JSON.stringify(value));
      }
    });

    it('warns without echoing an invalid default-effort or default-model-id', () => {
      const effort = pick('@netlify go', { defaultEffort: '<b>extreme</b>' });
      assert.equal(effort.effort, '');
      assert.doesNotMatch(effort.warnings.join(' '), /extreme|<b>/);
      const model = pick('@netlify go', { defaultModelId: 'Fable 5 <b>' });
      assert.equal(model.modelId, '');
      assert.doesNotMatch(model.warnings.join(' '), /<b>/);
    });

    it('validates a default effort against the resolved model', () => {
      const r = pick('@netlify minimax go', { defaultEffort: 'high' });
      assert.equal(r.effort, '');
      assert.match(r.warnings[0], /MiniMax M3/);
    });

    it('falls back to the default agent', () => {
      assert.equal(pick('@netlify go', { defaultAgent: 'gemini' }).agent, 'gemini');
      assert.equal(utils.resolveSelection(null, {}).agent, 'codex');
    });
  });
});

// ---------------------------------------------------------------------------
// Rendering and title cleanup
// ---------------------------------------------------------------------------
describe('selection rendering', () => {
  it('shows the effort label rather than the wire value', () => {
    const body = utils.buildInProgressComment({
      prompt: '@netlify glm max go', model: 'opencode', modelLabel: 'GLM 5.2', effort: 'xhigh', effortLabel: 'max',
    });
    assert.match(body, /\*\*Agent:\*\* `opencode` · \*\*Model:\*\* GLM 5\.2 · \*\*Effort:\*\* `max`/);
  });

  it('omits model and effort when both are Auto', () => {
    const body = utils.buildInProgressComment({ prompt: '@netlify go', model: 'codex' });
    assert.match(body, /\*\*Agent:\*\* `codex`\n/);
    assert.doesNotMatch(body, /Model:|Effort:|⚠️/);
  });

  it('renders each warning on its own line', () => {
    const body = utils.buildInProgressComment({
      prompt: '@netlify go', model: 'claude', configWarnings: 'first\nsecond',
    });
    assert.match(body, /> ⚠️ first\n> ⚠️ second\n/);
  });

  it('strips the selection from agent PR titles', () => {
    const { cleanPullRequestTitle } = require('./finalize-agent-pr');
    assert.equal(cleanPullRequestTitle('@netlify fable high Fix the header'), 'Fix the header');
    assert.equal(cleanPullRequestTitle('@netlify-kimi max: Fix the header'), 'Fix the header');
    assert.equal(cleanPullRequestTitle('Fix @netlify claude the header'), 'Fix the header');
  });
});

// ---------------------------------------------------------------------------
// Command object parity: parseCommand must reproduce today's selection and
// prompt cleaning for every mention in this corpus.
// ---------------------------------------------------------------------------
describe('parseCommand parity', () => {
  const corpus = [
    '@netlify fable high Fix it', '@Netlify Claude Fable HIGH Fix it', '@netlfy fable high Fix it', '@netlify-agent fable high Fix it',
    '@netlify with fable high Fix it', '@netlify using codex sol Fix it', '@netlify\tfable\thigh\tFix it', '@netlify fable high',
    '@netlify fable\nFix it', '@netlify fable high\r\nFix it', '@netlify claude\r\nFix it', '@netlify fable. Fix it', '@netlify fable, fix it',
    '@netlify fable high: Fix it', '@netlify opus-4.8 Fix it', '@netlify kimi max Refactor', '@netlify-kimi max Refactor', '@netlify glm max Refactor',
    '@netlify ~deepseek/deepseek-v4-flash-latest low go', '@netlify high contrast mode', '@netlify use flexbox for layout', '@netlify codex low-hanging fixes',
    '@netlify Add pagination effort:medium', '@netlify Build it model:claude-sonnet-5', 'Thanks!\n@netlify sonnet fix', 'Please @netlify fable high fix this',
    '@netlify fix it\n\ncc @netlify fable', '`@netlify fable` is the syntax\n@netlify codex sol fix', '',
  ];
  for (const text of corpus) {
    it(JSON.stringify(text), () => {
      const parsed = utils.parseCommand(text);
      const selection = utils.parseSelection(text);
      assert.equal(parsed.command, 'run');
      assert.equal(parsed.mode, 'normal');
      assert.deepEqual(parsed.selection, {
        agent: selection ? selection.agent : null,
        model: selection ? selection.model : null,
        effort: selection ? selection.effort : null,
      });
      assert.equal(parsed.prompt, utils.cleanPrompt(text));
    });
  }

  it('reports explicit tokens on the mention line', () => {
    assert.deepEqual(utils.parseCommand('@netlify go model:fable effort:low').explicit, { model: true, effort: true });
    assert.deepEqual(utils.parseCommand('@netlify fable high go').explicit, { model: false, effort: false });
  });
});

describe('selectorPrefixEnd', () => {
  it('ends after the mention, selector words, and an optional separator', () => {
    const line = '@netlify fable high: fix it';
    assert.equal(line.slice(utils.selectorPrefixEnd(line)), ' fix it');
    assert.equal('@netlify fix it'.slice(utils.selectorPrefixEnd('@netlify fix it')), ' fix it');
    assert.equal(utils.selectorPrefixEnd('no mention here'), -1);
    const period = '@netlify fable. Fix';
    assert.equal(period.slice(utils.selectorPrefixEnd(period)), ' Fix');
  });
});
