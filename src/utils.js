// Shared utilities for the Netlify Agent Runners action.
// Used by actions/github-script steps via:
//   const utils = require(`${process.env.ACTION_DIR}/src/utils.js`)

/** @typedef {import('./types').InProgressCommentOptions} InProgressCommentOptions */

const path = require('path');
const { STATUS_COMMENT_MARKER, renderRunnerIdMarker } = require('./comment-markers');

/** @type {[string, string][]} */
const FLAVOR_MESSAGES = require(path.join(__dirname, 'flavor-messages.json'));

// ---------------------------------------------------------------------------
// Trigger detection
// ---------------------------------------------------------------------------

/**
 * All accepted mention variants (base + common typos).
 * @type {string[]}
 */
const TRIGGER_BASES = ['netlify', 'nelify', 'netlfy', 'netify', 'netlif', 'netfly'];

const TRIGGER_BASE_PATTERN = `(?:${TRIGGER_BASES.join('|')})`;
const TRIGGER_SUFFIX_PATTERN = '(?:[_-](?:agents?(?:[_-]runs?)?|ai))?';

/**
 * Standalone @netlify mention (and typos) with optional suffixes like -agent,
 * -agents, or -ai. Rejects package scopes like @netlify/pkg and email-like
 * strings such as me@netlify.com.
 */
const TRIGGER_PATTERN = new RegExp(
  `(?<!\\w)@${TRIGGER_BASE_PATTERN}${TRIGGER_SUFFIX_PATTERN}(?![\\w./-])`,
  'i'
);

// ---------------------------------------------------------------------------
// Agent selection handling. Legacy API fields still use the name "model".
// ---------------------------------------------------------------------------

/** @type {string[]} */
const VALID_MODELS = ['claude', 'codex', 'gemini'];
const DEFAULT_MODEL = 'codex';

/** Match "@netlify [with|using|via] <model>" */
const MODEL_PATTERN = new RegExp(
  `${TRIGGER_PATTERN.source}\\s+(?:(?:with|using|use|via)\\s+)?(${VALID_MODELS.join('|')})\\b`,
  'i'
);

// ---------------------------------------------------------------------------
// Helper functions
// ---------------------------------------------------------------------------

/**
 * Check whether `text` contains any recognised trigger mention.
 * @param {string | null | undefined} text
 * @returns {boolean}
 */
function matchesTrigger(text) {
  if (!text) return false;
  return TRIGGER_PATTERN.test(text);
}

/**
 * Extract the model name from trigger text. Falls back to `defaultModel`.
 * @param {string | null | undefined} text
 * @param {string} [defaultModel]
 * @returns {string}
 */
function extractModel(text, defaultModel) {
  if (!text) return defaultModel || DEFAULT_MODEL;
  const match = text.match(MODEL_PATTERN);
  return match ? match[1].toLowerCase() : (defaultModel || DEFAULT_MODEL);
}

/**
 * Strip the @netlify mention, optional model prefix, and ◌ markers from prompt text.
 * @param {string | null | undefined} text
 * @returns {string}
 */
function cleanPrompt(text) {
  if (!text) return '';
  return text
    .replace(
      new RegExp(
        `${TRIGGER_PATTERN.source}\\s+(?:(?:with|using|use|via)\\s+)?(?:${VALID_MODELS.join('|')})?\\s*`,
        'i'
      ),
      ''
    )
    .replace(/◌/g, 'via')
    .trim();
}

/**
 * Pick a random [flavorText, emoji] pair.
 * @returns {[string, string]}
 */
function randomFlavor() {
  return FLAVOR_MESSAGES[Math.floor(Math.random() * FLAVOR_MESSAGES.length)];
}

/**
 * Build the "contains" expressions for a GitHub Actions `if:` condition.
 * @param {string} field - The GitHub expression field, e.g. `github.event.comment.body`
 * @returns {string[]} Array of `contains(field, '@netlify')` strings
 */
function ghContainsExpressions(field) {
  return TRIGGER_BASES.map(base => `contains(${field}, '@${base}')`);
}

/**
 * Format a prompt for display in a GitHub comment.
 * Bolds the first line and blockquotes all lines.
 * @param {string | null | undefined} prompt
 * @returns {string}
 */
function formatPromptBlock(prompt) {
  if (!prompt) return '';
  const lines = prompt.split('\n');
  lines[0] = `**${lines[0]}**`;
  const quoted = lines.map(l => `> ${l}`).join('\n');
  return `**Prompt:**\n\n${quoted}\n\n`;
}

/**
 * Format a date string into "2:17pm on April 4th, 2026"
 * Uses TZ environment variable for timezone (defaults to America/Los_Angeles).
 * @param {string} dateStr - ISO date string
 * @returns {string}
 */
function formatRunDate(dateStr) {
  const d = new Date(dateStr);
  const tz = process.env.TZ || 'America/Los_Angeles';
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour: 'numeric', minute: '2-digit',
    month: 'long', day: 'numeric', year: 'numeric', hour12: true,
    timeZoneName: 'short'
  }).formatToParts(d);
  const get = (/** @type {string} */ type) => (parts.find(p => p.type === type) || {}).value || '';
  const hours = get('hour');
  const minutes = get('minute');
  const dayPeriod = get('dayPeriod').toLowerCase();
  const month = get('month');
  const date = parseInt(get('day'), 10);
  const year = get('year');
  const tzAbbr = get('timeZoneName');
  const suffixes = ['th', 'st', 'nd', 'rd'];
  const suffix = (date % 100 >= 11 && date % 100 <= 13) ? 'th' : (suffixes[date % 10] || 'th');
  return `${hours}:${minutes}${dayPeriod} ${tzAbbr} on ${month} ${date}${suffix}, ${year}`;
}

/**
 * Build a status comment body (in-progress state).
 * @param {InProgressCommentOptions} options
 * @returns {string}
 */
function buildInProgressComment({ agentRunUrl, prompt, model, runnerId, ghActionUrl }) {
  const [flavor, emoji] = randomFlavor();
  const clean = cleanPrompt(prompt);

  let body = agentRunUrl
    ? `### [Netlify Agent Runners ${flavor}](${agentRunUrl}) ${emoji}\n\n`
    : `### Netlify Agent Runners ${flavor} ${emoji}\n\n`;

  body += `**Agent:** \`${model}\`\n\n`;
  if (clean) body += formatPromptBlock(clean);

  /** @type {string[]} */
  const links = [];
  if (agentRunUrl) links.push(`[View the in progress agent run in Netlify](${agentRunUrl})`);
  if (ghActionUrl) links.push(`[GitHub Action logs](${ghActionUrl})`);
  if (links.length) body += links.join(' • ') + '\n';

  if (runnerId) {
    body += renderRunnerIdMarker(runnerId);
  }
  body += `\n${STATUS_COMMENT_MARKER}`;

  return body;
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  TRIGGER_BASES,
  TRIGGER_PATTERN,
  VALID_MODELS,
  DEFAULT_MODEL,
  MODEL_PATTERN,
  FLAVOR_MESSAGES,
  matchesTrigger,
  extractModel,
  cleanPrompt,
  randomFlavor,
  ghContainsExpressions,
  formatPromptBlock,
  formatRunDate,
  buildInProgressComment,
};
