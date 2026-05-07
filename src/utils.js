// Shared utilities for the Netlify Agent Runners action.
// Used by actions/github-script steps via:
//   const utils = require(`${process.env.ACTION_DIR}/src/utils.js`)

/** @typedef {import('./types').InProgressCommentOptions} InProgressCommentOptions */

const path = require('path');
const {
  STATUS_COMMENT_MARKER,
  renderRunnerIdMarker,
  stripAllHtmlComments,
} = require('./comment-markers');

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
 * Strip Markdown code regions (fenced blocks and inline code spans) from text
 * so trigger detection ignores @netlify mentions a user is quoting verbatim.
 *
 * Handles:
 *   - ```fenced``` and ~~~fenced~~~ blocks
 *   - `inline` and ``inline with backtick`` spans (any number of paired backticks)
 *
 * @param {string} text
 * @returns {string}
 */
function stripMarkdownCode(text) {
  if (!text) return '';
  return text
    .replace(/```[\s\S]*?```/g, '')
    .replace(/~~~[\s\S]*?~~~/g, '')
    .replace(/(`+)[\s\S]*?\1/g, '');
}

/**
 * Check whether `text` contains any recognised trigger mention.
 * Mentions inside Markdown code spans or fenced blocks are ignored so users
 * can quote `@netlify` verbatim without firing the action.
 * @param {string | null | undefined} text
 * @returns {boolean}
 */
function matchesTrigger(text) {
  if (!text) return false;
  return TRIGGER_PATTERN.test(stripMarkdownCode(text));
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
 * If the prompt exceeds 300 characters, truncates and links to the source.
 * @param {string | null | undefined} prompt
 * @param {string} [sourceUrl] - URL to the original issue/comment containing the full prompt
 * @returns {string}
 */
function formatPromptBlock(prompt, sourceUrl) {
  if (!prompt) return '';
  // Strip every HTML comment the user may have included so attacker-controlled
  // markers — even ones shaped like ours — can never be reflected into a
  // bot-authored comment body.
  prompt = stripAllHtmlComments(prompt);
  if (!prompt) return '';
  const MAX_LENGTH = 350;
  let display = prompt;
  let truncated = false;
  if (prompt.length > MAX_LENGTH) {
    // Cut at the last newline at or before the limit to avoid mid-line truncation
    const lastNewline = prompt.lastIndexOf('\n', MAX_LENGTH);
    const cutAt = lastNewline > 0 ? lastNewline : MAX_LENGTH;
    display = prompt.slice(0, cutAt).trimEnd() + '…';
    truncated = true;
  }
  const lines = display.split('\n');
  lines[0] = `**${lines[0]}**`;
  if (truncated && sourceUrl) {
    lines[lines.length - 1] += ` [See full prompt](${sourceUrl})`;
  }
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
  const sourceUrlMatch = (prompt || '').match(/◌\s+(\S+)/);
  const sourceUrl = sourceUrlMatch ? sourceUrlMatch[1] : '';

  let body = agentRunUrl
    ? `### [Netlify Agent Run Status](${agentRunUrl}) ${emoji}\n\n`
    : `### Netlify Agent Run Status ${emoji}\n\n`;

  body += `Netlify Agent Runners ${flavor}\n\n`;
  body += `**Agent:** \`${model}\`\n\n`;
  if (clean) body += formatPromptBlock(clean, sourceUrl);

  /** @type {string[]} */
  const links = [];
  if (agentRunUrl) links.push(`[View the in progress agent run in Netlify](${agentRunUrl})`);
  if (ghActionUrl) links.push(`[GitHub Action logs](${ghActionUrl})`);
  if (links.length) body += links.join(' • ') + '\n';

  body += `\n*Started at ${formatRunDate(new Date().toISOString())}*\n`;

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
