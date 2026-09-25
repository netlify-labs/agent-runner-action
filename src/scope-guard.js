// Scope guard: flag files an agent run changed that usually need a closer
// look (protected paths, new top-level files and folders), and render the
// "Review these changes" comment section. Reports only; never blocks.

const fs = require('node:fs');
const path = require('node:path');
const { compilePatterns } = require('./path-globs');

const MAX_TOP_LEVEL_LOOKUPS = 10;
const MAX_TABLE_ROWS = 20;

/**
 * @typedef {import('./scope-files').ChangedFile} ChangedFile
 * @typedef {{ path: string, display: string, reason: string, rule: string | null }} ScopeFlag
 * @typedef {{ flags: ScopeFlag[], requested: string[], incomplete?: string }} ScopeResult
 */

/**
 * @param {string} value
 * @returns {string}
 */
function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Does the prompt name this path? A file counts when its full path appears,
 * or its basename when the basename has an extension ("netlify.toml"). A
 * folder counts only when written with a slash (".github/workflows",
 * "netlify/"), so ordinary words like "netlify" never suppress a warning.
 * @param {string} prompt
 * @param {string} filePath
 * @returns {boolean}
 */
function promptNamesPath(prompt, filePath) {
  if (!prompt) return false;
  const boundaryBefore = '(?:^|[\\s`\'"(\\[<])';
  const boundaryAfter = '(?=$|[\\s`\'".,;:)\\]>!?])';
  /** @param {string} needle */
  const mentions = (needle) => new RegExp(`${boundaryBefore}${escapeRegExp(needle)}${boundaryAfter}`).test(prompt);

  if (mentions(filePath)) return true;
  const segments = filePath.split('/');
  const basename = segments[segments.length - 1];
  // Basenames with a dot ("netlify.toml", ".env") are distinctive enough.
  if (basename.includes('.') && mentions(basename)) return true;
  for (let depth = 1; depth < segments.length; depth += 1) {
    const folder = segments.slice(0, depth).join('/');
    if (folder.includes('/') && mentions(folder)) return true;
    if (mentions(`${folder}/`)) return true;
  }
  return false;
}

/**
 * @param {{
 *   files: ChangedFile[],
 *   complete: boolean,
 *   reason?: string,
 *   patterns: string[],
 *   flagNewTopLevel: boolean,
 *   prompt?: string,
 *   baseTopLevelExists?: (segment: string) => Promise<boolean>,
 * }} input
 * @returns {Promise<ScopeResult>}
 */
async function evaluateScope({ files, complete, reason, patterns, flagNewTopLevel, prompt = '', baseTopLevelExists }) {
  const match = compilePatterns(patterns);
  /** @type {ScopeFlag[]} */
  const protectedFlags = [];
  /** @type {ScopeFlag[]} */
  const topLevelFlags = [];
  /** @type {Set<string>} */
  const requested = new Set();
  /** @type {Set<string>} */
  const flaggedPaths = new Set();

  /** @param {ScopeFlag} flag @param {ScopeFlag[]} list */
  const add = (flag, list) => {
    // Folder flags ("netlify/") only match when written with the slash.
    if (promptNamesPath(prompt, flag.path)) {
      requested.add(flag.display);
      return;
    }
    list.push(flag);
  };

  for (const file of files) {
    for (const candidate of [file.path, file.previousPath].filter(Boolean)) {
      const path = /** @type {string} */ (candidate);
      const result = match(path);
      if (!result.matched) continue;
      let display = path;
      if (file.status === 'removed') display = `${path} (deleted)`;
      else if (file.status === 'renamed' && path === file.path) display = `${path} (renamed from ${file.previousPath})`;
      else if (file.status === 'renamed') display = `${path} (renamed to ${file.path})`;
      else if (file.status === 'added') display = `${path} (new file)`;
      flaggedPaths.add(path);
      add({ path, display, reason: `Protected path \`${result.rule}\``, rule: result.rule }, protectedFlags);
      break;
    }
  }

  if (flagNewTopLevel) {
    const added = files.filter((file) => file.status === 'added' || (file.status === 'renamed' && !file.path.includes('/')));
    for (const file of added) {
      if (!file.path.includes('/') && !flaggedPaths.has(file.path)) {
        add({ path: file.path, display: `${file.path} (new file)`, reason: 'New file at the repository root', rule: null }, topLevelFlags);
      }
    }
    /** @type {Map<string, ChangedFile[]>} */
    const bySegment = new Map();
    for (const file of added) {
      if (!file.path.includes('/')) continue;
      const segment = file.path.split('/')[0];
      bySegment.set(segment, [...(bySegment.get(segment) || []), file]);
    }
    let lookups = 0;
    let unchecked = 0;
    for (const [segment, segmentFiles] of [...bySegment.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      // Skip folders whose every new file is already flagged as protected.
      if (segmentFiles.every((file) => flaggedPaths.has(file.path))) continue;
      if (!baseTopLevelExists) continue;
      if (lookups >= MAX_TOP_LEVEL_LOOKUPS) {
        unchecked += 1;
        continue;
      }
      lookups += 1;
      if (!(await baseTopLevelExists(segment))) {
        add({ path: `${segment}/`, display: `${segment}/ (new folder)`, reason: 'New top-level folder', rule: null }, topLevelFlags);
      }
    }
    if (unchecked > 0) {
      topLevelFlags.push({ path: '', display: `and ${unchecked} more new top-level ${unchecked === 1 ? 'entry' : 'entries'}`, reason: 'Not checked (lookup limit)', rule: null });
    }
  }

  /** @param {ScopeFlag} a @param {ScopeFlag} b */
  const byPath = (a, b) => a.path.localeCompare(b.path);
  const flags = [...protectedFlags.sort(byPath), ...topLevelFlags.filter((flag) => flag.path).sort(byPath), ...topLevelFlags.filter((flag) => !flag.path)];
  return {
    flags,
    requested: [...requested].sort(),
    ...(complete ? {} : { incomplete: reason || 'unknown' }),
  };
}

const INCOMPLETE_REASONS = {
  'api-cap': 'the change is larger than the GitHub file list limit',
  'malformed-diff': "the agent's diff couldn't be fully parsed",
  'no-file-list': 'no file list was available for this run',
  unknown: 'the file list was incomplete',
};

/**
 * Escape text for use inside a Markdown inline code span in a table cell.
 * @param {string} value
 * @returns {string}
 */
function codeCell(value) {
  const clean = String(value)
    .replace(/<!--/g, '<\\!--')
    .replace(/[\r\n]+/g, ' ')
    .replace(/\|/g, '\\|');
  const ticks = clean.match(/`+/g);
  const fence = '`'.repeat(Math.max(0, ...(ticks || []).map((run) => run.length)) + 1);
  const pad = clean.startsWith('`') || clean.endsWith('`') ? ' ' : '';
  return `${fence}${pad}${clean}${pad}${fence}`;
}

/**
 * Split "path (note)" displays into a code-formatted path and plain note.
 * @param {string} display
 * @returns {string}
 */
function formatDisplay(display) {
  const match = /^(.*?)( \((?:new file|new folder|deleted|renamed (?:from|to) .*)\))$/.exec(display);
  if (!match) return codeCell(display);
  const note = match[2].replace(/(renamed (?:from|to) )(.*)\)$/, (_, prefix, other) => `${prefix}${codeCell(other)})`);
  return `${codeCell(match[1])}${note}`;
}

/**
 * @param {ScopeResult} result
 * @returns {string}
 */
function renderScopeSection(result) {
  const { flags, requested, incomplete } = result;
  if (flags.length === 0 && !incomplete) {
    if (requested.length === 0) return '';
    return `#### Protected files changed on request\n\n**Requested:** ${requested.map(formatDisplay).join(', ')} (named in the request)\n`;
  }
  let body = '#### ⚠️ Review these changes\n\n';
  if (flags.length > 0) {
    body += 'This run changed files that usually need a closer look:\n\n';
    body += '| File | Why it\'s flagged |\n|---|---|\n';
    for (const flag of flags.slice(0, MAX_TABLE_ROWS)) {
      const file = flag.path ? formatDisplay(flag.display) : flag.display;
      body += `| ${file} | ${flag.reason.replace(/\|/g, '\\|')} |\n`;
    }
    if (flags.length > MAX_TABLE_ROWS) body += `| and ${flags.length - MAX_TABLE_ROWS} more | |\n`;
    body += '\n';
  }
  if (requested.length > 0) {
    body += `**Requested:** ${requested.map(formatDisplay).join(', ')} (named in the request)\n\n`;
  }
  if (incomplete) {
    const why = INCOMPLETE_REASONS[/** @type {keyof typeof INCOMPLETE_REASONS} */ (incomplete)] || INCOMPLETE_REASONS.unknown;
    body += `Couldn't check every changed file (${why}).\n\n`;
  }
  if (flags.length > 0) {
    body += 'These may be unrelated to the request. Configure this check with `protected-paths`.\n';
  }
  return body;
}

/**
 * One line for the status comment, or '' when nothing was flagged.
 * @param {ScopeResult} result
 * @returns {string}
 */
function renderScopeStatusLine(result) {
  const count = result.flags.length;
  if (count === 0) return '';
  return `⚠️ ${count} ${count === 1 ? 'file' : 'files'} outside the usual scope. See the result comment.`;
}

/**
 * Path of the per-run scope result written by the "Check run scope" step.
 * @param {string} runnerTemp
 * @param {string} runnerId
 * @returns {string}
 */
function scopeResultPath(runnerTemp, runnerId) {
  return path.join(runnerTemp, `agent-scope-${String(runnerId).replace(/[^A-Za-z0-9_-]/g, '')}.json`);
}

/**
 * Read the scope result for renderers: SCOPE_RESULT_JSON wins, then the file.
 * Returns null when no check ran (so renderers add nothing).
 * @param {Record<string, string | undefined>} env
 * @param {string} runnerId
 * @returns {ScopeResult | null}
 */
function readScopeResult(env, runnerId) {
  /** @param {unknown} value @returns {ScopeResult | null} */
  const valid = (value) => {
    if (!value || typeof value !== 'object') return null;
    const candidate = /** @type {ScopeResult} */ (value);
    return Array.isArray(candidate.flags) && Array.isArray(candidate.requested) ? candidate : null;
  };
  if (env.SCOPE_RESULT_JSON) {
    try {
      return valid(JSON.parse(env.SCOPE_RESULT_JSON));
    } catch (_) {
      return null;
    }
  }
  if (!env.RUNNER_TEMP || !runnerId) return null;
  try {
    return valid(JSON.parse(fs.readFileSync(scopeResultPath(env.RUNNER_TEMP, runnerId), 'utf8')));
  } catch (_) {
    return null;
  }
}

module.exports = {
  scopeResultPath,
  readScopeResult,
  MAX_TOP_LEVEL_LOOKUPS,
  MAX_TABLE_ROWS,
  evaluateScope,
  promptNamesPath,
  renderScopeSection,
  renderScopeStatusLine,
};
