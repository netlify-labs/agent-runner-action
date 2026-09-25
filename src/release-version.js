// Validate a requested release version before release.yml tags anything.
//
// Usage (from release.yml):
//   node src/release-version.js --version 1.1.0 --tags "$(git tag -l 'v*')" \
//     --main-head true --dry-run false
// Prints a JSON result and exits non-zero when the release must not proceed.

const SUPPORTED_MAJOR = 1;
const VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

/**
 * @typedef {{ major: number, minor: number, patch: number }} Version
 */

/**
 * Parse `X.Y.Z` (no `v` prefix, prerelease, build metadata, or leading zeros).
 * @param {string} value
 * @returns {Version}
 */
function parseVersion(value) {
  const match = VERSION_PATTERN.exec(String(value || '').trim());
  if (!match) {
    throw new Error(`Invalid version "${value}". Expected X.Y.Z, for example 1.2.0.`);
  }
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) };
}

/**
 * @param {Version} a
 * @param {Version} b
 * @returns {number}
 */
function compareVersions(a, b) {
  return (a.major - b.major) || (a.minor - b.minor) || (a.patch - b.patch);
}

/**
 * Parse release tags (`vX.Y.Z`) from a list, ignoring moving tags like `v1`.
 * @param {string[]} tags
 * @returns {Version[]}
 */
function releaseTags(tags) {
  /** @type {Version[]} */
  const versions = [];
  for (const tag of tags) {
    const trimmed = String(tag || '').trim();
    if (!trimmed.startsWith('v')) continue;
    try {
      versions.push(parseVersion(trimmed.slice(1)));
    } catch (_) {
      // Not a full release tag (e.g. the moving `v1` tag).
    }
  }
  return versions;
}

/**
 * @param {{ version: string, existingTags: string[], isMainHead: boolean, dryRun: boolean }} input
 * @returns {{ ok: boolean, errors: string[], warnings: string[], tag: string, majorTag: string }}
 */
function validateRelease({ version, existingTags, isMainHead, dryRun }) {
  /** @type {string[]} */
  const errors = [];
  /** @type {string[]} */
  const warnings = [];
  let parsed;
  try {
    parsed = parseVersion(version);
  } catch (error) {
    errors.push(/** @type {Error} */ (error).message);
    return { ok: false, errors, warnings, tag: '', majorTag: '' };
  }

  const tag = `v${parsed.major}.${parsed.minor}.${parsed.patch}`;
  const majorTag = `v${parsed.major}`;

  if (parsed.major !== SUPPORTED_MAJOR) {
    errors.push(`Major version ${parsed.major} is not supported by this workflow (expected ${SUPPORTED_MAJOR}). A new major needs a deliberate workflow change.`);
  }
  if (existingTags.map((entry) => String(entry).trim()).includes(tag)) {
    errors.push(`Tag ${tag} already exists.`);
  }
  const sameMajor = releaseTags(existingTags).filter((entry) => entry.major === parsed.major);
  const latest = sameMajor.sort(compareVersions).pop();
  if (latest && compareVersions(parsed, latest) <= 0) {
    errors.push(`Version ${tag} must be greater than the latest release v${latest.major}.${latest.minor}.${latest.patch}.`);
  }
  if (!isMainHead) {
    if (dryRun) {
      warnings.push('main-HEAD check skipped (not main)');
    } else {
      errors.push('Releases must be published from the current main HEAD.');
    }
  }

  return { ok: errors.length === 0, errors, warnings, tag, majorTag };
}

/**
 * @param {string[]} argv
 * @returns {Record<string, string>}
 */
function parseArgs(argv) {
  /** @type {Record<string, string>} */
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (!key.startsWith('--')) continue;
    args[key.slice(2)] = argv[index + 1] || '';
    index += 1;
  }
  return args;
}

if (require.main === module) {
  const args = parseArgs(process.argv.slice(2));
  const result = validateRelease({
    version: args.version || '',
    existingTags: String(args.tags || '').split(/\s+/).filter(Boolean),
    isMainHead: args['main-head'] === 'true',
    dryRun: args['dry-run'] !== 'false',
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exitCode = result.ok ? 0 : 1;
}

module.exports = { parseVersion, compareVersions, releaseTags, validateRelease, SUPPORTED_MAJOR };
