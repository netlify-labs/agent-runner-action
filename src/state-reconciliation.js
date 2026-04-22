// Reconcile prior agent run state from comments, PR bodies, and outputs.
// Pure module: no API calls.

/**
 * @typedef {import('./contracts').ReconciledState} ReconciledState
 */

const { createReconciledState } = require('./contracts');
const {
  RUNNER_ID_MARKER_PREFIX,
  SESSION_DATA_MARKER_PREFIX,
  parseRunnerId,
  parseSessionData,
  parseLinkedPrReference,
} = require('./comment-markers');

/**
 * @typedef {object} ReconciliationInput
 * @property {boolean} [isPr]
 * @property {unknown} [statusCommentBody]
 * @property {unknown} [prBody]
 * @property {unknown} [issueTimelineLinkedPrNumber]
 * @property {Record<string, unknown>} [contextOutputs]
 * @property {unknown} [siteName]
 * @property {unknown} [existingRunnerIdOutput]
 * @property {unknown} [existingSessionDataOutput]
 */

/**
 * @param {unknown} value
 * @returns {string}
 */
function toText(value) {
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) return '';
  return String(value);
}

/**
 * @param {unknown} value
 * @returns {Record<string, unknown>}
 */
function parseSessionDataString(value) {
  const text = toText(value).trim();
  if (!text) return {};
  try {
    const parsed = JSON.parse(text);
    if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') return {};
    return /** @type {Record<string, unknown>} */ (parsed);
  } catch (_) {
    return {};
  }
}

/**
 * @typedef {object} SessionDataEntry
 * @property {string} [screenshot]
 * @property {string} [gh_action_url]
 * @property {string} [commit_sha]
 * @property {string} [pr_url]
 */

/**
 * @param {Record<string, unknown>} value
 * @returns {Record<string, SessionDataEntry>}
 */
function normalizeSessionDataMapShape(value) {
  /** @type {Record<string, SessionDataEntry>} */
  const normalized = {};
  for (const [sessionId, rawEntry] of Object.entries(value)) {
    if (!rawEntry || typeof rawEntry !== 'object' || Array.isArray(rawEntry)) continue;
    const entry = /** @type {Record<string, unknown>} */ (rawEntry);
    /** @type {SessionDataEntry} */
    const output = {};
    if (entry.screenshot !== undefined) output.screenshot = toText(entry.screenshot);
    if (entry.gh_action_url !== undefined) output.gh_action_url = toText(entry.gh_action_url);
    if (entry.commit_sha !== undefined) output.commit_sha = toText(entry.commit_sha);
    if (entry.pr_url !== undefined) output.pr_url = toText(entry.pr_url);
    normalized[sessionId] = output;
  }
  return normalized;
}

/**
 * Read raw marker payload so malformed JSON can be surfaced as warnings.
 * @param {string} body
 * @param {string} markerPrefix
 * @returns {string}
 */
function readRawMarkerValue(body, markerPrefix) {
  if (!body) return '';
  const markerStart = body.indexOf(markerPrefix);
  if (markerStart === -1) return '';
  const valueStart = markerStart + markerPrefix.length;
  const markerEnd = body.indexOf('-->', valueStart);
  if (markerEnd !== -1) return body.slice(valueStart, markerEnd).trim();
  const lineEnd = body.indexOf('\n', valueStart);
  return (lineEnd === -1 ? body.slice(valueStart) : body.slice(valueStart, lineEnd)).trim();
}

/**
 * @param {string} body
 * @param {string[]} warnings
 * @param {string[]} sources
 * @param {string} sourceLabel
 * @returns {Record<string, unknown>}
 */
function parseSessionDataFromBody(body, warnings, sources, sourceLabel) {
  if (!body.includes(SESSION_DATA_MARKER_PREFIX)) return {};
  const parsed = parseSessionData(body);
  const raw = readRawMarkerValue(body, SESSION_DATA_MARKER_PREFIX);

  if (raw && Object.keys(parsed).length === 0 && raw !== '{}') {
    warnings.push(`${sourceLabel} has malformed netlify-agent-session-data marker`);
    return {};
  }

  if (raw) {
    sources.push(`${sourceLabel}:session-data`);
  }

  return parsed;
}

/**
 * @param {ReconciliationInput} [input]
 * @returns {ReconciledState}
 */
function reconcileAgentState(input = {}) {
  const statusCommentBody = toText(input.statusCommentBody);
  const prBody = toText(input.prBody);
  const contextOutputs = input.contextOutputs || {};
  const warnings = [];
  const sources = [];
  const isPr = input.isPr === true;

  const statusRunnerId = parseRunnerId(statusCommentBody);
  const prRunnerId = parseRunnerId(prBody);
  const existingRunnerId = toText(input.existingRunnerIdOutput).trim();
  const contextRunnerId = toText(
    contextOutputs.runnerId ||
    contextOutputs.agentRunnerId ||
    contextOutputs['agent-runner-id'] ||
    contextOutputs.AGENT_RUNNER_ID
  ).trim();

  /** @type {string} */
  let runnerId = '';
  if (statusRunnerId) {
    runnerId = statusRunnerId;
    sources.push('status-comment:runner-id');
  } else if (prRunnerId) {
    runnerId = prRunnerId;
    sources.push('pr-body:runner-id');
  } else if (existingRunnerId) {
    runnerId = existingRunnerId;
    sources.push('existing-output:runner-id');
  } else if (contextRunnerId) {
    runnerId = contextRunnerId;
    sources.push('context-output:runner-id');
  }

  if (statusRunnerId && prRunnerId && statusRunnerId !== prRunnerId) {
    warnings.push('status comment and PR body contain different runner IDs');
  }

  const statusSessionData = parseSessionDataFromBody(statusCommentBody, warnings, sources, 'status-comment');
  const prSessionData = parseSessionDataFromBody(prBody, warnings, sources, 'pr-body');
  const existingSessionData = parseSessionDataString(input.existingSessionDataOutput);
  const contextSessionData = parseSessionDataString(
    contextOutputs.sessionDataMap ||
    contextOutputs['session-data-map'] ||
    contextOutputs.SESSION_DATA_MAP
  );

  if (toText(input.existingSessionDataOutput).trim() && Object.keys(existingSessionData).length === 0) {
    warnings.push('existing session data output is malformed JSON');
  } else if (Object.keys(existingSessionData).length > 0) {
    sources.push('existing-output:session-data');
  }

  if (
    toText(
      contextOutputs.sessionDataMap ||
      contextOutputs['session-data-map'] ||
      contextOutputs.SESSION_DATA_MAP
    ).trim() &&
    Object.keys(contextSessionData).length === 0
  ) {
    warnings.push('context output session data is malformed JSON');
  } else if (Object.keys(contextSessionData).length > 0) {
    sources.push('context-output:session-data');
  }

  /** @type {Record<string, unknown>} */
  let sessionDataMap = {};
  if (Object.keys(statusSessionData).length > 0 || statusCommentBody.includes(SESSION_DATA_MARKER_PREFIX)) {
    sessionDataMap = statusSessionData;
  } else if (Object.keys(prSessionData).length > 0 || prBody.includes(SESSION_DATA_MARKER_PREFIX)) {
    sessionDataMap = prSessionData;
  } else if (Object.keys(existingSessionData).length > 0) {
    sessionDataMap = existingSessionData;
  } else if (Object.keys(contextSessionData).length > 0) {
    sessionDataMap = contextSessionData;
  }

  const statusLinkedPr = parseLinkedPrReference(statusCommentBody);
  const prBodyLinkedPr = parseLinkedPrReference(prBody);
  const timelineLinkedPr = toText(input.issueTimelineLinkedPrNumber).trim();
  const contextLinkedPr = toText(
    contextOutputs.linkedPrNumber ||
    contextOutputs['linked-pr-number'] ||
    contextOutputs.LINKED_PR_NUMBER
  ).trim();

  /** @type {string} */
  let linkedPrNumber = '';
  if (statusLinkedPr) {
    linkedPrNumber = statusLinkedPr;
    sources.push('status-comment:linked-pr');
  } else if (prBodyLinkedPr) {
    linkedPrNumber = prBodyLinkedPr;
    sources.push('pr-body:linked-pr');
  } else if (timelineLinkedPr) {
    linkedPrNumber = timelineLinkedPr;
    sources.push('issue-timeline:linked-pr');
  } else if (contextLinkedPr) {
    linkedPrNumber = contextLinkedPr;
    sources.push('context-output:linked-pr');
  }

  const siteName = toText(input.siteName).trim();
  const agentRunUrl = runnerId && siteName
    ? `https://app.netlify.com/projects/${siteName}/agent-runs/${runnerId}`
    : '';

  /** @type {'none' | 'low' | 'medium' | 'high'} */
  let confidence = 'none';
  if (sources.includes('status-comment:runner-id') || sources.includes('pr-body:runner-id')) {
    confidence = 'high';
  } else if (runnerId) {
    confidence = 'medium';
  } else if (linkedPrNumber || Object.keys(sessionDataMap).length > 0) {
    confidence = 'low';
  }

  /** @type {'start-new-run' | 'resume-runner' | 'redirect-to-pr' | 'manual-review'} */
  let recoveryAction = 'start-new-run';
  if (runnerId) {
    recoveryAction = 'resume-runner';
  } else if (!isPr && linkedPrNumber) {
    recoveryAction = 'redirect-to-pr';
  } else if (warnings.length > 0) {
    recoveryAction = 'manual-review';
  }

  return createReconciledState({
    runnerId,
    sessionDataMap: normalizeSessionDataMapShape(sessionDataMap),
    linkedPrNumber,
    agentRunUrl,
    confidence,
    sources,
    warnings,
    recoveryAction,
  });
}

module.exports = {
  reconcileAgentState,
};
