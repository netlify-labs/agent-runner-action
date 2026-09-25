const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  MAX_API_FILES,
  collectChangedFiles,
  parseDiffFiles,
  unquoteGitPath,
  parseGitHeaderPaths,
} = require('./scope-files');

const repo = { owner: 'o', repo: 'r' };

/**
 * Fake GitHub client that serves a fixed file list in pages and records calls.
 * @param {Array<{ filename: string, status?: string, previous_filename?: string }>} files
 */
function fakeGithub(files) {
  /** @type {Array<{ api: string, params: Record<string, unknown> }>} */
  const calls = [];
  /** @param {number} page @param {number} perPage */
  const slice = (page, perPage) => files.slice((page - 1) * perPage, page * perPage);
  return {
    calls,
    rest: {
      pulls: {
        /** @param {Record<string, any>} params */
        async listFiles(params) {
          calls.push({ api: 'listFiles', params });
          return { data: slice(params.page, params.per_page) };
        },
      },
      repos: {
        /** @param {Record<string, any>} params */
        async getCommit(params) {
          calls.push({ api: 'getCommit', params });
          return { data: { sha: params.ref, files: slice(params.page, params.per_page) } };
        },
      },
    },
  };
}

/** @param {number} count */
function manyFiles(count) {
  return Array.from({ length: count }, (_, index) => ({ filename: `f/${index}.txt`, status: 'added' }));
}

describe('collectChangedFiles from GitHub', () => {
  it('pages through PR files and maps statuses', async () => {
    const github = fakeGithub([
      ...manyFiles(100),
      { filename: 'netlify.toml', status: 'added' },
      { filename: 'new.md', status: 'renamed', previous_filename: 'old.md' },
      { filename: 'gone.md', status: 'removed' },
      { filename: 'copy.md', status: 'copied' },
      { filename: 'touched.md', status: 'changed' },
    ]);
    const result = await collectChangedFiles({ github, repo, source: { kind: 'pr', number: 7 } });
    assert.equal(result.complete, true);
    assert.equal(result.files.length, 105);
    assert.deepEqual(result.files.slice(100), [
      { path: 'netlify.toml', status: 'added' },
      { path: 'new.md', previousPath: 'old.md', status: 'renamed' },
      { path: 'gone.md', status: 'removed' },
      { path: 'copy.md', status: 'added' },
      { path: 'touched.md', status: 'modified' },
    ]);
    assert.deepEqual(github.calls.map((call) => [call.params.page, call.params.per_page, call.params.pull_number]), [[1, 100, 7], [2, 100, 7]]);
  });

  it('reports the 3,000-file API cap as incomplete', async () => {
    const github = fakeGithub(manyFiles(MAX_API_FILES));
    const result = await collectChangedFiles({ github, repo, source: { kind: 'pr', number: 1 } });
    assert.equal(result.files.length, MAX_API_FILES);
    assert.deepEqual([result.complete, result.reason], [false, 'api-cap']);
  });

  it('pages through commit files', async () => {
    const github = fakeGithub([{ filename: 'AGENTS.md', status: 'modified' }]);
    const result = await collectChangedFiles({ github, repo, source: { kind: 'commit', sha: 'abc123' } });
    assert.deepEqual(result, { files: [{ path: 'AGENTS.md', status: 'modified' }], complete: true });
    assert.equal(github.calls[0].params.ref, 'abc123');
  });

  it('never fetches url diffs and reports missing sources', async () => {
    assert.deepEqual(await collectChangedFiles({ source: { kind: 'url' } }), { files: [], complete: false, reason: 'no-file-list' });
    assert.deepEqual(await collectChangedFiles({ source: { kind: 'none' } }), { files: [], complete: false, reason: 'no-file-list' });
  });

  it('treats an empty diff as a complete empty list', async () => {
    assert.deepEqual(await collectChangedFiles({ source: { kind: 'diff', text: '' } }), { files: [], complete: true });
  });
});

describe('unquoteGitPath', () => {
  it('decodes octal UTF-8 bytes and C escapes', () => {
    assert.equal(unquoteGitPath('"a/caf\\303\\251.md"'), 'a/café.md');
    assert.equal(unquoteGitPath('"a/tab\\there"'), 'a/tab\there');
    assert.equal(unquoteGitPath('"a/q\\"uote\\\\s"'), 'a/q"uote\\s');
    assert.equal(unquoteGitPath('"a/new\\nline"'), 'a/new\nline');
  });

  it('rejects malformed escapes', () => {
    for (const bad of ['"a/\\x41"', '"a/\\30"', '"a/trailing\\"', 'unquoted']) {
      assert.throws(() => unquoteGitPath(bad), undefined, bad);
    }
  });
});

describe('parseGitHeaderPaths', () => {
  it('handles plain, spaced, and quoted headers', () => {
    assert.deepEqual(parseGitHeaderPaths('a/src/x.js b/src/x.js'), { oldPath: 'src/x.js', newPath: 'src/x.js' });
    assert.deepEqual(parseGitHeaderPaths('a/my file.md b/my file.md'), { oldPath: 'my file.md', newPath: 'my file.md' });
    assert.deepEqual(parseGitHeaderPaths('"a/caf\\303\\251.md" "b/caf\\303\\251.md"'), { oldPath: 'café.md', newPath: 'café.md' });
  });

  it('returns null for ambiguous unquoted renames', () => {
    assert.equal(parseGitHeaderPaths('a/old name.md b/new name.md'), null);
  });
});

describe('parseDiffFiles', () => {
  it('classifies added, modified, deleted, renamed, binary, and mode-only changes', () => {
    const diff = [
      'diff --git a/docs/new.md b/docs/new.md',
      'new file mode 100644',
      'index 0000000..45f42a1',
      '--- /dev/null',
      '+++ b/docs/new.md',
      '@@ -0,0 +1 @@',
      '+hello',
      'diff --git a/netlify.toml b/netlify.toml',
      'index 1..2 100644',
      '--- a/netlify.toml',
      '+++ b/netlify.toml',
      '@@ -1 +1 @@',
      '-a',
      '+b',
      'diff --git a/AGENTS.md b/AGENTS.md',
      'deleted file mode 100644',
      '--- a/AGENTS.md',
      '+++ /dev/null',
      'diff --git a/old name.md b/new name.md',
      'similarity index 90%',
      'rename from old name.md',
      'rename to new name.md',
      'diff --git a/logo.png b/logo.png',
      'new file mode 100644',
      'Binary files /dev/null and b/logo.png differ',
      'diff --git a/run.sh b/run.sh',
      'old mode 100644',
      'new mode 100755',
      'diff --git "a/caf\\303\\251.md" "b/caf\\303\\251.md"',
      'new file mode 100644',
      '--- /dev/null',
      '+++ "b/caf\\303\\251.md"',
    ].join('\n');
    assert.deepEqual(parseDiffFiles(diff), {
      files: [
        { path: 'docs/new.md', status: 'added' },
        { path: 'netlify.toml', status: 'modified' },
        { path: 'AGENTS.md', status: 'removed' },
        { path: 'new name.md', previousPath: 'old name.md', status: 'renamed' },
        { path: 'logo.png', status: 'added' },
        { path: 'run.sh', status: 'modified' },
        { path: 'café.md', status: 'added' },
      ],
      complete: true,
    });
  });

  it('handles CRLF diffs', () => {
    const diff = 'diff --git a/x.md b/x.md\r\nnew file mode 100644\r\n--- /dev/null\r\n+++ b/x.md\r\n';
    assert.deepEqual(parseDiffFiles(diff).files, [{ path: 'x.md', status: 'added' }]);
  });

  it('marks unparseable headers incomplete instead of guessing', () => {
    const diff = 'diff --git a/old name.md b/new name.md\nindex 1..2\n';
    const result = parseDiffFiles(diff);
    assert.deepEqual([result.complete, result.reason], [false, 'malformed-diff']);
  });

  it('marks text without any diff header as malformed', () => {
    const result = parseDiffFiles('this is not a diff');
    assert.deepEqual(result, { files: [], complete: false, reason: 'malformed-diff' });
  });

  it('recovers an ambiguous header from --- and +++ lines', () => {
    const diff = 'diff --git a/old name.md b/new name.md\n--- a/old name.md\n+++ b/new name.md\n';
    const result = parseDiffFiles(diff);
    assert.equal(result.complete, true);
    assert.deepEqual(result.files, [{ path: 'new name.md', previousPath: 'old name.md', status: 'renamed' }]);
  });
});
