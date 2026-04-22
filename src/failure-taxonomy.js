// Deterministic failure classifier for Netlify Agent Runner.
// Produces stable categories and user-facing metadata that can be reused
// by comment rendering and step-summary generation.

const {
  FAILURE_CATEGORIES,
  createFailureClassification,
  normalizeFailureCategory,
  normalizeFailureStage,
} = require('./contracts');

/**
 * @typedef {object} FailureSignal
 * @property {string} [category]
 * @property {string} [stage]
 * @property {string} [outcome]
 * @property {string} [state]
 * @property {string | Error | unknown} [error]
 * @property {string | unknown} [errorMessage]
 * @property {string | unknown} [message]
 * @property {string | unknown} [stderr]
 * @property {string | unknown} [stdout]
 * @property {string | unknown} [details]
 * @property {string | unknown} [command]
  * @property {number} [statusCode]
 * @property {number} [exitCode]
 * @property {number} [timeoutSeconds]
 * @property {string | unknown} [model]
 * @property {boolean} [missingAuthToken]
 * @property {boolean} [missingSiteId]
 * @property {string} [title]
 * @property {string} [summary]
 * @property {string[]} [remediation]
 * @property {string} [severity]
 * @property {boolean} [retryable]
 * @property {boolean} [userActionRequired]
 */

/**
 * @typedef {object} FailureProfile
 * @property {string} title
 * @property {string} summary
 * @property {readonly string[]} remediation
 * @property {'info' | 'warning' | 'error'} severity
 * @property {boolean} retryable
 * @property {boolean} userActionRequired
 * @property {import('./contracts').FailureStage} stage
 */

/**
 * @param {FailureProfile} profile
 * @returns {Readonly<FailureProfile>}
 */
function freezeProfile(profile) {
  return Object.freeze({
    ...profile,
    remediation: Object.freeze([...profile.remediation]),
  });
}

const FAILURE_TAXONOMY = Object.freeze({
  'missing-auth-token': freezeProfile({
    title: 'Missing Netlify auth token',
    summary: 'The action cannot authenticate to Netlify because netlify-auth-token is missing.',
    remediation: [
      'Add the `netlify-auth-token` input to the workflow step.',
      'Store a valid token in `NETLIFY_AUTH_TOKEN` and reference it from workflow secrets.',
    ],
    severity: 'error',
    retryable: false,
    userActionRequired: true,
    stage: 'validate-env',
  }),
  'missing-site-id': freezeProfile({
    title: 'Missing Netlify site ID',
    summary: 'The action cannot resolve the target site because netlify-site-id is missing.',
    remediation: [
      'Add the `netlify-site-id` input to the workflow step.',
      'Set `NETLIFY_SITE_ID` to your site ID from Netlify Site configuration.',
    ],
    severity: 'error',
    retryable: false,
    userActionRequired: true,
    stage: 'validate-env',
  }),
  'site-lookup-failed': freezeProfile({
    title: 'Netlify site lookup failed',
    summary: 'The action could not load site metadata from the Netlify API.',
    remediation: [
      'Verify `NETLIFY_SITE_ID` points to an existing site in your account/team.',
      'Retry in case of a transient Netlify API issue.',
    ],
    severity: 'error',
    retryable: true,
    userActionRequired: true,
    stage: 'resolve-site',
  }),
  'netlify-cli-missing': freezeProfile({
    title: 'Netlify CLI is unavailable',
    summary: 'The workflow attempted to run Netlify CLI commands, but the executable was not found.',
    remediation: [
      'Keep the `Setup Bun`, cache, and Netlify CLI install steps enabled.',
      'Ensure `$HOME/.bun/bin` is available on PATH before Netlify commands run.',
    ],
    severity: 'error',
    retryable: true,
    userActionRequired: true,
    stage: 'create-agent',
  }),
  'netlify-cli-install-failed': freezeProfile({
    title: 'Failed to install Netlify CLI',
    summary: 'The workflow could not install the pinned Netlify CLI version.',
    remediation: [
      'Confirm outbound network/package registry access from the runner.',
      'Retry the workflow in case of a transient install failure.',
    ],
    severity: 'error',
    retryable: true,
    userActionRequired: false,
    stage: 'validate-env',
  }),
  'model-unavailable': freezeProfile({
    title: 'Requested model is unavailable',
    summary: 'Netlify reported that the selected model is not currently available.',
    remediation: [
      'Retry with a different model (`claude`, `codex`, or `gemini`).',
      'Retry later if the provider outage is temporary.',
    ],
    severity: 'error',
    retryable: true,
    userActionRequired: false,
    stage: 'create-agent',
  }),
  'agent-create-failed': freezeProfile({
    title: 'Failed to create Netlify Agent run',
    summary: 'The initial Netlify agent runner creation request did not succeed.',
    remediation: [
      'Check the Netlify API error details in workflow logs.',
      'Retry the run after confirming site and auth configuration.',
    ],
    severity: 'error',
    retryable: true,
    userActionRequired: false,
    stage: 'create-agent',
  }),
  'session-create-failed': freezeProfile({
    title: 'Failed to create follow-up session',
    summary: 'A follow-up prompt could not be attached to the existing Netlify agent runner.',
    remediation: [
      'Retry the prompt to create a new follow-up session.',
      'If repeated, start a fresh run instead of reusing the old runner ID.',
    ],
    severity: 'error',
    retryable: true,
    userActionRequired: false,
    stage: 'create-session',
  }),
  'agent-timeout': freezeProfile({
    title: 'Agent timed out before completion',
    summary: 'The Netlify agent did not reach a terminal state within timeout-minutes.',
    remediation: [
      'Try a smaller or more focused prompt.',
      'Increase `timeout-minutes` if longer runs are expected.',
    ],
    severity: 'error',
    retryable: true,
    userActionRequired: false,
    stage: 'poll-agent',
  }),
  'agent-failed': freezeProfile({
    title: 'Agent run failed',
    summary: 'The Netlify agent reached a failed/error/cancelled terminal state.',
    remediation: [
      'Inspect the agent error details and logs for the failing operation.',
      'Retry with adjusted prompt scope after addressing root cause.',
    ],
    severity: 'error',
    retryable: true,
    userActionRequired: false,
    stage: 'poll-agent',
  }),
  'deploy-preview-unavailable': freezeProfile({
    title: 'Deploy preview unavailable',
    summary: 'The run completed, but the deploy preview URL was unavailable or invalid.',
    remediation: [
      'Open Netlify deploy logs to check deploy status and screenshot generation.',
      'Retry if the preview endpoint was transiently unavailable.',
    ],
    severity: 'warning',
    retryable: true,
    userActionRequired: false,
    stage: 'poll-agent',
  }),
  'commit-to-branch-failed': freezeProfile({
    title: 'Failed to commit changes to branch',
    summary: 'Netlify could not create or finalize the merge commit on the target branch.',
    remediation: [
      'Check branch protections and repository write permissions.',
      'Retry after resolving merge or permission constraints.',
    ],
    severity: 'error',
    retryable: true,
    userActionRequired: true,
    stage: 'commit',
  }),
  'pull-request-create-failed': freezeProfile({
    title: 'Failed to create pull request',
    summary: 'The agent produced diffs but a pull request URL was not created.',
    remediation: [
      'Confirm repository `pull-requests: write` permission is granted.',
      'Retry and inspect PR creation API responses in workflow logs.',
    ],
    severity: 'error',
    retryable: true,
    userActionRequired: true,
    stage: 'create-pr',
  }),
  'github-permission-denied': freezeProfile({
    title: 'GitHub permission denied',
    summary: 'GitHub API access was denied for the token used by the action.',
    remediation: [
      'Grant required permissions (`contents`, `issues`, `pull-requests`) to the workflow token.',
      'Avoid running mutation steps from restricted fork contexts.',
    ],
    severity: 'error',
    retryable: false,
    userActionRequired: true,
    stage: 'unknown',
  }),
  'github-api-failed': freezeProfile({
    title: 'GitHub API request failed',
    summary: 'A GitHub API operation failed for reasons other than explicit permission denial.',
    remediation: [
      'Check workflow logs for the failing GitHub endpoint and response.',
      'Retry in case of transient GitHub API issues.',
    ],
    severity: 'error',
    retryable: true,
    userActionRequired: false,
    stage: 'unknown',
  }),
  'malformed-api-response': freezeProfile({
    title: 'Malformed API response',
    summary: 'The action received response data that could not be parsed reliably.',
    remediation: [
      'Inspect raw API output in debug logs for malformed JSON or missing fields.',
      'Retry and report persistent malformed responses to maintainers.',
    ],
    severity: 'error',
    retryable: true,
    userActionRequired: false,
    stage: 'unknown',
  }),
  unknown: freezeProfile({
    title: 'Netlify Agent Runner failed',
    summary: 'The run failed before completion and did not match a known failure category.',
    remediation: [
      'Inspect workflow logs for the first concrete error.',
      'Retry once, then escalate with logs if the issue persists.',
    ],
    severity: 'error',
    retryable: true,
    userActionRequired: false,
    stage: 'unknown',
  }),
});

for (const category of FAILURE_CATEGORIES) {
  if (!FAILURE_TAXONOMY[category]) {
    throw new Error(`Missing failure taxonomy profile for category: ${category}`);
  }
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function toText(value) {
  if (value === null || value === undefined) return '';
  if (value instanceof Error) return `${value.name}: ${value.message}`;
  if (typeof value === 'string') return value;
  if (typeof value === 'object') {
    try {
      return JSON.stringify(value);
    } catch (_) {
      return String(value);
    }
  }
  return String(value);
}

/**
 * @param {FailureSignal} signal
 * @returns {string}
 */
function collectSignalText(signal) {
  return [
    signal.error,
    signal.errorMessage,
    signal.message,
    signal.stderr,
    signal.stdout,
    signal.details,
    signal.command,
    signal.model,
    signal.state,
  ].map(toText).filter(Boolean).join('\n').toLowerCase();
}

/**
 * @param {string} text
 * @param {(string | RegExp)[]} patterns
 * @returns {boolean}
 */
function matchesAny(text, patterns) {
  return patterns.some(pattern => {
    if (pattern instanceof RegExp) return pattern.test(text);
    return text.includes(pattern);
  });
}

/**
 * @param {FailureSignal} signal
 * @returns {import('./contracts').FailureCategory}
 */
function detectFailureCategory(signal = {}) {
  const rawCategory = toText(signal.category).trim().toLowerCase();
  if (rawCategory) {
    const normalized = normalizeFailureCategory(rawCategory);
    if (normalized !== 'unknown' || rawCategory === 'unknown') {
      return normalized;
    }
  }

  const outcome = toText(signal.outcome).trim().toLowerCase();
  if (outcome === 'timeout') return 'agent-timeout';
  const state = toText(signal.state).trim().toLowerCase();
  if (state === 'timeout') return 'agent-timeout';
  if (state === 'failed' || state === 'error' || state === 'cancelled') return 'agent-failed';

  if (signal.missingAuthToken === true) return 'missing-auth-token';
  if (signal.missingSiteId === true) return 'missing-site-id';

  const text = collectSignalText(signal);
  const stage = normalizeFailureStage(toText(signal.stage).trim().toLowerCase());
  const statusCode = typeof signal.statusCode === 'number' ? signal.statusCode : NaN;
  const exitCode = typeof signal.exitCode === 'number' ? signal.exitCode : NaN;
  const timeoutSeconds = typeof signal.timeoutSeconds === 'number' ? signal.timeoutSeconds : NaN;

  if (matchesAny(text, [
    'missing netlify-auth-token',
    'missing netlify_auth_token',
    'missing netlify auth token',
    'netlify_auth_token',
    'netlify-auth-token',
  ])) {
    return 'missing-auth-token';
  }

  if (matchesAny(text, [
    'missing netlify-site-id',
    'missing netlify_site_id',
    'missing netlify site id',
    'netlify_site_id',
    'netlify-site-id',
  ])) {
    return 'missing-site-id';
  }

  if (
    matchesAny(text, [
      'resource not accessible by integration',
      'insufficient permission',
      'permission denied',
      'forbidden',
    ]) && matchesAny(text, ['github', 'gh api', 'octokit'])
  ) {
    return 'github-permission-denied';
  }

  if (
    (statusCode === 401 || statusCode === 403) &&
    matchesAny(text, ['github', 'gh api', 'octokit'])
  ) {
    return 'github-permission-denied';
  }

  if (matchesAny(text, [
    'netlify: command not found',
    'netlify command not found',
    'could not find netlify',
    'enoent',
  ]) && matchesAny(text, ['netlify', 'agents:create', 'api getsite', 'api'])) {
    return 'netlify-cli-missing';
  }

  if (exitCode === 127 && matchesAny(text, ['netlify'])) {
    return 'netlify-cli-missing';
  }

  if (matchesAny(text, [
    'install netlify cli',
    'bun install -g netlify-cli',
    'failed to install netlify cli',
  ])) {
    return 'netlify-cli-install-failed';
  }

  if (matchesAny(text, [
    /agent runner \w+ is not available/i,
    /model .*?(unavailable|not available|unsupported)/i,
  ])) {
    return 'model-unavailable';
  }

  if (stage === 'create-session' || matchesAny(text, [
    'failed to create follow-up session',
    'createagentrunnersession',
    'session created=false',
  ])) {
    return 'session-create-failed';
  }

  if (stage === 'create-agent' || matchesAny(text, [
    'failed to create agent task',
    'failed to create agent',
    'agents:create',
  ])) {
    return 'agent-create-failed';
  }

  if (
    matchesAny(text, [
    'timed out',
    'timeout',
  ]) ||
    (!Number.isNaN(timeoutSeconds) && timeoutSeconds > 0 && matchesAny(text, ['poll-agent', 'agent']))
  ) {
    return 'agent-timeout';
  }

  if (matchesAny(text, [
    'deploy preview',
    'deploy_url',
    'screenshot_url',
  ]) && matchesAny(text, ['unavailable', 'status', 'returned', 'invalid'])) {
    return 'deploy-preview-unavailable';
  }

  if (stage === 'commit' || matchesAny(text, [
    'commit error',
    'agentrunnercommittobranch',
    'merge_commit_error',
    'failed to commit',
  ])) {
    return 'commit-to-branch-failed';
  }

  if (stage === 'create-pr' || matchesAny(text, [
    'pr creation finished but no url returned',
    'failed to create pull request',
    'agentrunnerpullrequest',
  ])) {
    return 'pull-request-create-failed';
  }

  if (stage === 'resolve-site' || matchesAny(text, [
    'getsite attempt',
    'resolved site: unknown',
    'site lookup failed',
    'site not found',
    'getsite',
  ])) {
    return 'site-lookup-failed';
  }

  if (matchesAny(text, [
    'parse error',
    'invalid json',
    'unexpected token',
    'cannot parse',
    'malformed',
  ])) {
    return 'malformed-api-response';
  }

  if (matchesAny(text, [
    'github api',
    'gh api',
    'octokit',
  ]) && matchesAny(text, ['failed', 'error', 'status'])) {
    return 'github-api-failed';
  }

  if (matchesAny(text, ['agent finished with state: failed', 'agent finished with state: error', 'cancelled'])) {
    return 'agent-failed';
  }

  if (stage === 'poll-agent' && (state === 'failed' || state === 'error' || state === 'cancelled')) {
    return 'agent-failed';
  }

  return 'unknown';
}

/**
 * @param {FailureSignal} signal
 * @returns {import('./contracts').FailureClassification}
 */
function classifyFailure(signal = {}) {
  const category = detectFailureCategory(signal);
  const profile = FAILURE_TAXONOMY[category] || FAILURE_TAXONOMY.unknown;
  const remediation = Array.isArray(signal.remediation) && signal.remediation.length > 0
    ? signal.remediation
    : [...profile.remediation];
  const rawStage = toText(signal.stage).trim().toLowerCase();
  const stage = rawStage ? normalizeFailureStage(rawStage) : profile.stage;
  const rawSeverity = toText(signal.severity).trim().toLowerCase();
  /** @type {'info' | 'warning' | 'error'} */
  const severity = (
    rawSeverity === 'info' || rawSeverity === 'warning' || rawSeverity === 'error'
  ) ? rawSeverity : profile.severity;

  return createFailureClassification({
    category,
    title: toText(signal.title).trim() || profile.title,
    summary: toText(signal.summary).trim() || profile.summary,
    remediation,
    severity,
    retryable: typeof signal.retryable === 'boolean' ? signal.retryable : profile.retryable,
    userActionRequired: typeof signal.userActionRequired === 'boolean'
      ? signal.userActionRequired
      : profile.userActionRequired,
    stage,
  });
}

module.exports = {
  FAILURE_TAXONOMY,
  detectFailureCategory,
  classifyFailure,
};
