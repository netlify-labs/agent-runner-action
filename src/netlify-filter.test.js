const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const {
  appendGithubOutput,
  findNetlifyConfigPaths,
  inferNetlifyFilterFromCommand,
  listNetlifyFilterCandidates,
  main,
  readNetlifyBuildCommand,
  resolveNetlifyFilter,
} = require('./netlify-filter');

function tmpRoot(prefix = 'agent-runner-netlify-filter-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test('inferNetlifyFilterFromCommand reads supported package-manager filter forms', () => {
  assert.equal(
    inferNetlifyFilterFromCommand('BUGSNAG=1 pnpm --filter revenue-engine-frontend build:netlify'),
    'revenue-engine-frontend',
  );
  assert.equal(inferNetlifyFilterFromCommand('pnpm --filter=revenue-engine-frontend build'), 'revenue-engine-frontend');
  assert.equal(inferNetlifyFilterFromCommand('pnpm -F "revenue-engine-frontend" build'), 'revenue-engine-frontend');
  assert.equal(inferNetlifyFilterFromCommand('pnpm --filter one --filter two build'), '');
});

test('resolveNetlifyFilter infers a root filter from netlify.toml build command', () => {
  const root = tmpRoot();
  fs.writeFileSync(path.join(root, 'netlify.toml'), [
    '[build]',
    '  command = "pnpm --filter revenue-engine-frontend build:netlify"',
    '  publish = "clients/frontend/dist"',
    '',
  ].join('\n'));

  assert.equal(readNetlifyBuildCommand(path.join(root, 'netlify.toml')), 'pnpm --filter revenue-engine-frontend build:netlify');
  assert.deepEqual(resolveNetlifyFilter({ projectRoot: root }), {
    filter: 'revenue-engine-frontend',
    source: 'netlify.toml',
  });
});

test('resolveNetlifyFilter leaves simple single-site netlify.toml runs unchanged', () => {
  const root = tmpRoot();
  fs.writeFileSync(path.join(root, 'netlify.toml'), [
    '[build]',
    '  command = "npm run build"',
    '  publish = "dist"',
    '',
  ].join('\n'));

  assert.deepEqual(resolveNetlifyFilter({ projectRoot: root }), {
    filter: '',
    source: '',
  });
});

test('resolveNetlifyFilter lets explicit input override discovery', () => {
  const root = tmpRoot();
  fs.writeFileSync(path.join(root, 'netlify.toml'), [
    '[build]',
    '  command = "pnpm --filter revenue-engine-frontend build:netlify"',
    '',
  ].join('\n'));

  assert.deepEqual(resolveNetlifyFilter({ projectRoot: root, filter: 'explicit-app' }), {
    filter: 'explicit-app',
    source: 'input',
  });
});

test('resolveNetlifyFilter falls back to a nested netlify.toml build command', () => {
  const root = tmpRoot();
  const appDir = path.join(root, 'apps', 'workspace', 'packages', 'clients', 'frontend');
  fs.mkdirSync(appDir, { recursive: true });
  fs.writeFileSync(path.join(appDir, 'netlify.toml'), [
    '[build]',
    '  command = "pnpm --filter revenue-engine-frontend build:netlify"',
    '  publish = "/clients/frontend/dist"',
    '',
  ].join('\n'));

  assert.deepEqual(resolveNetlifyFilter({ projectRoot: root }), {
    filter: 'revenue-engine-frontend',
    source: path.join('apps', 'workspace', 'packages', 'clients', 'frontend', 'netlify.toml'),
  });
  assert.deepEqual(listNetlifyFilterCandidates(root).map((candidate) => ({
    source: candidate.source,
    filter: candidate.filter,
  })), [{
    source: path.join('apps', 'workspace', 'packages', 'clients', 'frontend', 'netlify.toml'),
    filter: 'revenue-engine-frontend',
  }]);
});

test('resolveNetlifyFilter ignores ambiguous nested netlify.toml filters', () => {
  const root = tmpRoot();
  for (const [dir, filter] of [['frontend', 'web'], ['docs', 'docs']]) {
    const appDir = path.join(root, 'clients', dir);
    fs.mkdirSync(appDir, { recursive: true });
    fs.writeFileSync(path.join(appDir, 'netlify.toml'), [
      '[build]',
      `  command = "pnpm --filter ${filter} build"`,
      '',
    ].join('\n'));
  }

  assert.deepEqual(resolveNetlifyFilter({ projectRoot: root }), {
    filter: '',
    source: '',
  });
});

test('findNetlifyConfigPaths skips netlify.toml inside gitignored directories', () => {
  const root = tmpRoot();
  spawnSync('git', ['init', '-q'], { cwd: root });
  fs.writeFileSync(path.join(root, '.gitignore'), 'projects/data/data-internal/\n');

  fs.writeFileSync(path.join(root, 'netlify.toml'), '[build]\n');

  const ignoredDir = path.join(root, 'projects', 'data', 'data-internal');
  fs.mkdirSync(ignoredDir, { recursive: true });
  fs.writeFileSync(path.join(ignoredDir, 'netlify.toml'), '[build]\n');

  const trackedDir = path.join(root, 'projects', 'data', 'snowflake_dbt');
  fs.mkdirSync(trackedDir, { recursive: true });
  fs.writeFileSync(path.join(trackedDir, 'netlify.toml'), '[build]\n');

  const results = findNetlifyConfigPaths(root).map((p) => path.relative(root, p));
  assert.deepEqual(results.sort(), [
    'netlify.toml',
    path.join('projects', 'data', 'snowflake_dbt', 'netlify.toml'),
  ].sort());
});

test('main writes GitHub outputs for the resolved filter', () => {
  const root = tmpRoot();
  const outputPath = path.join(root, 'github-output');
  fs.writeFileSync(path.join(root, 'netlify.toml'), [
    '[build]',
    '  command = "pnpm --filter revenue-engine-frontend build:netlify"',
    '',
  ].join('\n'));

  const previous = process.env.GITHUB_OUTPUT;
  process.env.GITHUB_OUTPUT = outputPath;
  try {
    main(['--project-root', root]);
  } finally {
    if (previous === undefined) delete process.env.GITHUB_OUTPUT;
    else process.env.GITHUB_OUTPUT = previous;
  }

  assert.equal(fs.readFileSync(outputPath, 'utf8'), 'filter=revenue-engine-frontend\nsource=netlify.toml\n');
});

test('appendGithubOutput no-ops when GITHUB_OUTPUT is unavailable', () => {
  assert.doesNotThrow(() => appendGithubOutput({ filter: 'app', source: 'input' }, ''));
});
