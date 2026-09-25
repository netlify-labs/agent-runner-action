const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { DEFAULT_PROTECTED_PATHS, globToRegExp, parsePatternList, compilePatterns } = require('./path-globs');

/**
 * @param {string} pattern
 * @param {string[]} yes
 * @param {string[]} no
 */
function expectGlob(pattern, yes, no) {
  const regex = globToRegExp(pattern);
  for (const path of yes) assert.ok(regex.test(path), `${pattern} should match ${path}`);
  for (const path of no) assert.ok(!regex.test(path), `${pattern} should not match ${path}`);
}

describe('globToRegExp', () => {
  it('** matches across directories and a leading **/ matches zero directories', () => {
    expectGlob('**/netlify.toml', ['netlify.toml', 'sites/a/netlify.toml'], ['netlify.toml.bak', 'xnetlify.toml']);
    expectGlob('.github/**', ['.github/workflows/ci.yml', '.github/CODEOWNERS'], ['github/x', '.githubx/y']);
    expectGlob('src/**/test.js', ['src/test.js', 'src/a/b/test.js'], ['test.js', 'lib/src/test.js']);
  });

  it('* does not cross directories and ? matches one non-slash character', () => {
    expectGlob('*.toml', ['redwood.toml', 'netlify.toml'], ['packages/x/pyproject.toml', '.toml/x']);
    expectGlob('file?.md', ['file1.md'], ['file12.md', 'file/.md']);
  });

  it('a pattern without / matches only at the root', () => {
    expectGlob('AGENTS.md', ['AGENTS.md'], ['docs/AGENTS.md']);
  });

  it('supports {a,b} alternation', () => {
    expectGlob('**/{yarn.lock,bun.lockb}', ['yarn.lock', 'a/bun.lockb'], ['package-lock.json']);
  });

  it('escapes regex special characters', () => {
    expectGlob('a+b(c).md', ['a+b(c).md'], ['aab(c).md', 'a+bc.md']);
  });

  it('rejects malformed braces with the pattern in the message', () => {
    assert.throws(() => globToRegExp('{a,b'), /Unbalanced "\{" in pattern "\{a,b"/);
    assert.throws(() => globToRegExp('a}'), /Unbalanced "}"/);
    assert.throws(() => globToRegExp('{a,{b}}'), /Nested braces/);
  });
});

describe('parsePatternList', () => {
  it('splits on newlines and top-level commas, keeping commas inside braces', () => {
    assert.deepEqual(parsePatternList('a/**, b/*\n**/{x,y}.lock'), ['a/**', 'b/*', '**/{x,y}.lock']);
  });

  it('expands default, drops none, blank lines, and comments', () => {
    assert.deepEqual(parsePatternList('default'), [...DEFAULT_PROTECTED_PATHS]);
    assert.deepEqual(parsePatternList('default, infra/**'), [...DEFAULT_PROTECTED_PATHS, 'infra/**']);
    assert.deepEqual(parsePatternList('none'), []);
    assert.deepEqual(parsePatternList('\n# comment\n  \r\nsrc/**\r\n'), ['src/**']);
    assert.deepEqual(parsePatternList(undefined), []);
  });
});

describe('compilePatterns', () => {
  it('reports the first positive rule, so specific patterns name the reason', () => {
    const match = compilePatterns(['**/netlify.toml', '*.toml']);
    assert.deepEqual(match('netlify.toml'), { matched: true, rule: '**/netlify.toml' });
    assert.deepEqual(match('redwood.toml'), { matched: true, rule: '*.toml' });
  });

  it('reports the rule that matched', () => {
    const match = compilePatterns(['.github/**', '*.toml']);
    assert.deepEqual(match('redwood.toml'), { matched: true, rule: '*.toml' });
    assert.deepEqual(match('src/index.js'), { matched: false, rule: null });
  });

  it('lets a later negation exclude, and the last match wins', () => {
    const match = compilePatterns(['**/AGENTS.md', '!docs/**', 'docs/AGENTS.md']);
    assert.equal(match('AGENTS.md').matched, true);
    assert.equal(match('docs/other/AGENTS.md').matched, false);
    assert.deepEqual(match('docs/AGENTS.md'), { matched: true, rule: 'docs/AGENTS.md' });
    const excluded = compilePatterns([...DEFAULT_PROTECTED_PATHS, '!**/AGENTS.md']);
    assert.equal(excluded('AGENTS.md').matched, false);
    assert.equal(excluded('netlify.toml').matched, true);
  });

  it('is case-sensitive and ignores a leading ./', () => {
    const match = compilePatterns(['AGENTS.md']);
    assert.equal(match('agents.md').matched, false);
    assert.equal(match('./AGENTS.md').matched, true);
  });

  it('rejects an empty negation', () => {
    assert.throws(() => compilePatterns(['!']), /Empty pattern/);
  });
});

describe('built-in protected paths', () => {
  const match = compilePatterns([...DEFAULT_PROTECTED_PATHS]);
  const cases = [
    ['.github/workflows/netlify-agents.yml', '.github/**'],
    ['netlify.toml', '**/netlify.toml'],
    ['sites/gtm-platform/netlify.toml', '**/netlify.toml'],
    ['redwood.toml', '*.toml'],
    ['package-lock.json', '**/package-lock.json'],
    ['packages/cli/pnpm-lock.yaml', '**/pnpm-lock.yaml'],
    ['yarn.lock', '**/yarn.lock'],
    ['bun.lock', '**/bun.lock'],
    ['bun.lockb', '**/bun.lockb'],
    ['pnpm-workspace.yaml', '**/pnpm-workspace.yaml'],
    ['AGENTS.md', 'AGENTS.md'],
    ['CLAUDE.md', 'CLAUDE.md'],
    ['services/api/AGENTS.md', '**/AGENTS.md'],
    ['.env', '**/.env*'],
    ['apps/web/.env.local', '**/.env*'],
  ];
  for (const [path, rule] of cases) {
    it(`flags ${path}`, () => {
      assert.deepEqual(match(path), { matched: true, rule });
    });
  }

  it('does not flag ordinary files', () => {
    for (const path of ['README.md', 'docs/agent-runner-smoke-test.md', 'packages/x/pyproject.toml', 'src/env.js', 'netlify/functions/api.js', 'pnpm-lock.yaml.txt']) {
      assert.equal(match(path).matched, false, path);
    }
  });
});
