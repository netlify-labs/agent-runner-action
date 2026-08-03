// Execute the Agent Runner lifecycle through nax-agent-runner-sdk.
//
// Historical action comments persisted only a runner ID and per-session links,
// not a full SDK handle. Follow-ups therefore reconstruct a minimal, short-
// lived compatibility handle before handing control to sdk.followUp(). New
// runs use the full handle returned by sdk.start().

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const {
  AGENT_RUNNER_SDK_HANDLE_VERSION,
  AGENT_RUNNER_SDK_VERSION,
  createAgentRunnerSdk,
  createAuthenticatedNetlifyClient,
  redactSensitiveText,
} = require('nax-agent-runner-sdk');

/** @typedef {import('nax-agent-runner-sdk').AgentRunnerSdk} AgentRunnerSdk */
/** @typedef {import('nax-agent-runner-sdk').Handle} Handle */
/** @typedef {import('nax-agent-runner-sdk').Runner} Runner */
/** @typedef {import('nax-agent-runner-sdk').Session} Session */
/** @typedef {import('nax-agent-runner-sdk').FailureClassification} FailureClassification */
/** @typedef {import('nax-agent-runner-sdk').RunResult} RunResult */
/** @typedef {import('nax-agent-runner-sdk').LandingOutcome} LandingOutcome */

const RUNNER_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const AGENT_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;
const MAX_TIMEOUT_MINUTES = 24 * 60;
const POLL_INTERVAL_MS = 15_000;
const CHECKPOINT_FILE_PREFIX = 'agent-runner-sdk-handle-';

class ReportedActionError extends Error {
  /**
   * @param {string} message
   * @param {'failure' | 'timeout'} outcome
   */
  constructor(message, outcome = 'failure') {
    super(message);
    this.name = 'ReportedActionError';
    this.outcome = outcome;
  }
}

/**
 * @typedef {object} ActionInput
 * @property {string} token
 * @property {string} siteId
 * @property {string} prompt
 * @property {string} agent
 * @property {string} branch
 * @property {string} existingRunnerId
 * @property {Record<string, unknown>} sessionDataMap
 * @property {number} deadlineMs
 * @property {boolean} dryRun
 * @property {string} runnerTemp
 */

/**
 * @param {unknown} value
 * @returns {Record<string, unknown>}
 */
function parseJsonMap(value) {
  if (typeof value !== 'string' || value.trim() === '') return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? /** @type {Record<string, unknown>} */ (parsed)
      : {};
  } catch (_) {
    return {};
  }
}

/**
 * @param {string | undefined} value
 * @param {string} name
 * @returns {string}
 */
function requiredText(value, name) {
  const resolved = String(value || '').trim();
  if (!resolved) throw new Error(`${name} is required.`);
  return resolved;
}

/**
 * @param {string | undefined} value
 * @returns {boolean}
 */
function booleanInput(value) {
  const normalized = String(value || 'false').trim().toLowerCase();
  if (normalized !== 'true' && normalized !== 'false') {
    throw new Error('IS_DRY_RUN must be true or false.');
  }
  return normalized === 'true';
}

/**
 * @param {NodeJS.ProcessEnv | Record<string, string | undefined>} env
 * @returns {ActionInput}
 */
function readActionInput(env) {
  const token = requiredText(env.NETLIFY_AUTH_TOKEN, 'NETLIFY_AUTH_TOKEN');
  const siteId = requiredText(env.NETLIFY_SITE_ID, 'NETLIFY_SITE_ID');
  const prompt = requiredText(env.TRIGGER_TEXT, 'TRIGGER_TEXT');
  const agent = requiredText(
    env.NETLIFY_AGENT || env.AGENT_MODEL || 'codex',
    'NETLIFY_AGENT',
  );
  if (!AGENT_PATTERN.test(agent)) {
    throw new Error('NETLIFY_AGENT contains unsupported characters.');
  }

  const existingRunnerId = String(env.EXISTING_RUNNER_ID || '').trim();
  if (existingRunnerId && !RUNNER_ID_PATTERN.test(existingRunnerId)) {
    throw new Error('EXISTING_RUNNER_ID is invalid.');
  }

  const timeoutMinutes = Number(env.MAX_WAIT_MINUTES || '10');
  if (
    !Number.isFinite(timeoutMinutes)
    || timeoutMinutes <= 0
    || timeoutMinutes > MAX_TIMEOUT_MINUTES
  ) {
    throw new Error(
      `MAX_WAIT_MINUTES must be greater than zero and no more than ${MAX_TIMEOUT_MINUTES}.`,
    );
  }

  const branch = String(
    env.HEAD_BRANCH || env.REPOSITORY_DEFAULT_BRANCH || '',
  ).trim();
  if (/[\u0000-\u001f\u007f]/.test(branch) || branch.length > 255) {
    throw new Error('The selected branch is invalid.');
  }

  return {
    token,
    siteId,
    prompt,
    agent,
    branch,
    existingRunnerId,
    sessionDataMap: parseJsonMap(env.SESSION_DATA_MAP),
    deadlineMs: Math.ceil(timeoutMinutes * 60_000),
    dryRun: booleanInput(env.IS_DRY_RUN),
    runnerTemp: requiredText(env.RUNNER_TEMP, 'RUNNER_TEMP'),
  };
}

/**
 * @param {string} name
 * @param {unknown} value
 * @param {string} outputFile
 * @returns {void}
 */
function appendGithubOutput(name, value, outputFile) {
  if (!/^[a-z][a-z0-9-]*$/.test(name)) {
    throw new Error(`Invalid GitHub output name: ${name}`);
  }
  const delimiter = `NAX_AGENT_RUNNER_${randomUUID().replace(/-/g, '')}`;
  fs.appendFileSync(
    outputFile,
    `${name}<<${delimiter}\n${String(value ?? '')}\n${delimiter}\n`,
    'utf8',
  );
}

/**
 * @param {string} runnerId
 * @param {string} runnerTemp
 * @returns {string}
 */
function checkpointPath(runnerId, runnerTemp) {
  if (!RUNNER_ID_PATTERN.test(runnerId)) {
    throw new Error('Cannot checkpoint an invalid runner ID.');
  }
  return path.join(runnerTemp, `${CHECKPOINT_FILE_PREFIX}${runnerId}.json`);
}

/**
 * @param {AgentRunnerSdk} sdk
 * @param {Handle} handle
 * @param {string} runnerTemp
 * @returns {void}
 */
function saveHandleCheckpoint(sdk, handle, runnerTemp) {
  const file = checkpointPath(handle.runnerId, runnerTemp);
  fs.writeFileSync(file, sdk.serializeHandle(handle), {
    encoding: 'utf8',
    mode: 0o600,
  });
}

/**
 * @param {number | undefined} value
 * @returns {string | undefined}
 */
function isoDate(value) {
  return value === undefined ? undefined : new Date(value).toISOString();
}

/**
 * Preserve the session shape consumed by the action's existing comment and
 * history renderers.
 *
 * @param {Session} session
 * @returns {Record<string, unknown>}
 */
function legacySession(session) {
  return {
    id: session.sessionId,
    agent_runner_id: session.runnerId,
    state: session.state,
    ...(session.prompt === undefined ? {} : { prompt: session.prompt }),
    ...(session.resultText === undefined ? {} : { result: session.resultText }),
    ...(session.title === undefined ? {} : { title: session.title }),
    ...(session.agent === undefined
      ? {}
      : { agent_config: { agent: session.agent } }),
    ...(session.model === undefined ? {} : { model: session.model }),
    ...(session.mode === undefined ? {} : { mode: session.mode }),
    ...(session.fileKeys === undefined
      ? {}
      : { attached_file_keys: session.fileKeys }),
    ...(isoDate(session.createdAt) === undefined
      ? {}
      : { created_at: isoDate(session.createdAt) }),
    ...(isoDate(session.updatedAt) === undefined
      ? {}
      : { updated_at: isoDate(session.updatedAt) }),
    ...(isoDate(session.doneAt) === undefined
      ? {}
      : { done_at: isoDate(session.doneAt) }),
    ...(session.currentTask === undefined
      ? {}
      : { current_task: session.currentTask }),
    ...(session.commitSha === undefined
      ? {}
      : { commit_sha: session.commitSha }),
    ...(session.deployId === undefined ? {} : { deploy_id: session.deployId }),
    ...(session.deployUrl === undefined
      ? {}
      : { deploy_url: session.deployUrl }),
    ...(session.hasResultDiff === undefined
      ? {}
      : { has_result_diff: session.hasResultDiff }),
    ...(session.hasCumulativeDiff === undefined
      ? {}
      : { has_cumulative_diff: session.hasCumulativeDiff }),
    ...(session.creditLimitExceeded === undefined
      ? {}
      : { credit_limit_exceeded: session.creditLimitExceeded }),
    ...(session.creditLimitExceededMessage === undefined
      ? {}
      : {
          credit_limit_exceeded_message:
            session.creditLimitExceededMessage,
        }),
    ...(session.usage === null ? {} : { usage: session.usage }),
  };
}

/**
 * Prefer the newest session already recorded by the action when rebuilding a
 * pre-SDK handle. A concurrent, unrelated active session must not silently
 * become the historical base merely because it is last in the API response.
 *
 * @param {Session[]} sessions
 * @param {Record<string, unknown>} sessionDataMap
 * @returns {Session | undefined}
 */
function selectLegacyCurrentSession(sessions, sessionDataMap) {
  const knownSessionIds = Object.keys(sessionDataMap).reverse();
  for (const sessionId of knownSessionIds) {
    const match = sessions.find((session) => session.sessionId === sessionId);
    if (match) return match;
  }
  return sessions[sessions.length - 1];
}

/**
 * @param {object} options
 * @param {AgentRunnerSdk} options.sdk
 * @param {ActionInput} options.input
 * @returns {Promise<Handle>}
 */
async function createLegacyHandle({ sdk, input }) {
  const requestOptions = { token: input.token };
  const [runner, sessions] = await Promise.all([
    sdk.transport.getRunner(input.existingRunnerId, requestOptions),
    sdk.transport.listSessions(input.existingRunnerId, requestOptions),
  ]);
  const current = selectLegacyCurrentSession(
    sessions,
    input.sessionDataMap,
  );
  if (!current) {
    throw new Error(
      `No session exists for Agent Runner ${input.existingRunnerId}.`,
    );
  }

  const landing = input.dryRun ? 'none' : 'pr';
  const requestId = randomUUID();
  /** @type {Handle} */
  const handle = {
    v: AGENT_RUNNER_SDK_HANDLE_VERSION,
    kind: 'run',
    runnerId: input.existingRunnerId,
    siteId: input.siteId,
    agent: input.agent || current.agent || 'codex',
    ...(runner.codeOrigin === undefined
      ? {}
      : {
          origin: {
            codeOrigin: runner.codeOrigin,
            ...(runner.branch === undefined
              ? {}
              : { branch: runner.branch }),
          },
        }),
    input: {
      siteId: input.siteId,
      prompt: 'Resume a pre-SDK agent-runner-action run.',
      agent: input.agent || current.agent || 'codex',
      ...(input.branch ? { branch: input.branch } : {}),
      land: landing,
      deadlineMs: input.deadlineMs,
      retryBudget: { capacity: 0 },
      requestId,
    },
    policy: {
      landing,
      deadlineAt: Date.now() + input.deadlineMs,
      retryBudget: { capacity: 0 },
    },
    retries: { capacity: 0 },
    currentSessionId: current.sessionId,
  };
  return sdk.parseHandle(handle);
}

/**
 * @param {Session[]} sessions
 * @param {string} currentSessionId
 * @returns {Session[]}
 */
function currentSessionLast(sessions, currentSessionId) {
  const current = sessions.find(
    (session) => session.sessionId === currentSessionId,
  );
  if (!current) return sessions;
  return [
    ...sessions.filter(
      (session) => session.sessionId !== currentSessionId,
    ),
    current,
  ];
}

/**
 * Convert SDK failures to the action's long-standing output contract while
 * retaining the SDK failure code in the sanitized message.
 *
 * @param {FailureClassification} failure
 * @param {string} stage
 * @returns {string}
 */
function actionFailureCategory(failure, stage) {
  if (stage === 'create-session') return 'session-create-failed';
  if (stage === 'commit') return 'commit-to-branch-failed';
  if (stage === 'create-pr') return 'pull-request-create-failed';
  if (failure.category === 'timeout') return 'agent-timeout';
  if (failure.category === 'cancelled') return 'agent-failed';
  if (failure.code === 'prompt-too-large') return 'prompt-too-large';
  if (failure.code === 'invalid-api-shape') return 'malformed-api-response';
  if (failure.category === 'github' && failure.status === 403) {
    return 'github-permission-denied';
  }
  if (failure.category === 'github') return 'github-api-failed';
  if (stage === 'create-agent') return 'agent-create-failed';
  return 'agent-failed';
}

/**
 * @param {unknown} error
 * @param {AgentRunnerSdk | undefined} sdk
 * @returns {FailureClassification}
 */
function classifySdkError(error, sdk) {
  if (sdk) return sdk.classifyFailure(error);
  return {
    category: 'validation',
    code: 'validation-error',
    title: 'Action input is invalid',
    message: error instanceof Error ? error.message : String(error),
    remediation: ['Correct the action inputs and run the workflow again.'],
    severity: 'error',
    retryable: false,
    userActionRequired: true,
    stage: 'validate',
  };
}

/**
 * @param {FailureClassification} failure
 * @param {ActionInput | undefined} input
 * @returns {string}
 */
function safeFailureMessage(failure, input) {
  const message = `[${failure.code}] ${failure.message}`;
  return String(redactSensitiveText(
    message,
    input ? [input.token, input.prompt] : [],
  ))
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 500);
}

/**
 * @param {RunResult} result
 * @returns {FailureClassification}
 */
function terminalFailure(result) {
  if (result.status === 'failed') return result.failure;
  if (result.status === 'timedOut') {
    return {
      category: 'timeout',
      code: 'agent-timeout',
      title: 'Agent Runner timed out',
      message: 'The Agent Runner did not finish before the action deadline.',
      remediation: ['Run the action again or increase the configured timeout.'],
      severity: 'error',
      retryable: true,
      userActionRequired: false,
      stage: 'runner',
    };
  }
  return {
    category: 'cancelled',
    code: 'agent-cancelled',
    title: 'Agent Runner was cancelled',
    message: 'The Agent Runner session was cancelled.',
    remediation: ['Start a new run if the work is still required.'],
    severity: 'info',
    retryable: false,
    userActionRequired: false,
    stage: 'session',
  };
}

/**
 * @param {LandingOutcome} landing
 * @returns {{failure: FailureClassification, stage: string} | null}
 */
function landingFailure(landing) {
  if (landing.kind === 'failed') {
    return {
      failure: landing.failure,
      stage: landing.step === 'commit' ? 'commit' : 'create-pr',
    };
  }
  if (landing.kind === 'unsupported') {
    return {
      failure: {
        category: 'platform',
        code: 'landing-unsupported',
        title: 'PR landing is unsupported',
        message: landing.reason,
        remediation: ['Use a GitHub-backed Agent Runner target that supports PR landing.'],
        severity: 'error',
        retryable: false,
        userActionRequired: true,
        stage: 'landing',
      },
      stage: 'create-pr',
    };
  }
  return null;
}

/**
 * @param {string} deployId
 * @param {string} token
 * @returns {Promise<string>}
 */
async function fetchDeployScreenshot(deployId, token) {
  if (!deployId) return '';
  try {
    const client = createAuthenticatedNetlifyClient({ token });
    const payload = await client.request(
      'GET',
      `/deploys/${encodeURIComponent(deployId)}`,
      { token, operation: 'get-deploy', retry: true },
    );
    if (!payload || typeof payload !== 'object') return '';
    const screenshot = /** @type {Record<string, unknown>} */ (payload)
      .screenshot_url;
    return typeof screenshot === 'string' ? screenshot : '';
  } catch (_) {
    return '';
  }
}

/**
 * @typedef {object} RunAgentOptions
 * @property {NodeJS.ProcessEnv | Record<string, string | undefined>} [env]
 * @property {AgentRunnerSdk} [sdk]
 * @property {(name: string, value: unknown) => void} [setOutput]
 * @property {(message: string) => void} [log]
 * @property {(deployId: string, token: string) => Promise<string>} [getScreenshot]
 */

/**
 * @param {RunAgentOptions} [options]
 * @returns {Promise<{handle: Handle, result: RunResult, landing?: LandingOutcome}>}
 */
async function runAgentAction(options = {}) {
  const env = options.env || process.env;
  const outputFile = String(env.GITHUB_OUTPUT || '');
  const setOutput = options.setOutput || ((name, value) => {
    if (!outputFile) throw new Error('GITHUB_OUTPUT is required.');
    appendGithubOutput(name, value, outputFile);
  });
  const log = options.log || console.log;
  const getScreenshot = options.getScreenshot || fetchDeployScreenshot;

  for (const [name, value] of Object.entries({
    'failure-stage': '',
    'failure-category': '',
    'agent-error': '',
    'agent-id': '',
    outcome: '',
    'agent-result': '',
    'agent-pr-url': '',
    'agent-deploy-url': '',
    'agent-screenshot-url': '',
    'agent-title': '',
    'agent-sessions': '[]',
    'agent-has-diff': 'false',
    'agent-pr-branch': '',
    'agent-commit-sha': '',
  })) {
    setOutput(name, value);
  }

  /** @type {ActionInput | undefined} */
  let input;
  /** @type {AgentRunnerSdk | undefined} */
  let sdk = options.sdk;
  let stage = 'validate-env';

  try {
    input = readActionInput(env);
    const resolvedInput = input;
    sdk = sdk || createAgentRunnerSdk({
      token: resolvedInput.token,
      githubToken: String(env.GITHUB_TOKEN || ''),
      defaultDeadlineMs: resolvedInput.deadlineMs,
      pollIntervalMs: POLL_INTERVAL_MS,
      retryAttempts: 3,
      onLandingCheckpoint: (handle) => {
        saveHandleCheckpoint(
          /** @type {AgentRunnerSdk} */ (sdk),
          handle,
          resolvedInput.runnerTemp,
        );
      },
    });

    const requestOptions = { token: input.token };
    const landing = input.dryRun ? 'none' : 'pr';
    /** @type {Handle} */
    let handle;
    if (input.existingRunnerId) {
      stage = 'create-session';
      log(`Starting SDK follow-up for Agent Runner ${input.existingRunnerId}.`);
      const base = await createLegacyHandle({ sdk, input });
      handle = await sdk.followUp(
        base,
        { prompt: input.prompt, agent: input.agent },
        requestOptions,
      );
    } else {
      stage = 'create-agent';
      log(`Starting Agent Runner with nax-agent-runner-sdk@${AGENT_RUNNER_SDK_VERSION}.`);
      handle = await sdk.start({
        siteId: input.siteId,
        prompt: input.prompt,
        agent: input.agent,
        ...(input.branch ? { branch: input.branch } : {}),
        land: landing,
        deadlineMs: input.deadlineMs,
        retryBudget: { capacity: 0 },
      }, requestOptions);
    }
    setOutput('agent-id', handle.runnerId);
    saveHandleCheckpoint(sdk, handle, input.runnerTemp);
    log(`Agent Runner ${handle.runnerId} started.`);

    stage = 'poll-agent';
    const result = await sdk.waitFor(handle, {
      ...requestOptions,
      pollIntervalMs: POLL_INTERVAL_MS,
      onProgress: (event) => {
        if (event.kind === 'stateChanged') {
          const safeState = event.state.replace(/[^A-Za-z0-9._-]/g, '');
          log(`Agent Runner state: ${safeState || 'unknown'}.`);
        }
      },
    });
    if (result.status !== 'succeeded') {
      const failure = terminalFailure(result);
      const failureStage = 'poll-agent';
      setOutput(
        'failure-category',
        actionFailureCategory(failure, failureStage),
      );
      setOutput('failure-stage', failureStage);
      setOutput('agent-error', safeFailureMessage(failure, input));
      setOutput('outcome', result.status === 'timedOut' ? 'timeout' : 'failure');
      throw new ReportedActionError(
        safeFailureMessage(failure, input),
        result.status === 'timedOut' ? 'timeout' : 'failure',
      );
    }

    /** @type {LandingOutcome | undefined} */
    let landingOutcome;
    const [preLandingRunner, preLandingSession] = await Promise.all([
      sdk.transport.getRunner(handle.runnerId, requestOptions),
      sdk.transport.getSession(
        handle.runnerId,
        handle.currentSessionId,
        requestOptions,
      ),
    ]);
    const hasChanges = result.changes === 'changed';
    if (!input.dryRun && hasChanges) {
      stage = preLandingRunner.prUrl && handle.kind === 'session'
        ? 'commit'
        : 'create-pr';
      const landed = await sdk.land(handle, requestOptions);
      handle = landed.handle;
      landingOutcome = landed.landing;
      saveHandleCheckpoint(sdk, handle, input.runnerTemp);
      const failedLanding = landingFailure(landed.landing);
      if (failedLanding) {
        setOutput(
          'failure-category',
          actionFailureCategory(
            failedLanding.failure,
            failedLanding.stage,
          ),
        );
        setOutput('failure-stage', failedLanding.stage);
        setOutput(
          'agent-error',
          safeFailureMessage(failedLanding.failure, input),
        );
        setOutput('outcome', 'failure');
        throw new ReportedActionError(
          safeFailureMessage(failedLanding.failure, input),
        );
      }
      if (landed.landing.kind !== 'prOpen') {
        /** @type {FailureClassification} */
        const failure = {
          category: 'platform',
          code: 'pr-landing-required',
          title: 'PR landing was not completed',
          message: `Expected PR-only landing but received ${landed.landing.kind}.`,
          remediation: ['Inspect the runner landing state and retry without enabling automatic merge.'],
          severity: 'error',
          retryable: false,
          userActionRequired: true,
          stage: 'landing',
        };
        setOutput('failure-category', 'pull-request-create-failed');
        setOutput('failure-stage', 'create-pr');
        setOutput('agent-error', safeFailureMessage(failure, input));
        setOutput('outcome', 'failure');
        throw new ReportedActionError(safeFailureMessage(failure, input));
      }
    }

    const [runner, currentSession, listedSessions] = await Promise.all([
      sdk.transport.getRunner(handle.runnerId, requestOptions),
      sdk.transport.getSession(
        handle.runnerId,
        handle.currentSessionId,
        requestOptions,
      ),
      sdk.transport.listSessions(handle.runnerId, requestOptions),
    ]);
    const sessions = currentSessionLast(
      listedSessions,
      handle.currentSessionId,
    ).map(legacySession);
    const sessionsJson = JSON.stringify(sessions);
    fs.writeFileSync(
      path.join(
        input.runnerTemp,
        `agent-sessions-${handle.runnerId}.json`,
      ),
      sessionsJson,
      { encoding: 'utf8', mode: 0o600 },
    );

    const prUrl = landingOutcome && landingOutcome.kind === 'prOpen'
      ? landingOutcome.prUrl
      : runner.prUrl || preLandingRunner.prUrl || result.links.prUrl || '';
    const screenshot = await getScreenshot(
      currentSession.deployId || preLandingSession.deployId || '',
      input.token,
    );

    setOutput('outcome', 'success');
    setOutput('agent-result', result.resultText);
    setOutput(
      'agent-deploy-url',
      currentSession.deployUrl || result.deployUrl || '',
    );
    setOutput('agent-screenshot-url', screenshot);
    setOutput('agent-pr-url', input.dryRun ? '' : prUrl);
    setOutput('agent-pr-branch', input.dryRun ? '' : runner.prBranch || '');
    setOutput('agent-commit-sha', currentSession.commitSha || '');
    setOutput('agent-title', currentSession.title || '');
    setOutput('agent-sessions', sessionsJson);
    setOutput('agent-has-diff', hasChanges ? 'true' : 'false');
    log(`Agent Runner ${handle.runnerId} completed successfully.`);

    return {
      handle,
      result,
      ...(landingOutcome === undefined ? {} : { landing: landingOutcome }),
    };
  } catch (error) {
    if (error instanceof ReportedActionError) throw error;
    const failure = classifySdkError(error, sdk);
    const mappedStage = stage === 'validate-env' ? 'validate-env' : stage;
    const category = stage === 'validate-env'
      ? (
          /NETLIFY_AUTH_TOKEN/.test(failure.message)
            ? 'missing-auth-token'
            : /NETLIFY_SITE_ID/.test(failure.message)
              ? 'missing-site-id'
              : 'agent-create-failed'
        )
      : actionFailureCategory(failure, mappedStage);
    const safeMessage = safeFailureMessage(failure, input);
    setOutput('failure-category', category);
    setOutput('failure-stage', mappedStage);
    setOutput('agent-error', safeMessage);
    setOutput('outcome', failure.category === 'timeout' ? 'timeout' : 'failure');
    throw new ReportedActionError(
      safeMessage,
      failure.category === 'timeout' ? 'timeout' : 'failure',
    );
  }
}

async function main() {
  try {
    await runAgentAction();
  } catch (error) {
    const message = error instanceof Error
      ? error.message
      : 'Agent Runner execution failed.';
    console.error(`Agent Runner action failed: ${message}`);
    process.exitCode = 1;
  }
}

if (require.main === module) {
  void main();
}

module.exports = {
  CHECKPOINT_FILE_PREFIX,
  ReportedActionError,
  actionFailureCategory,
  appendGithubOutput,
  createLegacyHandle,
  currentSessionLast,
  legacySession,
  readActionInput,
  runAgentAction,
  selectLegacyCurrentSession,
};
