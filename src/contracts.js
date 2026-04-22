// Shared contracts for hardening modules.
// These exports establish stable object shapes and marker constants that
// parsing/rendering modules can share without duplicating ad-hoc strings.

/** @typedef {'none' | 'low' | 'medium' | 'high'} ReconciliationConfidence */
/** @typedef {'start-new-run' | 'resume-runner' | 'redirect-to-pr' | 'manual-review'} RecoveryAction */
/** @typedef {'pass' | 'warn' | 'fail'} PreflightCheckStatus */
/** @typedef {'info' | 'warning' | 'error'} FailureSeverity */
/** @typedef {'validate-env' | 'resolve-site' | 'create-agent' | 'create-session' | 'poll-agent' | 'commit' | 'create-pr' | 'comment-update' | 'unknown'} FailureStage */

/** @typedef {'missing-auth-token' | 'missing-site-id' | 'site-lookup-failed' | 'netlify-cli-missing' | 'netlify-cli-install-failed' | 'agent-unavailable' | 'model-unavailable' | 'agent-create-failed' | 'session-create-failed' | 'agent-timeout' | 'agent-failed' | 'deploy-preview-unavailable' | 'commit-to-branch-failed' | 'pull-request-create-failed' | 'github-permission-denied' | 'github-api-failed' | 'malformed-api-response' | 'unknown'} FailureCategory */

/**
 * Shared hidden markers embedded in issue/PR comments.
 * @typedef {object} CommentMarkers
 * @property {string} status
 * @property {string} history
 * @property {string} runnerIdPrefix
 * @property {string} sessionDataPrefix
 */

/**
 * Shared reconciliation output contract.
 * @typedef {object} ReconciledState
 * @property {string} runnerId
 * @property {Record<string, {screenshot?: string, gh_action_url?: string, commit_sha?: string, pr_url?: string}>} sessionDataMap
 * @property {string} linkedPrNumber
 * @property {string} agentRunUrl
 * @property {ReconciliationConfidence} confidence
 * @property {string[]} sources
 * @property {string[]} warnings
 * @property {RecoveryAction} recoveryAction
 */

/**
 * Shared failure classification contract.
 * @typedef {object} FailureClassification
 * @property {FailureCategory} category
 * @property {string} title
 * @property {string} summary
 * @property {string[]} remediation
 * @property {FailureSeverity} severity
 * @property {boolean} retryable
 * @property {boolean} userActionRequired
 * @property {FailureStage} stage
 */

/**
 * Single preflight check row.
 * @typedef {object} PreflightCheck
 * @property {string} id
 * @property {PreflightCheckStatus} status
 * @property {string} message
 */

/**
 * Shared preflight result contract.
 * @typedef {object} PreflightResult
 * @property {boolean} ok
 * @property {PreflightCheck[]} checks
 * @property {string[]} warnings
 * @property {string[]} failures
 */

/**
 * Shared step-summary renderer input contract.
 * @typedef {object} StepSummaryInput
 * @property {'success' | 'failure' | 'timeout' | 'skipped' | 'unknown'} outcome
 * @property {string} eventName
 * @property {string} contextLabel
 * @property {string} agent
 * @property {string} model
 * @property {boolean} isDryRun
 * @property {boolean} isPreflightOnly
 * @property {string} issueNumber
 * @property {string} runnerId
 * @property {string} siteName
 * @property {string} dashboardUrl
 * @property {string} deployUrl
 * @property {string} pullRequestUrl
 * @property {string} prompt
 * @property {FailureClassification | null} failure
 * @property {PreflightResult | null} preflight
 */

/**
 * Shared scenario harness trace contract.
 * @typedef {object} ScenarioTrace
 * @property {string} scenario
 * @property {Record<string, string>} outputs
 * @property {string[]} logs
 * @property {string[]} comments
 * @property {Record<string, unknown>} state
 * @property {string} summary
 * @property {FailureClassification[]} failures
 * @property {string[]} warnings
 */

const COMMENT_MARKERS = Object.freeze({
  status: '<!-- netlify-agent-run-status -->',
  history: '<!-- netlify-agent-run-history -->',
  runnerIdPrefix: '<!-- netlify-agent-runner-id:',
  sessionDataPrefix: '<!-- netlify-agent-session-data:',
});

/** @type {readonly FailureCategory[]} */
const FAILURE_CATEGORIES = Object.freeze([
  'missing-auth-token',
  'missing-site-id',
  'site-lookup-failed',
  'netlify-cli-missing',
  'netlify-cli-install-failed',
  'agent-unavailable',
  'model-unavailable',
  'agent-create-failed',
  'session-create-failed',
  'agent-timeout',
  'agent-failed',
  'deploy-preview-unavailable',
  'commit-to-branch-failed',
  'pull-request-create-failed',
  'github-permission-denied',
  'github-api-failed',
  'malformed-api-response',
  'unknown',
]);

/** @type {readonly FailureStage[]} */
const FAILURE_STAGES = Object.freeze([
  'validate-env',
  'resolve-site',
  'create-agent',
  'create-session',
  'poll-agent',
  'commit',
  'create-pr',
  'comment-update',
  'unknown',
]);

/** @type {readonly FailureSeverity[]} */
const FAILURE_SEVERITIES = Object.freeze(['info', 'warning', 'error']);

/**
 * @param {string} value
 * @returns {FailureCategory}
 */
function normalizeFailureCategory(value) {
  return FAILURE_CATEGORIES.includes(/** @type {FailureCategory} */ (value))
    ? /** @type {FailureCategory} */ (value)
    : 'unknown';
}

/**
 * @param {string} value
 * @returns {FailureStage}
 */
function normalizeFailureStage(value) {
  return FAILURE_STAGES.includes(/** @type {FailureStage} */ (value))
    ? /** @type {FailureStage} */ (value)
    : 'unknown';
}

/**
 * @param {string} value
 * @returns {FailureSeverity}
 */
function normalizeFailureSeverity(value) {
  return FAILURE_SEVERITIES.includes(/** @type {FailureSeverity} */ (value))
    ? /** @type {FailureSeverity} */ (value)
    : 'error';
}

/**
 * @param {Partial<ReconciledState>} [overrides]
 * @returns {ReconciledState}
 */
function createReconciledState(overrides = {}) {
  return {
    runnerId: '',
    sessionDataMap: {},
    linkedPrNumber: '',
    agentRunUrl: '',
    confidence: 'none',
    sources: [],
    warnings: [],
    recoveryAction: 'start-new-run',
    ...overrides,
  };
}

/**
 * @param {Partial<FailureClassification>} [overrides]
 * @returns {FailureClassification}
 */
function createFailureClassification(overrides = {}) {
  return {
    category: normalizeFailureCategory(overrides.category || 'unknown'),
    title: overrides.title || 'Netlify Agent Runners run failed',
    summary: overrides.summary || 'The run failed before completion.',
    remediation: Array.isArray(overrides.remediation) ? overrides.remediation : [],
    severity: normalizeFailureSeverity(overrides.severity || 'error'),
    retryable: overrides.retryable === true,
    userActionRequired: overrides.userActionRequired !== false,
    stage: normalizeFailureStage(overrides.stage || 'unknown'),
  };
}

/**
 * @param {Partial<PreflightCheck>} [overrides]
 * @returns {PreflightCheck}
 */
function createPreflightCheck(overrides = {}) {
  const status = overrides.status;
  return {
    id: overrides.id || 'unknown-check',
    status: status === 'pass' || status === 'warn' || status === 'fail' ? status : 'fail',
    message: overrides.message || '',
  };
}

/**
 * @param {Partial<PreflightResult>} [overrides]
 * @returns {PreflightResult}
 */
function createPreflightResult(overrides = {}) {
  return {
    ok: overrides.ok === true,
    checks: Array.isArray(overrides.checks)
      ? overrides.checks.map(check => createPreflightCheck(check))
      : [],
    warnings: Array.isArray(overrides.warnings) ? overrides.warnings : [],
    failures: Array.isArray(overrides.failures) ? overrides.failures : [],
  };
}

/**
 * @param {Partial<StepSummaryInput>} [overrides]
 * @returns {StepSummaryInput}
 */
function createStepSummaryInput(overrides = {}) {
  const outcome = overrides.outcome;
  return {
    outcome: outcome === 'success' || outcome === 'failure' || outcome === 'timeout' || outcome === 'skipped'
      ? outcome
      : 'unknown',
    eventName: overrides.eventName || '',
    contextLabel: overrides.contextLabel || '',
    agent: overrides.agent || overrides.model || 'codex',
    model: overrides.agent || overrides.model || 'codex',
    isDryRun: overrides.isDryRun === true,
    isPreflightOnly: overrides.isPreflightOnly === true,
    issueNumber: overrides.issueNumber || '',
    runnerId: overrides.runnerId || '',
    siteName: overrides.siteName || '',
    dashboardUrl: overrides.dashboardUrl || '',
    deployUrl: overrides.deployUrl || '',
    pullRequestUrl: overrides.pullRequestUrl || '',
    prompt: overrides.prompt || '',
    failure: overrides.failure ? createFailureClassification(overrides.failure) : null,
    preflight: overrides.preflight ? createPreflightResult(overrides.preflight) : null,
  };
}

/**
 * @param {Partial<ScenarioTrace>} [overrides]
 * @returns {ScenarioTrace}
 */
function createScenarioTrace(overrides = {}) {
  return {
    scenario: overrides.scenario || '',
    outputs: overrides.outputs || {},
    logs: Array.isArray(overrides.logs) ? overrides.logs : [],
    comments: Array.isArray(overrides.comments) ? overrides.comments : [],
    state: overrides.state || {},
    summary: overrides.summary || '',
    failures: Array.isArray(overrides.failures)
      ? overrides.failures.map(failure => createFailureClassification(failure))
      : [],
    warnings: Array.isArray(overrides.warnings) ? overrides.warnings : [],
  };
}

module.exports = {
  COMMENT_MARKERS,
  FAILURE_CATEGORIES,
  FAILURE_SEVERITIES,
  FAILURE_STAGES,
  normalizeFailureCategory,
  normalizeFailureSeverity,
  normalizeFailureStage,
  createReconciledState,
  createFailureClassification,
  createPreflightCheck,
  createPreflightResult,
  createStepSummaryInput,
  createScenarioTrace,
};
