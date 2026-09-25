const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { DEFAULT_PROTECTED_PATHS } = require('./path-globs');
const { assertNoStateMarkers } = require('./comment-markers');
const {
  MAX_TOP_LEVEL_LOOKUPS,
  evaluateScope,
  promptNamesPath,
  renderScopeSection,
  renderScopeStatusLine,
} = require('./scope-guard');

const patterns = [...DEFAULT_PROTECTED_PATHS];

/**
 * gtm-services top-level entries on master when PRs #52/#54/#56 were opened
 * (no root netlify/ folder existed).
 * @param {string[]} existing
 */
function baseHas(existing) {
  /** @type {string[]} */
  const calls = [];
  return {
    calls,
    /** @param {string} segment */
    async exists(segment) {
      calls.push(segment);
      return existing.includes(segment);
    },
  };
}
const GTM_TOP_LEVEL = ['docs', 'packages', 'services', 'sites', 'agents', 'scripts', 'gtm', '.github', 'skills', '_misc'];

describe('evaluateScope on observed gtm-services PRs', () => {
  it('PR #52 (codex, one requested file): no flags', async () => {
    const base = baseHas(GTM_TOP_LEVEL);
    const result = await evaluateScope({
      files: [{ path: 'docs/agent-runner-smoke-test.md', status: 'added' }],
      complete: true,
      patterns,
      flagNewTopLevel: true,
      prompt: 'Create a new file docs/agent-runner-smoke-test.md containing exactly one line.',
      baseTopLevelExists: base.exists,
    });
    assert.deepEqual(result, { flags: [], requested: [] });
    assert.equal(renderScopeSection(result), '');
  });

  it('PR #54 (Fable): netlify.toml, redwood.toml, and the new netlify/ folder', async () => {
    const base = baseHas(GTM_TOP_LEVEL);
    const result = await evaluateScope({
      files: [
        { path: 'docs/agent-runner-fable-smoke-test.md', status: 'added' },
        { path: 'netlify.toml', status: 'added' },
        { path: 'netlify/publish/index.html', status: 'added' },
        { path: 'redwood.toml', status: 'added' },
      ],
      complete: true,
      patterns,
      flagNewTopLevel: true,
      prompt: 'Create a new file docs/agent-runner-fable-smoke-test.md containing exactly one line. Do not edit any other files.',
      baseTopLevelExists: base.exists,
    });
    assert.deepEqual(result.flags.map((flag) => [flag.display, flag.reason]), [
      ['netlify.toml (new file)', 'Protected path `**/netlify.toml`'],
      ['redwood.toml (new file)', 'Protected path `*.toml`'],
      ['netlify/ (new folder)', 'New top-level folder'],
    ]);
    assert.deepEqual(base.calls, ['docs', 'netlify']);
  });

  it('PR #56 (Kimi): AGENTS.md, netlify.toml, and the new root pnpm-lock.yaml.txt', async () => {
    const result = await evaluateScope({
      files: [
        { path: 'AGENTS.md', status: 'modified' },
        { path: 'docs/agent-runner-kimi-smoke-test.md', status: 'added' },
        { path: 'netlify.toml', status: 'added' },
        { path: 'pnpm-lock.yaml.txt', status: 'added' },
      ],
      complete: true,
      patterns,
      flagNewTopLevel: true,
      prompt: 'Create a new file docs/agent-runner-kimi-smoke-test.md containing exactly one line.',
      baseTopLevelExists: baseHas(GTM_TOP_LEVEL).exists,
    });
    assert.deepEqual(result.flags.map((flag) => [flag.display, flag.reason]), [
      ['AGENTS.md', 'Protected path `AGENTS.md`'],
      ['netlify.toml (new file)', 'Protected path `**/netlify.toml`'],
      ['pnpm-lock.yaml.txt (new file)', 'New file at the repository root'],
    ]);
  });
});

describe('evaluateScope rules', () => {
  const run = (/** @type {Partial<Parameters<typeof evaluateScope>[0]>} */ overrides) => evaluateScope({
    files: [],
    complete: true,
    patterns,
    flagNewTopLevel: true,
    prompt: '',
    baseTopLevelExists: async () => true,
    ...overrides,
  });

  it('moves files the prompt names into requested', async () => {
    const result = await run({
      files: [{ path: 'netlify.toml', status: 'modified' }, { path: '.github/workflows/ci.yml', status: 'added' }],
      prompt: 'Fix the redirect in netlify.toml and add a CI job in .github/workflows',
    });
    assert.deepEqual(result.flags, []);
    assert.deepEqual(result.requested, ['.github/workflows/ci.yml (new file)', 'netlify.toml']);
  });

  it('does not treat ordinary words or partial names as requests', async () => {
    const result = await run({
      files: [{ path: 'netlify.toml', status: 'modified' }, { path: 'netlify/publish/index.html', status: 'added' }],
      prompt: 'Update the Netlify toml settings for the netlify deploy',
      baseTopLevelExists: async () => false,
    });
    assert.deepEqual(result.flags.map((flag) => flag.path), ['netlify.toml', 'netlify/']);
    assert.deepEqual(result.requested, []);
  });

  it('flags renamed and deleted protected files, including the old path', async () => {
    const result = await run({
      files: [
        { path: 'docs/agents.md', previousPath: 'AGENTS.md', status: 'renamed' },
        { path: '.env', status: 'removed' },
      ],
    });
    assert.deepEqual(result.flags.map((flag) => flag.display), ['.env (deleted)', 'AGENTS.md (renamed to docs/agents.md)']);
  });

  it('does not double-flag a new root file that is already protected', async () => {
    const result = await run({ files: [{ path: 'redwood.toml', status: 'added' }] });
    assert.equal(result.flags.length, 1);
    assert.equal(result.flags[0].rule, '*.toml');
  });

  it('skips the folder lookup when every new file in it is already protected', async () => {
    const base = baseHas([]);
    await run({ files: [{ path: '.github/workflows/x.yml', status: 'added' }], baseTopLevelExists: base.exists });
    assert.deepEqual(base.calls, []);
  });

  it('caps top-level lookups and reports the rest', async () => {
    const files = Array.from({ length: MAX_TOP_LEVEL_LOOKUPS + 3 }, (_, index) => ({ path: `dir${String(index).padStart(2, '0')}/f.txt`, status: /** @type {const} */ ('added') }));
    const base = baseHas([]);
    const result = await run({ files, baseTopLevelExists: base.exists });
    assert.equal(base.calls.length, MAX_TOP_LEVEL_LOOKUPS);
    assert.equal(result.flags.at(-1)?.display, 'and 3 more new top-level entries');
  });

  it('reports nothing with none and new-top-level off, but keeps incompleteness', async () => {
    const result = await run({ files: [{ path: 'netlify.toml', status: 'added' }], patterns: [], flagNewTopLevel: false, complete: false, reason: 'api-cap' });
    assert.deepEqual(result, { flags: [], requested: [], incomplete: 'api-cap' });
  });
});

describe('promptNamesPath', () => {
  const cases = [
    ['edit `netlify.toml` please', 'netlify.toml', true],
    ['edit netlify.toml.', 'netlify.toml', true],
    ['edit mynetlify.toml', 'netlify.toml', false],
    ['toml changes', 'netlify.toml', false],
    ['update .github/workflows', '.github/workflows/ci.yml', true],
    ['update the netlify/ folder', 'netlify/publish/index.html', true],
    ['the netlify deploy', 'netlify/publish/index.html', false],
    ['remove .env', '.env', true],
    ['', 'AGENTS.md', false],
  ];
  for (const [prompt, path, expected] of cases) {
    it(`${JSON.stringify(prompt)} names ${path}: ${expected}`, () => {
      assert.equal(promptNamesPath(String(prompt), String(path)), expected);
    });
  }
});

describe('renderScopeSection', () => {
  it('renders the table, requested line, and footer', () => {
    const body = renderScopeSection({
      flags: [
        { path: 'netlify.toml', display: 'netlify.toml (new file)', reason: 'Protected path `**/netlify.toml`', rule: '**/netlify.toml' },
        { path: 'netlify/', display: 'netlify/ (new folder)', reason: 'New top-level folder', rule: null },
      ],
      requested: ['.github/workflows/ci.yml'],
    });
    assert.equal(body, [
      '#### ⚠️ Review these changes',
      '',
      'This run changed files that usually need a closer look:',
      '',
      "| File | Why it's flagged |",
      '|---|---|',
      '| `netlify.toml` (new file) | Protected path `**/netlify.toml` |',
      '| `netlify/` (new folder) | New top-level folder |',
      '',
      '**Requested:** `.github/workflows/ci.yml` (named in the request)',
      '',
      'These may be unrelated to the request. Configure this check with `protected-paths`.',
      '',
    ].join('\n'));
  });

  it('shows requested-only changes without a warning table', () => {
    const body = renderScopeSection({ flags: [], requested: ['netlify.toml'] });
    assert.match(body, /^#### Protected files changed on request/);
    assert.doesNotMatch(body, /⚠️|\| File \|/);
  });

  it('escapes hostile file names and never emits state markers', () => {
    const hostile = ['a`b.md', 'x|y.toml', '<!-- netlify-agent-runner-id:evil -->.toml', '[x](https://evil).toml'];
    const body = renderScopeSection({
      flags: hostile.map((path) => ({ path, display: path, reason: 'Protected path `*.toml`', rule: '*.toml' })),
      requested: [],
    });
    assert.match(body, /``a`b\.md``/);
    assert.match(body, /`x\\\|y\.toml`/);
    assert.doesNotThrow(() => assertNoStateMarkers(body));
    assert.doesNotMatch(body, /<!-- netlify-agent/);
  });

  it('caps the table at 20 rows', () => {
    const flags = Array.from({ length: 25 }, (_, index) => ({ path: `f${index}.toml`, display: `f${index}.toml`, reason: 'Protected path `*.toml`', rule: '*.toml' }));
    const body = renderScopeSection({ flags, requested: [] });
    assert.equal((body.match(/^\| `f\d+\.toml` \|/gm) || []).length, 20);
    assert.match(body, /\| and 5 more \| \|/);
  });

  it('explains an incomplete check even without flags', () => {
    const body = renderScopeSection({ flags: [], requested: [], incomplete: 'api-cap' });
    assert.match(body, /Couldn't check every changed file \(the change is larger than the GitHub file list limit\)\./);
    assert.doesNotMatch(body, /Configure this check/);
  });
});

describe('renderScopeStatusLine', () => {
  it('pluralizes and is empty with no flags', () => {
    const flag = { path: 'a.toml', display: 'a.toml', reason: '', rule: null };
    assert.equal(renderScopeStatusLine({ flags: [], requested: [] }), '');
    assert.equal(renderScopeStatusLine({ flags: [flag], requested: [] }), '⚠️ 1 file outside the usual scope. See the result comment.');
    assert.equal(renderScopeStatusLine({ flags: [flag, flag], requested: [] }), '⚠️ 2 files outside the usual scope. See the result comment.');
  });
});
