// Minimal, dependency-free glob matcher for repo-relative POSIX paths, used by
// the scope guard (protected-paths input).
//
// Semantics:
//   **    any sequence including "/"; a leading "**/" also matches zero dirs
//   *     any sequence without "/"
//   ?     one character other than "/"
//   {a,b} alternation (not nested)
//   !pat  negation; patterns are evaluated in order and the last match
//         decides whether a path matches. The reported rule is the first
//         positive pattern after the last matching negation.
// A pattern WITHOUT "/" matches only at the repository root ("*.toml",
// "AGENTS.md"). This is stricter than .gitignore on purpose: write "**/" to
// match at any depth. Matching is case-sensitive, like git.

/** @type {readonly string[]} */
const DEFAULT_PROTECTED_PATHS = Object.freeze([
  '.github/**',
  '**/netlify.toml',
  '*.toml',
  '**/package-lock.json',
  '**/pnpm-lock.yaml',
  '**/yarn.lock',
  '**/bun.lock',
  '**/bun.lockb',
  '**/pnpm-workspace.yaml',
  'AGENTS.md',
  'CLAUDE.md',
  '**/AGENTS.md',
  '**/.env*',
]);

const REGEX_SPECIALS = /[.+^$()|[\]\\]/;

/**
 * Convert one glob (without a leading "!") to an anchored RegExp.
 * @param {string} glob
 * @returns {RegExp}
 */
function globToRegExp(glob) {
  let source = '';
  let inBraces = false;
  let index = 0;
  while (index < glob.length) {
    const char = glob[index];
    if (char === '*') {
      if (glob[index + 1] === '*') {
        const atSegmentStart = index === 0 || glob[index - 1] === '/';
        if (atSegmentStart && glob[index + 2] === '/') {
          source += '(?:.*/)?';
          index += 3;
          continue;
        }
        source += '.*';
        index += 2;
        continue;
      }
      source += '[^/]*';
    } else if (char === '?') {
      source += '[^/]';
    } else if (char === '{') {
      if (inBraces) throw new Error(`Nested braces are not supported in pattern "${glob}".`);
      inBraces = true;
      source += '(?:';
    } else if (char === '}') {
      if (!inBraces) throw new Error(`Unbalanced "}" in pattern "${glob}".`);
      inBraces = false;
      source += ')';
    } else if (char === ',' && inBraces) {
      source += '|';
    } else if (REGEX_SPECIALS.test(char)) {
      source += `\\${char}`;
    } else {
      source += char;
    }
    index += 1;
  }
  if (inBraces) throw new Error(`Unbalanced "{" in pattern "${glob}".`);
  return new RegExp(`^${source}$`);
}

/**
 * Split an input list on newlines and top-level commas (commas inside {a,b}
 * belong to the pattern). Expands "default" and treats "none" as empty.
 * Blank lines and "#" comments are ignored.
 * @param {string | null | undefined} input
 * @returns {string[]}
 */
function parsePatternList(input) {
  /** @type {string[]} */
  const entries = [];
  for (const rawLine of String(input ?? '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    let depth = 0;
    let current = '';
    for (const char of line) {
      if (char === '{') depth += 1;
      if (char === '}') depth = Math.max(0, depth - 1);
      if (char === ',' && depth === 0) {
        entries.push(current.trim());
        current = '';
        continue;
      }
      current += char;
    }
    entries.push(current.trim());
  }
  /** @type {string[]} */
  const patterns = [];
  for (const entry of entries.filter(Boolean)) {
    if (entry === 'none') continue;
    if (entry === 'default') {
      patterns.push(...DEFAULT_PROTECTED_PATHS);
      continue;
    }
    patterns.push(entry);
  }
  return patterns;
}

/**
 * @typedef {{ matched: boolean, rule: string | null }} MatchResult
 */

/**
 * Compile patterns into a matcher. The last matching pattern decides.
 * @param {string[]} patterns
 * @returns {(path: string) => MatchResult}
 */
function compilePatterns(patterns) {
  const compiled = patterns.map((pattern) => {
    const negated = pattern.startsWith('!');
    const glob = negated ? pattern.slice(1) : pattern;
    if (!glob) throw new Error('Empty pattern after "!".');
    return { pattern, negated, regex: globToRegExp(glob) };
  });
  return (filePath) => {
    const normalized = String(filePath || '').replace(/^\.\//, '');
    // The last matching pattern decides WHETHER the path matches. The rule we
    // report is the first positive pattern after the last matching negation,
    // so earlier, more specific entries (e.g. "**/netlify.toml" before
    // "*.toml") name the reason.
    let matched = false;
    /** @type {string | null} */
    let rule = null;
    for (const entry of compiled) {
      if (!entry.regex.test(normalized)) continue;
      if (entry.negated) {
        matched = false;
        rule = null;
      } else {
        matched = true;
        rule = rule || entry.pattern;
      }
    }
    return { matched, rule: matched ? rule : null };
  };
}

module.exports = { DEFAULT_PROTECTED_PATHS, globToRegExp, parsePatternList, compilePatterns };
