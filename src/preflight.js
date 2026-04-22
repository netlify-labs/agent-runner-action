// Preflight validation for setup/configuration before expensive agent work.
// The module is pure with optional injected runtime checks.

const { createPreflightCheck, createPreflightResult } = require('./contracts');
const { classifyFailure } = require('./failure-taxonomy');

const VALID_MODELS = Object.freeze(['claude', 'codex', 'gemini']);
const DEFAULT_MODEL = 'codex';

/**
 * @typedef {import('./contracts').FailureClassification} FailureClassification
 * @typedef {{
 *   netlifyAuthToken: string,
 *   netlifySiteId: string,
 *   githubToken: string,
 *   defaultAgent: string,
 *   defaultModel: string,
 *   timeoutMinutes: number,
 *   triggerText: string,
 *   issueNumber: string,
 *   eventName: string,
 *   commentsRequired: boolean,
 * }} PreflightInput
 */

/**
 * @typedef {{
 *   ok?: boolean,
 *   status?: 'pass' | 'warn' | 'fail',
 *   message?: string,
 *   warning?: string,
 *   failure?: Record<string, unknown>,
 * }} RuntimeCheckResult
 */

/**
 * @typedef {{
 *   checkNetlifyCli?: (input: PreflightInput) => Promise<RuntimeCheckResult | boolean> | RuntimeCheckResult | boolean,
 *   checkSiteResolution?: (input: PreflightInput) => Promise<RuntimeCheckResult | boolean> | RuntimeCheckResult | boolean,
 *   checkGithubRepoAccess?: (input: PreflightInput) => Promise<RuntimeCheckResult | boolean> | RuntimeCheckResult | boolean,
 *   checkCommentPermission?: (input: PreflightInput) => Promise<RuntimeCheckResult | boolean> | RuntimeCheckResult | boolean,
 * }} RuntimeChecks
 */

/**
 * @param {unknown} value
 * @returns {string}
 */
function toText(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  return String(value);
}

/**
 * @param {unknown} value
 * @returns {boolean}
 */
function toBool(value) {
  const text = toText(value).trim().toLowerCase();
  return text === 'true' || text === '1' || text === 'yes';
}

/**
 * @param {unknown} value
 * @returns {number}
 */
function toInt(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value);
  const parsed = parseInt(toText(value), 10);
  return Number.isNaN(parsed) ? 0 : parsed;
}

/**
 * @param {Record<string, unknown>} source
 * @param {string[]} keys
 * @returns {string}
 */
function pickText(source, keys) {
  for (const key of keys) {
    const value = toText(source[key]).trim();
    if (value) return value;
  }
  return '';
}

/**
 * @param {Record<string, unknown>} source
 * @returns {PreflightInput}
 */
function normalizePreflightInput(source = {}) {
  const eventName = pickText(source, ['eventName', 'EVENT_NAME', 'GITHUB_EVENT_NAME']).toLowerCase();
  const commentsRequiredRaw = source.commentsRequired !== undefined
    ? source.commentsRequired
    : source.COMMENTS_REQUIRED;

  return {
    netlifyAuthToken: pickText(source, ['netlifyAuthToken', 'NETLIFY_AUTH_TOKEN', 'netlify-auth-token']),
    netlifySiteId: pickText(source, ['netlifySiteId', 'NETLIFY_SITE_ID', 'netlify-site-id']),
    githubToken: pickText(source, ['githubToken', 'GITHUB_TOKEN', 'github-token']),
    defaultAgent: (
      pickText(source, ['defaultAgent', 'DEFAULT_AGENT', 'agent', 'AGENT', 'default-agent']).toLowerCase()
      || pickText(source, ['defaultModel', 'DEFAULT_MODEL', 'model', 'MODEL', 'default-model']).toLowerCase()
      || DEFAULT_MODEL
    ),
    defaultModel: (
      pickText(source, ['defaultAgent', 'DEFAULT_AGENT', 'agent', 'AGENT', 'default-agent']).toLowerCase()
      || pickText(source, ['defaultModel', 'DEFAULT_MODEL', 'model', 'MODEL', 'default-model']).toLowerCase()
      || DEFAULT_MODEL
    ),
    timeoutMinutes: toInt(source.timeoutMinutes ?? source.TIMEOUT_MINUTES ?? source['timeout-minutes']),
    triggerText: pickText(source, ['triggerText', 'TRIGGER_TEXT', 'prompt', 'PROMPT']),
    issueNumber: pickText(source, ['issueNumber', 'ISSUE_NUMBER', 'issue', 'ISSUE_NUM']),
    eventName,
    commentsRequired: commentsRequiredRaw === undefined
      ? eventName !== 'workflow_dispatch'
      : toBool(commentsRequiredRaw),
  };
}

/**
 * @param {import('./contracts').PreflightCheck[]} checks
 * @param {string[]} warnings
 * @param {FailureClassification[]} failureDetails
 * @param {string} id
 * @param {'pass' | 'warn' | 'fail'} status
 * @param {string} message
 * @param {Record<string, unknown> | null} failureSignal
 */
function pushCheck(checks, warnings, failureDetails, id, status, message, failureSignal) {
  checks.push(createPreflightCheck({ id, status, message }));
  if (status === 'warn') warnings.push(message);
  if (status === 'fail') {
    failureDetails.push(classifyFailure(failureSignal || { error: message, stage: 'validate-env' }));
  }
}

/**
 * @param {import('./contracts').PreflightCheck[]} checks
 * @param {string[]} warnings
 * @param {FailureClassification[]} failureDetails
 * @param {string} id
 * @param {RuntimeChecks[keyof RuntimeChecks]} runtimeCheck
 * @param {PreflightInput} input
 * @param {Record<string, unknown>} defaultFailureSignal
 */
async function runRuntimeCheck(checks, warnings, failureDetails, id, runtimeCheck, input, defaultFailureSignal) {
  if (typeof runtimeCheck !== 'function') {
    pushCheck(
      checks,
      warnings,
      failureDetails,
      id,
      'warn',
      'Skipped: no runtime check implementation provided.',
      null
    );
    return;
  }

  try {
    const raw = await runtimeCheck(input);
    const result = (raw && typeof raw === 'object')
      ? /** @type {RuntimeCheckResult} */ (raw)
      : /** @type {RuntimeCheckResult} */ ({ ok: raw !== false });
    const status = result.status || (result.ok === false ? 'fail' : 'pass');
    const message = toText(result.message).trim()
      || toText(result.warning).trim()
      || (status === 'pass' ? 'Check passed.' : 'Check failed.');

    pushCheck(
      checks,
      warnings,
      failureDetails,
      id,
      status,
      message,
      status === 'fail' ? (result.failure || { ...defaultFailureSignal, error: message }) : null
    );
  } catch (error) {
    const message = `Runtime check threw: ${toText(error) || 'unknown error'}`;
    pushCheck(
      checks,
      warnings,
      failureDetails,
      id,
      'fail',
      message,
      { ...defaultFailureSignal, error: message }
    );
  }
}

/**
 * Validate static + runtime preflight checks.
 * @param {Record<string, unknown>} source
 * @param {RuntimeChecks} [runtimeChecks]
 * @returns {Promise<import('./contracts').PreflightResult & {failureDetails: FailureClassification[]}>}
 */
async function runPreflight(source = {}, runtimeChecks = {}) {
  const input = normalizePreflightInput(source);
  /** @type {import('./contracts').PreflightCheck[]} */
  const checks = [];
  /** @type {string[]} */
  const warnings = [];
  /** @type {FailureClassification[]} */
  const failureDetails = [];

  pushCheck(
    checks,
    warnings,
    failureDetails,
    'netlify-auth-token',
    input.netlifyAuthToken ? 'pass' : 'fail',
    input.netlifyAuthToken
      ? 'Token input is present.'
      : 'Missing netlify-auth-token input.',
    input.netlifyAuthToken ? null : { category: 'missing-auth-token', stage: 'validate-env' }
  );

  pushCheck(
    checks,
    warnings,
    failureDetails,
    'netlify-site-id',
    input.netlifySiteId ? 'pass' : 'fail',
    input.netlifySiteId
      ? 'Site ID input is present.'
      : 'Missing netlify-site-id input.',
    input.netlifySiteId ? null : { category: 'missing-site-id', stage: 'validate-env' }
  );

  const validModel = VALID_MODELS.includes(input.defaultAgent);
  pushCheck(
    checks,
    warnings,
    failureDetails,
    'default-agent',
    validModel ? 'pass' : 'fail',
    validModel
      ? `Default agent is valid (${input.defaultAgent}).`
      : `Invalid default agent "${input.defaultAgent}". Expected one of: ${VALID_MODELS.join(', ')}.`,
    validModel ? null : { category: 'agent-unavailable', stage: 'validate-env', error: input.defaultAgent }
  );

  const validTimeout = Number.isInteger(input.timeoutMinutes) && input.timeoutMinutes > 0;
  pushCheck(
    checks,
    warnings,
    failureDetails,
    'timeout-minutes',
    validTimeout ? 'pass' : 'fail',
    validTimeout
      ? `Timeout is valid (${input.timeoutMinutes} minute${input.timeoutMinutes === 1 ? '' : 's'}).`
      : 'timeout-minutes must be a positive integer.',
    validTimeout ? null : { stage: 'validate-env', error: 'Invalid timeout-minutes input' }
  );

  pushCheck(
    checks,
    warnings,
    failureDetails,
    'github-token',
    input.githubToken ? 'pass' : 'fail',
    input.githubToken
      ? 'GitHub token is present.'
      : 'Missing github-token input.',
    input.githubToken ? null : { category: 'github-permission-denied', stage: 'validate-env' }
  );

  pushCheck(
    checks,
    warnings,
    failureDetails,
    'trigger-context',
    input.triggerText ? 'pass' : 'fail',
    input.triggerText
      ? 'Trigger context extracted.'
      : 'Trigger context is empty or missing.',
    input.triggerText ? null : { stage: 'validate-env', error: 'Missing trigger context' }
  );

  if (input.commentsRequired) {
    pushCheck(
      checks,
      warnings,
      failureDetails,
      'issue-number',
      input.issueNumber ? 'pass' : 'fail',
      input.issueNumber
        ? `Issue/PR number is present (#${input.issueNumber}).`
        : 'Issue/PR number is required when comments are expected.',
      input.issueNumber ? null : { stage: 'validate-env', error: 'Missing issue number for comment flow' }
    );
  } else {
    pushCheck(
      checks,
      warnings,
      failureDetails,
      'issue-number',
      'pass',
      'Issue/PR number is not required for this event context.',
      null
    );
  }

  await runRuntimeCheck(
    checks,
    warnings,
    failureDetails,
    'runtime-netlify-cli',
    runtimeChecks.checkNetlifyCli,
    input,
    { category: 'netlify-cli-missing', stage: 'validate-env' }
  );
  await runRuntimeCheck(
    checks,
    warnings,
    failureDetails,
    'runtime-netlify-site-resolution',
    runtimeChecks.checkSiteResolution,
    input,
    { category: 'site-lookup-failed', stage: 'resolve-site' }
  );
  await runRuntimeCheck(
    checks,
    warnings,
    failureDetails,
    'runtime-github-repo-access',
    runtimeChecks.checkGithubRepoAccess,
    input,
    { category: 'github-api-failed', stage: 'validate-env' }
  );
  await runRuntimeCheck(
    checks,
    warnings,
    failureDetails,
    'runtime-comment-permission',
    runtimeChecks.checkCommentPermission,
    input,
    { category: 'github-permission-denied', stage: 'comment-update' }
  );

  const result = createPreflightResult({
    ok: checks.every(check => check.status !== 'fail'),
    checks,
    warnings,
    failures: failureDetails.map(failure => failure.category),
  });

  return {
    ...result,
    failureDetails,
  };
}

module.exports = {
  VALID_MODELS,
  normalizePreflightInput,
  runPreflight,
};
