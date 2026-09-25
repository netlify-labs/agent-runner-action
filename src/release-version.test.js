const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { parseVersion, compareVersions, validateRelease } = require('./release-version');

describe('parseVersion', () => {
  it('accepts plain X.Y.Z', () => {
    assert.deepEqual(parseVersion('1.2.3'), { major: 1, minor: 2, patch: 3 });
    assert.deepEqual(parseVersion('1.0.0'), { major: 1, minor: 0, patch: 0 });
  });

  it('rejects prefixes, prereleases, build metadata, and leading zeros', () => {
    for (const value of ['v1.2.3', '1.2', '1.2.3-rc.1', '1.2.3+build', '01.2.3', '1.02.3', '', 'latest']) {
      assert.throws(() => parseVersion(value), /Invalid version/, value);
    }
  });
});

describe('compareVersions', () => {
  it('orders numerically, not lexically', () => {
    assert.ok(compareVersions(parseVersion('1.10.0'), parseVersion('1.9.9')) > 0);
    assert.equal(compareVersions(parseVersion('1.2.3'), parseVersion('1.2.3')), 0);
  });
});

describe('validateRelease', () => {
  const base = { existingTags: [], isMainHead: true, dryRun: false };

  it('allows the first release with no tags', () => {
    const result = validateRelease({ ...base, version: '1.0.0' });
    assert.deepEqual(result, { ok: true, errors: [], warnings: [], tag: 'v1.0.0', majorTag: 'v1' });
  });

  it('rejects an existing tag', () => {
    const result = validateRelease({ ...base, version: '1.0.0', existingTags: ['v1', 'v1.0.0'] });
    assert.equal(result.ok, false);
    assert.match(result.errors.join(' '), /already exists/);
  });

  it('requires a version greater than the latest release, ignoring the moving tag', () => {
    const tags = ['v1', 'v1.0.0', 'v1.2.0', 'v1.10.0'];
    assert.equal(validateRelease({ ...base, version: '1.11.0', existingTags: tags }).ok, true);
    const older = validateRelease({ ...base, version: '1.9.0', existingTags: tags });
    assert.equal(older.ok, false);
    assert.match(older.errors.join(' '), /greater than the latest release v1\.10\.0/);
  });

  it('rejects a major other than 1', () => {
    const result = validateRelease({ ...base, version: '2.0.0' });
    assert.equal(result.ok, false);
    assert.match(result.errors.join(' '), /Major version 2 is not supported/);
  });

  it('warns when dry-running off main and errors when publishing off main', () => {
    const dry = validateRelease({ ...base, version: '1.0.0', isMainHead: false, dryRun: true });
    assert.equal(dry.ok, true);
    assert.deepEqual(dry.warnings, ['main-HEAD check skipped (not main)']);
    const publish = validateRelease({ ...base, version: '1.0.0', isMainHead: false, dryRun: false });
    assert.equal(publish.ok, false);
    assert.match(publish.errors.join(' '), /current main HEAD/);
  });

  it('reports a parse error without throwing', () => {
    const result = validateRelease({ ...base, version: 'v1.0.0' });
    assert.equal(result.ok, false);
    assert.equal(result.tag, '');
  });
});

describe('release-version CLI', () => {
  const script = path.join(__dirname, 'release-version.js');
  /** @param {string[]} args */
  function run(args) {
    const result = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });
    return { status: result.status, json: JSON.parse(result.stdout) };
  }

  it('exits 0 with JSON for a valid release', () => {
    const { status, json } = run(['--version', '1.1.0', '--tags', 'v1 v1.0.0', '--main-head', 'true', '--dry-run', 'false']);
    assert.equal(status, 0);
    assert.equal(json.tag, 'v1.1.0');
  });

  it('exits non-zero for an invalid release', () => {
    const { status, json } = run(['--version', '1.0.0', '--tags', 'v1.0.0', '--main-head', 'true', '--dry-run', 'false']);
    assert.equal(status, 1);
    assert.equal(json.ok, false);
  });

  it('treats a missing --dry-run as a dry run', () => {
    const { status, json } = run(['--version', '1.0.0', '--main-head', 'false']);
    assert.equal(status, 0);
    assert.deepEqual(json.warnings, ['main-HEAD check skipped (not main)']);
  });
});
