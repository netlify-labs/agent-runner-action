const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

/**
 * @typedef {{
 *   configPath: string;
 *   source: string;
 *   filter: string;
 *   buildCommand: string;
 * }} NetlifyFilterCandidate
 *
 * @typedef {{
 *   filter: string;
 *   source: string;
 * }} NetlifyFilterResolution
 *
 * @typedef {{
 *   projectRoot?: string;
 *   filter?: string;
 * }} ResolveNetlifyFilterOptions
 *
 * @typedef {{
 *   projectRoot: string;
 *   filter: string;
 * }} CliOptions
 */

const NETLIFY_CONFIG_SCAN_SKIP_DIRS = new Set([
  '.git',
  '.netlify',
  '.nax',
  '.next',
  '.nuxt',
  '.output',
  '.vercel',
  'build',
  'coverage',
  'dist',
  'node_modules',
]);

/**
 * @param {unknown} value
 * @returns {string[]}
 */
function shellWords(value) {
  /** @type {string[]} */
  const words = [];
  let current = '';
  let quote = '';
  let escaped = false;
  for (const char of String(value || '')) {
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (char === '\\') {
      escaped = true;
      continue;
    }
    if (quote) {
      if (char === quote) quote = '';
      else current += char;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current) {
        words.push(current);
        current = '';
      }
      continue;
    }
    current += char;
  }
  if (current) words.push(current);
  return words;
}

/**
 * @param {string} configPath
 * @returns {string}
 */
function readNetlifyBuildCommand(configPath) {
  if (!fs.existsSync(configPath)) return '';
  const text = fs.readFileSync(configPath, 'utf8');
  const buildMatch = text.match(/(?:^|\n)\s*\[build]\s*\n([\s\S]*?)(?=\n\s*\[[^\]]+]\s*(?:\n|$)|$)/);
  const buildBlock = buildMatch ? buildMatch[1] : text;
  const commandMatch = buildBlock.match(/(?:^|\n)\s*command\s*=\s*(["'])([\s\S]*?)\1/);
  return commandMatch ? commandMatch[2] : '';
}

/**
 * @param {string[]} paths
 * @param {string} cwd
 * @returns {string[]}
 */
function filterOutGitignored(paths, cwd) {
  if (!paths.length) return paths;
  const result = spawnSync('git', ['check-ignore', '--stdin', '-z'], {
    cwd,
    input: Buffer.from(paths.join('\0') + '\0'),
    timeout: 5000,
  });
  // 0 = at least one path matched, 1 = none matched, 128 = error (not a git repo, etc.)
  if (result.error || (result.status !== 0 && result.status !== 1)) return paths;
  const ignored = new Set((result.stdout || Buffer.alloc(0)).toString('utf8').split('\0').filter(Boolean));
  return paths.filter((candidate) => !ignored.has(candidate));
}

/**
 * @param {string | undefined} projectRoot
 * @param {{ maxDepth?: number }} [options]
 * @returns {string[]}
 */
function findNetlifyConfigPaths(projectRoot, { maxDepth = 6 } = {}) {
  const root = path.resolve(projectRoot || process.cwd());
  /** @type {string[]} */
  const configs = [];
  /**
   * @param {string} dir
   * @param {number} depth
   */
  const visit = (dir, depth) => {
    if (depth > maxDepth) return;
    /** @type {import('node:fs').Dirent[]} */
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isFile() && entry.name === 'netlify.toml') {
        configs.push(fullPath);
        continue;
      }
      if (!entry.isDirectory()) continue;
      if (NETLIFY_CONFIG_SCAN_SKIP_DIRS.has(entry.name) || entry.name.startsWith('.')) continue;
      visit(fullPath, depth + 1);
    }
  };
  visit(root, 0);
  return filterOutGitignored(configs, root);
}

/**
 * @param {unknown} command
 * @returns {string}
 */
function inferNetlifyFilterFromCommand(command) {
  /** @type {string[]} */
  const filters = [];
  const words = shellWords(command);
  for (let index = 0; index < words.length; index += 1) {
    const word = words[index];
    if (word === '--filter' || word === '-F') {
      if (words[index + 1]) filters.push(words[index + 1]);
      index += 1;
      continue;
    }
    if (word.startsWith('--filter=')) {
      const value = word.slice('--filter='.length);
      if (value) filters.push(value);
    }
  }
  const unique = [...new Set(filters)];
  return unique.length === 1 ? unique[0] : '';
}

/**
 * @param {string | undefined} projectRoot
 * @returns {NetlifyFilterCandidate[]}
 */
function listNetlifyFilterCandidates(projectRoot) {
  const root = path.resolve(projectRoot || process.cwd());
  return findNetlifyConfigPaths(root).map((configPath) => {
    const buildCommand = readNetlifyBuildCommand(configPath);
    return {
      configPath,
      source: path.relative(root, configPath) || 'netlify.toml',
      filter: inferNetlifyFilterFromCommand(buildCommand),
      buildCommand,
    };
  });
}

/**
 * @param {ResolveNetlifyFilterOptions} [options]
 * @returns {NetlifyFilterResolution}
 */
function resolveNetlifyFilter({ projectRoot, filter } = {}) {
  if (filter) return { filter: String(filter), source: 'input' };
  const root = path.resolve(projectRoot || process.cwd());
  const matches = listNetlifyFilterCandidates(root).filter((candidate) => candidate.filter);
  const uniqueFilters = [...new Set(matches.map((candidate) => candidate.filter))];
  if (uniqueFilters.length !== 1) return { filter: '', source: '' };
  const source = matches.find((candidate) => candidate.filter === uniqueFilters[0])?.source || 'netlify.toml';
  return { filter: uniqueFilters[0], source };
}

/**
 * @param {string[]} argv
 * @returns {CliOptions}
 */
function parseCliArgs(argv) {
  const args = { projectRoot: process.cwd(), filter: '' };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--project-root') {
      args.projectRoot = argv[index + 1] || args.projectRoot;
      index += 1;
      continue;
    }
    if (arg === '--filter') {
      args.filter = argv[index + 1] || '';
      index += 1;
    }
  }
  return args;
}

/**
 * @param {Record<string, string | undefined>} outputs
 * @param {string | undefined} [outputPath]
 * @returns {void}
 */
function appendGithubOutput(outputs, outputPath = process.env.GITHUB_OUTPUT) {
  if (!outputPath) return;
  const lines = Object.entries(outputs).map(([key, value]) => `${key}=${String(value || '')}`);
  fs.appendFileSync(outputPath, `${lines.join('\n')}\n`, 'utf8');
}

/**
 * @param {string[]} [argv]
 * @returns {void}
 */
function main(argv = process.argv.slice(2)) {
  const options = parseCliArgs(argv);
  const result = resolveNetlifyFilter(options);
  appendGithubOutput(result);
  if (result.filter && result.source === 'input') {
    console.log(`Netlify app filter: ${result.filter}`);
  } else if (result.filter) {
    console.log(`Netlify app filter: ${result.filter} (auto-detected from ${result.source})`);
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  appendGithubOutput,
  findNetlifyConfigPaths,
  inferNetlifyFilterFromCommand,
  listNetlifyFilterCandidates,
  main,
  parseCliArgs,
  readNetlifyBuildCommand,
  resolveNetlifyFilter,
  shellWords,
};
