// Collect the files a single agent run changed, for the scope guard.
//
// GitHub file metadata is the primary source (a new PR's file list, or the
// landed follow-up commit). Parsing the SDK's inline session diff is only a
// best-effort fallback for runs that landed nothing (dry run, ask mode),
// because the SDK does not promise a complete Git extended-header diff.

const MAX_API_FILES = 3000;
const PER_PAGE = 100;

/**
 * @typedef {'added' | 'modified' | 'removed' | 'renamed'} FileStatus
 * @typedef {{ path: string, previousPath?: string, status: FileStatus }} ChangedFile
 * @typedef {{ files: ChangedFile[], complete: boolean, reason?: string }} ChangedFiles
 */

/**
 * @param {string | undefined} status GitHub file status
 * @returns {FileStatus}
 */
function normalizeStatus(status) {
  if (status === 'added' || status === 'copied') return 'added';
  if (status === 'removed') return 'removed';
  if (status === 'renamed') return 'renamed';
  return 'modified';
}

/**
 * @param {{ filename: string, status?: string, previous_filename?: string }} file
 * @returns {ChangedFile}
 */
function fromGithubFile(file) {
  /** @type {ChangedFile} */
  const entry = { path: file.filename, status: normalizeStatus(file.status) };
  if (file.previous_filename) entry.previousPath = file.previous_filename;
  return entry;
}

/**
 * Page through a GitHub list until a short page or the API's file cap.
 * @param {(page: number) => Promise<Array<{ filename: string, status?: string, previous_filename?: string }>>} fetchPage
 * @returns {Promise<ChangedFiles>}
 */
async function collectPaged(fetchPage) {
  /** @type {ChangedFile[]} */
  const files = [];
  for (let page = 1; ; page += 1) {
    const batch = await fetchPage(page);
    files.push(...batch.map(fromGithubFile));
    if (files.length >= MAX_API_FILES) {
      return { files: files.slice(0, MAX_API_FILES), complete: false, reason: 'api-cap' };
    }
    if (batch.length < PER_PAGE) return { files, complete: true };
  }
}

/**
 * Decode a Git C-style quoted path (core.quotePath): "a/caf\303\251.md".
 * @param {string} quoted including the surrounding double quotes
 * @returns {string}
 */
function unquoteGitPath(quoted) {
  if (!quoted.startsWith('"') || !quoted.endsWith('"') || quoted.length < 2) {
    throw new Error(`Not a quoted Git path: ${quoted}`);
  }
  const body = quoted.slice(1, -1);
  /** @type {number[]} */
  const bytes = [];
  /** @type {Record<string, number>} */
  const simple = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, '"': 34, '\\': 92 };
  for (let index = 0; index < body.length; index += 1) {
    const char = body[index];
    if (char !== '\\') {
      bytes.push(...Buffer.from(char, 'utf8'));
      continue;
    }
    const next = body[index + 1];
    if (next === undefined) throw new Error(`Dangling escape in ${quoted}`);
    if (/[0-7]/.test(next)) {
      const octal = body.slice(index + 1, index + 4);
      if (!/^[0-7]{3}$/.test(octal)) throw new Error(`Bad octal escape in ${quoted}`);
      bytes.push(parseInt(octal, 8));
      index += 3;
      continue;
    }
    if (!(next in simple)) throw new Error(`Unknown escape \\${next} in ${quoted}`);
    bytes.push(simple[next]);
    index += 1;
  }
  return Buffer.from(bytes).toString('utf8');
}

/**
 * Read one path token that is either "quoted" or runs to the end of the line.
 * @param {string} value
 * @returns {string}
 */
function readPathToEnd(value) {
  const trimmed = value.replace(/\t.*$/, '');
  return trimmed.startsWith('"') ? unquoteGitPath(trimmed) : trimmed;
}

/**
 * Strip the a/ or b/ prefix Git adds in headers.
 * @param {string} path
 * @param {'a/' | 'b/'} prefix
 * @returns {string | null}
 */
function stripPrefix(path, prefix) {
  if (path === '/dev/null') return null;
  if (!path.startsWith(prefix)) throw new Error(`Expected ${prefix} prefix in "${path}"`);
  return path.slice(prefix.length);
}

/**
 * Parse the two paths of a `diff --git` header line.
 * @param {string} rest text after "diff --git "
 * @returns {{ oldPath: string, newPath: string } | null} null when ambiguous
 */
function parseGitHeaderPaths(rest) {
  if (rest.startsWith('"')) {
    const end = findClosingQuote(rest);
    const oldToken = rest.slice(0, end + 1);
    const newToken = rest.slice(end + 2);
    return {
      oldPath: /** @type {string} */ (stripPrefix(unquoteGitPath(oldToken), 'a/')),
      newPath: /** @type {string} */ (stripPrefix(readPathToEnd(newToken), 'b/')),
    };
  }
  if (rest.includes(' "b/')) {
    const split = rest.indexOf(' "b/');
    return {
      oldPath: /** @type {string} */ (stripPrefix(rest.slice(0, split), 'a/')),
      newPath: /** @type {string} */ (stripPrefix(unquoteGitPath(rest.slice(split + 1)), 'b/')),
    };
  }
  // Unquoted paths may contain spaces. When old and new are the same path the
  // line is "a/<P> b/<P>", so the split point is fixed by length.
  if ((rest.length - 5) % 2 === 0) {
    const half = (rest.length - 5) / 2;
    const oldPart = rest.slice(0, half + 2);
    const newPart = rest.slice(half + 3);
    if (rest[half + 2] === ' ' && oldPart.slice(2) === newPart.slice(2) && oldPart.startsWith('a/') && newPart.startsWith('b/')) {
      return { oldPath: oldPart.slice(2), newPath: newPart.slice(2) };
    }
  }
  return null;
}

/**
 * @param {string} value starting with a double quote
 * @returns {number} index of the matching closing quote
 */
function findClosingQuote(value) {
  for (let index = 1; index < value.length; index += 1) {
    if (value[index] === '\\') {
      index += 1;
      continue;
    }
    if (value[index] === '"') return index;
  }
  throw new Error(`Unterminated quoted path: ${value}`);
}

/**
 * Best-effort parse of a Git unified diff into changed files. Never guesses:
 * a header it can't resolve marks the result incomplete.
 * @param {string} text
 * @returns {ChangedFiles}
 */
function parseDiffFiles(text) {
  /** @type {ChangedFile[]} */
  const files = [];
  let complete = true;
  /** @type {{ header: { oldPath: string, newPath: string } | null, status: FileStatus, renameFrom?: string, renameTo?: string, minus?: string | null, plus?: string | null } | null} */
  let current = null;

  const flush = () => {
    if (!current) return;
    const block = current;
    current = null;
    const oldPath = block.renameFrom ?? block.header?.oldPath ?? block.minus ?? null;
    const newPath = block.renameTo ?? block.header?.newPath ?? block.plus ?? null;
    if (block.status === 'modified' && oldPath && newPath && oldPath !== newPath) {
      // A rename with content changes whose header was ambiguous.
      block.status = 'renamed';
    }
    if (block.status === 'renamed' && oldPath && newPath) {
      files.push({ path: newPath, previousPath: oldPath, status: 'renamed' });
    } else if (block.status === 'removed' && oldPath) {
      files.push({ path: oldPath, status: 'removed' });
    } else if (newPath || oldPath) {
      files.push({ path: /** @type {string} */ (newPath || oldPath), status: block.status });
    } else {
      complete = false;
    }
  };

  const lines = String(text || '').split(/\r?\n/);
  for (const line of lines) {
    if (line.startsWith('diff --git ')) {
      flush();
      let header = null;
      try {
        header = parseGitHeaderPaths(line.slice('diff --git '.length));
      } catch (_) {
        complete = false;
      }
      current = { header, status: 'modified' };
      continue;
    }
    if (!current) continue;
    try {
      if (line.startsWith('new file mode')) current.status = 'added';
      else if (line.startsWith('deleted file mode')) current.status = 'removed';
      else if (line.startsWith('rename from ')) {
        current.status = 'renamed';
        current.renameFrom = readPathToEnd(line.slice('rename from '.length));
      } else if (line.startsWith('rename to ')) {
        current.status = 'renamed';
        current.renameTo = readPathToEnd(line.slice('rename to '.length));
      } else if (line.startsWith('--- ')) {
        current.minus = stripPrefix(readPathToEnd(line.slice(4)), 'a/');
      } else if (line.startsWith('+++ ')) {
        current.plus = stripPrefix(readPathToEnd(line.slice(4)), 'b/');
      }
    } catch (_) {
      complete = false;
    }
  }
  flush();
  if (files.length === 0 && String(text || '').trim() !== '' && !/^diff --git /m.test(String(text))) {
    return { files, complete: false, reason: 'malformed-diff' };
  }
  return complete ? { files, complete } : { files, complete, reason: 'malformed-diff' };
}

/**
 * @typedef {{ rest: { pulls: { listFiles: Function }, repos: { getCommit: Function } } }} GithubLike
 * @typedef {{ kind: 'pr', number: number } | { kind: 'commit', sha: string } | { kind: 'diff', text: string } | { kind: 'url' } | { kind: 'none' }} FileSource
 */

/**
 * @param {{ github?: GithubLike, repo?: { owner: string, repo: string }, source: FileSource }} options
 * @returns {Promise<ChangedFiles>}
 */
async function collectChangedFiles({ github, repo, source }) {
  if (source.kind === 'pr') {
    const client = /** @type {GithubLike} */ (github);
    return collectPaged(async (page) => {
      const response = await client.rest.pulls.listFiles({ ...repo, pull_number: source.number, per_page: PER_PAGE, page });
      return response.data;
    });
  }
  if (source.kind === 'commit') {
    const client = /** @type {GithubLike} */ (github);
    return collectPaged(async (page) => {
      const response = await client.rest.repos.getCommit({ ...repo, ref: source.sha, per_page: PER_PAGE, page });
      return response.data.files || [];
    });
  }
  if (source.kind === 'diff') {
    if (!String(source.text || '').trim()) return { files: [], complete: true };
    return parseDiffFiles(source.text);
  }
  return { files: [], complete: false, reason: 'no-file-list' };
}

module.exports = {
  MAX_API_FILES,
  collectChangedFiles,
  parseDiffFiles,
  unquoteGitPath,
  parseGitHeaderPaths,
};
