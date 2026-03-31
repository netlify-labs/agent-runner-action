// Shared utilities for the Netlify Agents action.
// Used by actions/github-script steps via:
//   const utils = require(`${process.env.ACTION_DIR}/src/utils.js`)

/** @typedef {import('./types').InProgressCommentOptions} InProgressCommentOptions */

const path = require('path');

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

/** Regex that matches @netlify (and typos) with optional suffixes like -agent, -agents, -ai */
const TRIGGER_PATTERN = /@(?:netlify|nelify|netlfy|netify|netlif|netfly)(?:[_-](?:agents?(?:[_-]runs?)?|ai))?/i;

// ---------------------------------------------------------------------------
// Model handling
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
 * Build a status comment body (in-progress state).
 * @param {InProgressCommentOptions} options
 * @returns {string}
 */
function buildInProgressComment({ agentRunUrl, prompt, model, runnerId }) {
  const [flavor, emoji] = randomFlavor();
  const clean = cleanPrompt(prompt);

  let body = agentRunUrl
    ? `### [Netlify Agent Runner ${flavor}](${agentRunUrl}) ${emoji}\n\n`
    : `### Netlify Agent Runner ${flavor} ${emoji}\n\n`;

  if (clean) body += formatPromptBlock(clean);
  body += `**Model:** \`${model}\`\n`;

  if (agentRunUrl) {
    body += `\n[Netlify agent run](${agentRunUrl})`;
  }

  if (runnerId) {
    body += `\n<!-- netlify-agent-runner-id:${runnerId} -->`;
  }
  body += `\n<!-- netlify-agent-run-status -->`;

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
  buildInProgressComment,
};
