// Shared helpers for hidden markers embedded in issue and PR comments.

const STATUS_COMMENT_MARKER = '<!-- netlify-agent-run-status -->';
const HISTORY_COMMENT_MARKER = '<!-- netlify-agent-run-history -->';
const RUNNER_ID_MARKER_PREFIX = '<!-- netlify-agent-runner-id:';
const SESSION_DATA_MARKER_PREFIX = '<!-- netlify-agent-session-data:';
const RESULT_COMMENT_MARKER_PREFIX = '<!-- netlify-agent-run-result:';
const RESULT_COMMENT_MARKER_NAME = 'netlify-agent-run-result';
const MARKER_SUFFIX = '-->';

// Conservative format for runner IDs: alphanumerics, underscore, hyphen only.
// Rejects characters that could break JSON construction (quotes, backslashes),
// shell argument boundaries, or Markdown link syntax.
const RUNNER_ID_FORMAT = /^[A-Za-z0-9_-]{1,128}$/;

// Allowlist of HTML comments the action recognizes. Any other HTML comment
// found in user-influenced content is stripped before parsing/rendering, so
// outsiders cannot smuggle fake markers and bot comments cannot accidentally
// reflect attacker-supplied markers from echoed user content.
const ALLOWED_MARKER_INNER = /^\s*netlify-agent-(?:run-status|run-history|run-result(?::|\s|$)|runner-id:|session-data:)/;

// Allowlist for URL-bearing fields in session-data entries. These URLs flow
// into bot-rendered Markdown links; anything outside these patterns gets
// dropped at parse time so phishing links cannot ride through poisoned state.
const SESSION_URL_ALLOWLIST = {
  pr_url:        /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/\d+(?:[/?#].*)?$/,
  gh_action_url: /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/actions\/runs\/\d+(?:[/?#].*)?$/,
  screenshot:    /^https:\/\/(?:[A-Za-z0-9-]+\.)*(?:netlify\.app|netlifyusercontent\.com|app\.netlify\.com|api\.netlify\.com)\/[^\s]*$/i,
};
const AGENT_RUN_URL_PATTERN = /https:\/\/app\.netlify\.com\/projects\/([A-Za-z0-9_.-]+)\/agent-runs\/([A-Za-z0-9_-]{1,128})(?:\?session=([A-Za-z0-9_-]{1,128}))?(?=$|[\s)\]>}.,!?])/g;
// 4 covers git's minimum unique-prefix display; 64 covers full SHA-256.
const COMMIT_SHA_FORMAT = /^[0-9a-f]{4,64}$/i;
const SESSION_FIELD_MAX_LENGTH = 2048;

/**
 * Drop URL/sha fields that don't match their format. Mutates a copy.
 * @param {Record<string, unknown>} entry
 * @returns {Record<string, unknown>}
 */
function sanitizeSessionEntry(entry) {
  /** @type {Record<string, unknown>} */
  const out = {};
  for (const [key, value] of Object.entries(entry)) {
    if (typeof value !== 'string') {
      // Non-string values aren't currently expected; keep them only if scalar.
      if (value === null || typeof value === 'number' || typeof value === 'boolean') {
        out[key] = value;
      }
      continue;
    }
    if (value.length > SESSION_FIELD_MAX_LENGTH) continue;
    const allowlist = /** @type {Record<string, RegExp>} */ (SESSION_URL_ALLOWLIST);
    if (Object.prototype.hasOwnProperty.call(allowlist, key)) {
      if (!allowlist[key].test(value)) continue;
    } else if (key === 'commit_sha') {
      if (!COMMIT_SHA_FORMAT.test(value)) continue;
    }
    out[key] = value;
  }
  return out;
}

/**
 * @param {unknown} body
 * @returns {string}
 */
function normalizeBody(body) {
  return typeof body === 'string' ? body : '';
}

/**
 * @param {unknown} sessionDataMap
 * @returns {Record<string, unknown>}
 */
function normalizeSessionDataMap(sessionDataMap) {
  if (!sessionDataMap) return {};
  if (typeof sessionDataMap === 'string') {
    try {
      return normalizeSessionDataMap(JSON.parse(sessionDataMap));
    } catch (_) {
      return {};
    }
  }
  if (Array.isArray(sessionDataMap) || typeof sessionDataMap !== 'object') {
    return {};
  }
  return /** @type {Record<string, unknown>} */ (sessionDataMap);
}

/**
 * @param {string} markerWithValue
 * @returns {string}
 */
function renderMarker(markerWithValue) {
  return `${markerWithValue} ${MARKER_SUFFIX}`;
}

/**
 * @param {string} value
 * @returns {string}
 */
function quoteAttribute(value) {
  return JSON.stringify(String(value));
}

/**
 * @param {unknown} value
 * @returns {number | null}
 */
function finiteNumber(value) {
  const number = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

/**
 * @param {unknown} usage
 * @returns {{totalTokens?: number, totalCreditsCost?: number, stepsCount?: number, creditLimitExceeded?: boolean} | null}
 */
function normalizeResultUsage(usage) {
  if (!usage || typeof usage !== 'object' || Array.isArray(usage)) return null;
  const record = /** @type {Record<string, unknown>} */ (usage);
  /** @type {{totalTokens?: number, totalCreditsCost?: number, stepsCount?: number, creditLimitExceeded?: boolean}} */
  const out = {};

  const totalTokens = finiteNumber(record.totalTokens ?? record.total_tokens);
  if (totalTokens !== null) out.totalTokens = totalTokens;

  const totalCreditsCost = finiteNumber(record.totalCreditsCost ?? record.total_credits_cost);
  if (totalCreditsCost !== null) out.totalCreditsCost = totalCreditsCost;

  const stepsCount = finiteNumber(record.stepsCount ?? record.steps_count);
  if (stepsCount !== null) out.stepsCount = Math.floor(stepsCount);

  if (typeof record.creditLimitExceeded === 'boolean') {
    out.creditLimitExceeded = record.creditLimitExceeded;
  } else if (typeof record.credit_limit_exceeded === 'boolean') {
    out.creditLimitExceeded = record.credit_limit_exceeded;
  }

  return Object.keys(out).length > 0 ? out : null;
}

/**
 * @param {string} siteName
 * @param {string} runnerId
 * @param {string} [sessionId]
 * @returns {string}
 */
function formatAgentRunUrl(siteName, runnerId, sessionId = '') {
  if (!siteName || !RUNNER_ID_FORMAT.test(runnerId)) return '';
  const base = `https://app.netlify.com/projects/${siteName}/agent-runs/${runnerId}`;
  if (!RUNNER_ID_FORMAT.test(sessionId)) return base;
  return `${base}?session=${encodeURIComponent(sessionId)}`;
}

/**
 * Load the parser only on the read path that needs it. This keeps early
 * trigger checks working before the composite action installs dependencies.
 * @param {string} content
 * @param {Record<string, unknown>} options
 * @returns {{blocks?: Array<Record<string, any>>}}
 */
function parseCommentBlocks(content, options) {
  const { parseBlocks } = require('comment-block-parser');
  return /** @type {{blocks?: Array<Record<string, any>>}} */ (parseBlocks(content, options));
}

/**
 * @param {unknown} body
 * @param {string} markerPrefix
 * @returns {string}
 */
function readMarkerValue(body, markerPrefix) {
  const text = normalizeBody(body);
  if (!text) return '';

  const markerStart = text.indexOf(markerPrefix);
  if (markerStart === -1) return '';

  const valueStart = markerStart + markerPrefix.length;
  const markerEnd = text.indexOf(MARKER_SUFFIX, valueStart);
  if (markerEnd !== -1) {
    return text.slice(valueStart, markerEnd).trim();
  }

  // Legacy comments may miss the marker suffix; read to end-of-line.
  const lineEnd = text.indexOf('\n', valueStart);
  return (lineEnd === -1 ? text.slice(valueStart) : text.slice(valueStart, lineEnd)).trim();
}

/**
 * @param {string} [runnerId]
 * @returns {string}
 */
function renderRunnerIdMarker(runnerId = '') {
  return renderMarker(`${RUNNER_ID_MARKER_PREFIX}${runnerId}`);
}

/**
 * @param {unknown} body
 * @returns {string}
 */
function parseRunnerId(body) {
  const value = readMarkerValue(body, RUNNER_ID_MARKER_PREFIX);
  if (!value) return '';
  if (!RUNNER_ID_FORMAT.test(value)) return '';
  return value;
}

/**
 * @param {{runnerId?: string, sessionId?: string, usage?: Record<string, unknown> | null}} identifiers
 * @returns {string}
 */
function renderResultCommentMarker({ runnerId = '', sessionId = '', usage = null } = {}) {
  if (!RUNNER_ID_FORMAT.test(runnerId) || !RUNNER_ID_FORMAT.test(sessionId)) {
    return '';
  }
  const normalizedUsage = normalizeResultUsage(usage);
  const attributes = [
    `runnerId=${quoteAttribute(runnerId)}`,
    `sessionId=${quoteAttribute(sessionId)}`,
  ];
  if (normalizedUsage && normalizedUsage.totalTokens !== undefined) {
    attributes.push(`totalTokens=${normalizedUsage.totalTokens}`);
  }
  if (normalizedUsage && normalizedUsage.totalCreditsCost !== undefined) {
    attributes.push(`totalCreditsCost=${normalizedUsage.totalCreditsCost}`);
  }
  if (normalizedUsage && normalizedUsage.stepsCount !== undefined) {
    attributes.push(`stepsCount=${normalizedUsage.stepsCount}`);
  }
  if (normalizedUsage && normalizedUsage.creditLimitExceeded !== undefined) {
    attributes.push(`creditLimitExceeded=${normalizedUsage.creditLimitExceeded ? 'true' : 'false'}`);
  }
  return renderMarker(`<!-- ${RESULT_COMMENT_MARKER_NAME} ${attributes.join(' ')}`);
}

/**
 * @param {unknown} body
 * @returns {{runnerId: string, sessionId: string, usage: {totalTokens?: number, totalCreditsCost?: number, stepsCount?: number, creditLimitExceeded?: boolean} | null} | null}
 */
function parseResultCommentMarker(body) {
  const text = normalizeBody(body);
  if (!text) return null;

  const parsed = parseCommentBlocks(text, {
    syntax: 'md',
    open: RESULT_COMMENT_MARKER_NAME,
    close: false,
  });
  const block = parsed.blocks && parsed.blocks[0];
  const options = block && block.options && typeof block.options === 'object'
    ? /** @type {Record<string, unknown>} */ (block.options)
    : null;
  if (options && (options.runnerId !== undefined || options.sessionId !== undefined)) {
    const runnerId = typeof options.runnerId === 'string' ? options.runnerId : '';
    const sessionId = typeof options.sessionId === 'string' ? options.sessionId : '';
    if (!RUNNER_ID_FORMAT.test(runnerId) || !RUNNER_ID_FORMAT.test(sessionId)) {
      return null;
    }
    return {
      runnerId,
      sessionId,
      usage: normalizeResultUsage(options),
    };
  }

  const value = readMarkerValue(body, RESULT_COMMENT_MARKER_PREFIX);
  if (!value) return null;

  const parts = value.split(':');
  if (parts.length !== 2) return null;
  const [runnerId, sessionId] = parts;
  if (!RUNNER_ID_FORMAT.test(runnerId) || !RUNNER_ID_FORMAT.test(sessionId)) {
    return null;
  }
  return { runnerId, sessionId, usage: null };
}

/**
 * @param {unknown} body
 * @returns {{runnerId: string, sessionId: string} | null}
 */
function parseResultCommentIdentifiers(body) {
  const parsed = parseResultCommentMarker(body);
  if (!parsed) return null;
  return { runnerId: parsed.runnerId, sessionId: parsed.sessionId };
}

/**
 * @param {unknown} body
 * @returns {boolean}
 */
function containsStateMarker(body) {
  const text = normalizeBody(body);
  return text.includes(STATUS_COMMENT_MARKER) ||
    text.includes(HISTORY_COMMENT_MARKER) ||
    text.includes(RUNNER_ID_MARKER_PREFIX) ||
    text.includes(SESSION_DATA_MARKER_PREFIX);
}

/**
 * @param {unknown} body
 * @returns {void}
 */
function assertNoStateMarkers(body) {
  if (containsStateMarker(body)) {
    throw new Error('Result comment body contains a state marker');
  }
}

/**
 * @param {unknown} sessionDataMap
 * @returns {string}
 */
function renderSessionDataMarker(sessionDataMap) {
  return renderMarker(
    `${SESSION_DATA_MARKER_PREFIX}${JSON.stringify(normalizeSessionDataMap(sessionDataMap))}`
  );
}

/**
 * @param {unknown} body
 * @returns {Record<string, unknown>}
 */
function parseSessionData(body) {
  const rawValue = readMarkerValue(body, SESSION_DATA_MARKER_PREFIX);
  if (!rawValue) return {};

  /** @type {Record<string, unknown>} */
  let map;
  try {
    map = normalizeSessionDataMap(JSON.parse(rawValue));
  } catch (_) {
    return {};
  }

  /** @type {Record<string, unknown>} */
  const sanitized = {};
  for (const [sessionId, entry] of Object.entries(map)) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    sanitized[sessionId] = sanitizeSessionEntry(/** @type {Record<string, unknown>} */ (entry));
  }
  return sanitized;
}

/**
 * @param {unknown} body
 * @returns {string}
 */
function parseLinkedPrReference(body) {
  const text = normalizeBody(body);
  if (!text) return '';

  const changesLineMatch = text.match(/(?:Changes in|📎)\s+Pull Request #(\d+)\b/i);
  if (changesLineMatch) return changesLineMatch[1];

  const linkedPrMatch = text.match(/\[(?:Pull Request|PR)\]\(https:\/\/github\.com\/[^)\s]+\/pull\/(\d+)\)/i);
  if (linkedPrMatch) return linkedPrMatch[1];

  return '';
}

/**
 * @param {unknown} body
 * @returns {{runnerId: string, agentRunUrl: string} | null}
 */
function parseAgentRunReference(body) {
  const text = normalizeBody(body);
  if (!text) return null;

  AGENT_RUN_URL_PATTERN.lastIndex = 0;
  let match;
  while ((match = AGENT_RUN_URL_PATTERN.exec(text)) !== null) {
    const siteName = match[1];
    const runnerId = match[2];
    if (!RUNNER_ID_FORMAT.test(runnerId)) continue;
    return {
      runnerId,
      agentRunUrl: formatAgentRunUrl(siteName, runnerId),
    };
  }

  return null;
}

/**
 * Remove every HTML comment that is not one of our allowlisted markers.
 * Used on the read path: sanitize comment/PR-body text before parsing markers,
 * so a poisoned non-bot comment cannot inject runner-id/session-data values
 * even if it slipped past upstream author filtering.
 *
 * @param {unknown} body
 * @returns {string}
 */
function stripUntrustedHtmlComments(body) {
  const text = normalizeBody(body);
  if (!text) return '';
  return text.replace(/<!--([\s\S]*?)-->/g, (match, inner) => {
    return ALLOWED_MARKER_INNER.test(inner) ? match : '';
  });
}

/**
 * Remove every HTML comment unconditionally. Used on the write path when
 * embedding user-authored content (issue/PR/comment bodies) into a
 * bot-authored comment, so the bot's output never reflects user-supplied
 * markers — even ones shaped like ours, which a later parser's indexOf would
 * pick up before the bot's own legitimate marker at the end of the body.
 *
 * @param {unknown} body
 * @returns {string}
 */
function stripAllHtmlComments(body) {
  const text = normalizeBody(body);
  if (!text) return '';
  return text.replace(/<!--[\s\S]*?-->/g, '');
}

module.exports = {
  STATUS_COMMENT_MARKER,
  HISTORY_COMMENT_MARKER,
  RUNNER_ID_MARKER_PREFIX,
  SESSION_DATA_MARKER_PREFIX,
  RESULT_COMMENT_MARKER_PREFIX,
  RESULT_COMMENT_MARKER_NAME,
  RUNNER_ID_FORMAT,
  normalizeResultUsage,
  formatAgentRunUrl,
  renderRunnerIdMarker,
  parseRunnerId,
  renderResultCommentMarker,
  parseResultCommentMarker,
  parseResultCommentIdentifiers,
  renderSessionDataMarker,
  parseSessionData,
  parseLinkedPrReference,
  parseAgentRunReference,
  containsStateMarker,
  assertNoStateMarkers,
  stripUntrustedHtmlComments,
  stripAllHtmlComments,
};
