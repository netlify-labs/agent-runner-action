// Deterministic scenario harness for action decision flows.
// Uses local fixtures + mock clients and never calls live GitHub/Netlify APIs.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const checkTrigger = require('./check-trigger');
const getContext = require('./get-context');
const extractAgentId = require('./extract-agent-id');
const generateErrorComment = require('./generate-error-comment');
const generateSuccessComment = require('./generate-success-comment');
const { classifyFailure } = require('./failure-taxonomy');
const { renderStepSummary } = require('./generate-step-summary');
const { reconcileAgentState } = require('./state-reconciliation');
const { createScenarioTrace } = require('./contracts');

/**
 * @typedef {import('./contracts').FailureClassification} FailureClassification
 */

/**
 * @typedef {object} ScenarioDefinition
 * @property {string} name
 * @property {string} eventName
 * @property {string} eventFixture
 * @property {Record<string, string | unknown>} [githubFixtures]
 * @property {Record<string, string | unknown>} [netlifyFixtures]
 * @property {Record<string, string | number | boolean>} [env]
 * @property {boolean} [runExtractAgentId]
 * @property {{isPR?: string, commentId?: string, prNumber?: string}} [extractInputs]
 * @property {'auto' | 'success' | 'failure' | 'none'} [commentMode]
 * @property {'success' | 'failure' | 'timeout' | 'skipped' | 'unknown'} [outcome]
 * @property {Record<string, unknown>} [failureSignal]
 * @property {Record<string, unknown>} [preflight]
 * @property {number} [timeoutMinutes]
 * @property {Record<string, string>} [seedOutputs]
 * @property {boolean} [runContextEvenIfSkipped]
 */

/**
 * @typedef {object} RunScenarioOptions
 * @property {string} [repoRoot]
 */

/**
 * @param {unknown} value
 * @returns {string}
 */
function toText(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (value instanceof Error) return `${value.name}: ${value.message}`;
  return String(value);
}

/**
 * @template T
 * @param {T} value
 * @returns {T}
 */
function cloneJson(value) {
  return /** @type {T} */ (JSON.parse(JSON.stringify(value)));
}

/**
 * @param {string} fixturePath
 * @param {string} repoRoot
 * @returns {string}
 */
function resolveFixturePath(fixturePath, repoRoot) {
  return path.isAbsolute(fixturePath)
    ? fixturePath
    : path.join(repoRoot, fixturePath);
}

/**
 * @param {string} fixturePath
 * @param {string} repoRoot
 * @returns {unknown}
 */
function loadFixtureJson(fixturePath, repoRoot) {
  const fullPath = resolveFixturePath(fixturePath, repoRoot);
  const raw = fs.readFileSync(fullPath, 'utf8');
  return JSON.parse(raw);
}

/**
 * @param {Record<string, string | unknown> | undefined} map
 * @param {string} repoRoot
 * @returns {Record<string, unknown>}
 */
function normalizeFixtureMap(map, repoRoot) {
  /** @type {Record<string, unknown>} */
  const normalized = {};
  if (!map) return normalized;

  for (const [key, value] of Object.entries(map)) {
    normalized[key] = typeof value === 'string'
      ? loadFixtureJson(value, repoRoot)
      : value;
  }

  return normalized;
}

/**
 * @param {Record<string, string | number | boolean> | undefined} patch
 * @param {() => Promise<void>} fn
 * @returns {Promise<void>}
 */
async function withScopedEnv(patch, fn) {
  /** @type {Record<string, string | undefined>} */
  const previous = {};
  /** @type {Record<string, boolean>} */
  const hadKey = {};

  for (const [key, value] of Object.entries(patch || {})) {
    hadKey[key] = Object.prototype.hasOwnProperty.call(process.env, key);
    previous[key] = process.env[key];
    process.env[key] = String(value);
  }

  try {
    await fn();
  } finally {
    for (const key of Object.keys(patch || {})) {
      if (hadKey[key]) {
        process.env[key] = previous[key];
      } else {
        delete process.env[key];
      }
    }
  }
}

/**
 * @param {() => Promise<void>} fn
 * @returns {Promise<string[]>}
 */
async function captureConsole(fn) {
  /** @type {string[]} */
  const captured = [];

  const original = {
    log: console.log,
    warn: console.warn,
    error: console.error,
  };

  /**
   * @param {'log' | 'warn' | 'error'} level
   * @param {unknown[]} values
   */
  function collect(level, values) {
    captured.push(`[${level}] ${values.map(toText).join(' ')}`.trim());
  }

  console.log = (...values) => collect('log', values);
  console.warn = (...values) => collect('warn', values);
  console.error = (...values) => collect('error', values);

  try {
    await fn();
  } finally {
    console.log = original.log;
    console.warn = original.warn;
    console.error = original.error;
  }

  return captured;
}

/**
 * @param {string} eventName
 * @param {Record<string, unknown>} payload
 * @param {Record<string, string | number | boolean>} env
 * @returns {import('./types').ActionContext}
 */
function buildContext(eventName, payload, env) {
  const repoFullName = toText(payload.repository && /** @type {any} */ (payload.repository).full_name)
    || toText(env.GITHUB_REPOSITORY)
    || 'netlify-labs/agent-runner-action-example';
  const [owner, repo] = repoFullName.includes('/')
    ? repoFullName.split('/', 2)
    : ['netlify-labs', repoFullName];

  const actor = toText(payload.sender && /** @type {any} */ (payload.sender).login)
    || toText(payload.inputs && /** @type {any} */ (payload.inputs).actor)
    || toText(env.GITHUB_ACTOR)
    || 'fixture-user';

  return {
    eventName,
    payload: /** @type {any} */ (payload),
    repo: { owner, repo },
    actor,
  };
}

/**
 * @param {Record<string, unknown>} fixtures
 * @param {string[]} callLog
 * @param {Record<string, unknown>} fallbackPull
 * @returns {import('./types').GitHubClient}
 */
function createMockGithub(fixtures, callLog, fallbackPull) {
  /**
   * @param {string} key
   * @param {unknown} fallback
   * @returns {unknown}
   */
  function readFixture(key, fallback) {
    callLog.push(key);
    if (Object.prototype.hasOwnProperty.call(fixtures, key)) {
      return cloneJson(fixtures[key]);
    }
    return cloneJson(fallback);
  }

  /**
   * Allow fixture files to be shaped either as raw payloads or `{ data: ... }`
   * envelopes copied from API snapshots.
   * @param {unknown} value
   * @returns {unknown}
   */
  function unwrapDataEnvelope(value) {
    if (
      value &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      Object.prototype.hasOwnProperty.call(value, 'data') &&
      Object.keys(/** @type {Record<string, unknown>} */ (value)).length === 1
    ) {
      return /** @type {Record<string, unknown>} */ (value).data;
    }
    return value;
  }

  return /** @type {import('./types').GitHubClient} */ ({
    rest: {
      issues: {
        createComment: async () => ({ data: /** @type {any} */ (unwrapDataEnvelope(readFixture('issues.createComment', { id: 1, body: '' }))) }),
        getComment: async () => ({ data: /** @type {any} */ (unwrapDataEnvelope(readFixture('issues.getComment', { id: 1, body: '' }))) }),
        updateComment: async () => ({ data: /** @type {any} */ (unwrapDataEnvelope(readFixture('issues.updateComment', { id: 1, body: '' }))) }),
        addLabels: async () => ({ data: /** @type {any} */ (unwrapDataEnvelope(readFixture('issues.addLabels', []))) }),
        createLabel: async () => ({ data: /** @type {any} */ (unwrapDataEnvelope(readFixture('issues.createLabel', { id: 1, name: 'netlify-agent' }))) }),
        listEventsForTimeline: async () => ({ data: /** @type {any} */ (unwrapDataEnvelope(readFixture('issues.listEventsForTimeline', []))) }),
      },
      pulls: {
        get: async () => ({ data: /** @type {any} */ (unwrapDataEnvelope(readFixture('pulls.get', fallbackPull))) }),
      },
      repos: {
        getCollaboratorPermissionLevel: async () => ({
          data: /** @type {any} */ (unwrapDataEnvelope(readFixture('repos.getCollaboratorPermissionLevel', { permission: 'admin' }))),
        }),
      },
      reactions: {
        createForIssueComment: async () => ({ data: /** @type {any} */ (unwrapDataEnvelope(readFixture('reactions.createForIssueComment', { id: 1, content: 'rocket' }))) }),
        createForIssue: async () => ({ data: /** @type {any} */ (unwrapDataEnvelope(readFixture('reactions.createForIssue', { id: 1, content: 'rocket' }))) }),
        deleteForIssueComment: async () => ({ data: /** @type {any} */ (unwrapDataEnvelope(readFixture('reactions.deleteForIssueComment', {}))) }),
        deleteForIssue: async () => ({ data: /** @type {any} */ (unwrapDataEnvelope(readFixture('reactions.deleteForIssue', {}))) }),
      },
    },
  });
}

/**
 * @param {ScenarioDefinition} scenario
 * @param {Record<string, unknown>} netlifyFixtures
 * @param {Record<string, string>} outputs
 * @returns {Record<string, unknown> | null}
 */
function deriveFailureSignal(scenario, netlifyFixtures, outputs) {
  if (scenario.failureSignal) {
    return { ...scenario.failureSignal };
  }

  const explicitOutcome = scenario.outcome
    || toText(scenario.env && scenario.env.OUTCOME).trim().toLowerCase()
    || 'unknown';

  if (explicitOutcome === 'success' || explicitOutcome === 'skipped') {
    return null;
  }

  const show = /** @type {any} */ (
    netlifyFixtures['agent.show']
    || netlifyFixtures['netlify.agent.show']
    || netlifyFixtures['agent-show']
  );
  const create = /** @type {any} */ (
    netlifyFixtures['agent.create']
    || netlifyFixtures['netlify.agent.create']
    || netlifyFixtures['agent-create']
  );
  const site = /** @type {any} */ (
    netlifyFixtures['site.get']
    || netlifyFixtures['netlify.site.get']
    || netlifyFixtures['get-site']
  );

  return {
    outcome: explicitOutcome,
    error: toText(
      (scenario.env && scenario.env.AGENT_ERROR)
      || (show && show.error)
      || (create && create.error)
      || (site && site.error)
      || outputs['agent-error']
    ),
    statusCode: (
      (show && show.status)
      || (create && create.status)
      || (site && site.status)
    ),
  };
}

/**
 * @param {string} outcome
 * @returns {boolean}
 */
function isSuccessOutcome(outcome) {
  return outcome === 'success';
}

/**
 * @param {Record<string, string>} outputs
 * @param {import('./types').ActionContext} context
 * @returns {number | undefined}
 */
function inferIssueNumber(outputs, context) {
  const fromOutput = parseInt(outputs['issue-number'] || '', 10);
  if (!Number.isNaN(fromOutput) && fromOutput > 0) return fromOutput;

  const issue = /** @type {any} */ (context.payload.issue);
  if (issue && typeof issue.number === 'number') return issue.number;

  const pr = /** @type {any} */ (context.payload.pull_request);
  if (pr && typeof pr.number === 'number') return pr.number;

  return undefined;
}

/**
 * @param {ScenarioDefinition} scenario
 * @param {import('./types').ActionContext} context
 * @param {Record<string, string>} outputs
 * @param {FailureClassification | null} failure
 * @param {import('./contracts').ReconciledState} reconciled
 * @returns {Promise<string>}
 */
async function generateScenarioComment(scenario, context, outputs, failure, reconciled) {
  const mode = scenario.commentMode || 'auto';
  if (mode === 'none') return '';

  const outcome = toText(
    scenario.outcome
    || (scenario.env && scenario.env.OUTCOME)
    || outputs.outcome
    || 'unknown'
  ).trim().toLowerCase();

  const shouldRenderSuccess = mode === 'success' || (mode === 'auto' && isSuccessOutcome(outcome));
  const shouldRenderFailure = mode === 'failure' || (mode === 'auto' && !isSuccessOutcome(outcome));

  /** @type {Record<string, string>} */
  const commentOutputs = {};
  /** @type {import('./types').ActionCore} */
  const commentCore = {
    setOutput: (name, value) => {
      commentOutputs[name] = toText(value);
    },
    setFailed: () => {
      // no-op for deterministic harness runs
    },
  };

  const issueNumber = inferIssueNumber(outputs, context);
  process.env.IS_PR = outputs['is-pr'] || 'false';
  process.env.ISSUE_NUMBER = issueNumber ? String(issueNumber) : '';
  process.env.TRIGGER_TEXT = outputs['trigger-text'] || toText((scenario.env || {}).TRIGGER_TEXT);
  process.env.NETLIFY_AGENT = outputs.agent || outputs.model || toText((scenario.env || {}).NETLIFY_AGENT || (scenario.env || {}).AGENT_MODEL || (scenario.env || {}).DEFAULT_AGENT || (scenario.env || {}).DEFAULT_MODEL || 'codex');
  process.env.AGENT_MODEL = process.env.NETLIFY_AGENT;
  process.env.AGENT_ID = toText((scenario.env || {}).AGENT_ID) || reconciled.runnerId;
  process.env.SITE_NAME = toText((scenario.env || {}).SITE_NAME) || 'agent-runner-action-example';
  process.env.IS_DRY_RUN = outputs['is-dry-run'] || toText((scenario.env || {}).DRY_RUN || 'false');
  process.env.GH_ACTION_URL = toText((scenario.env || {}).GH_ACTION_URL) || 'https://github.com/netlify-labs/agent-runner-action-example/actions/runs/1';
  process.env.REPOSITORY_NAME = toText((scenario.env || {}).REPOSITORY_NAME) || `${context.repo.owner}/${context.repo.repo}`;
  process.env.AGENT_ERROR = toText((scenario.env || {}).AGENT_ERROR) || (failure ? failure.summary : '');

  if (shouldRenderSuccess) {
    await generateSuccessComment({ context, core: commentCore });
  } else if (shouldRenderFailure) {
    await generateErrorComment({ core: commentCore });
  }

  if (commentOutputs['session-data-map']) {
    outputs['session-data-map'] = commentOutputs['session-data-map'];
  }

  return commentOutputs['comment-body'] || '';
}

/**
 * Execute one deterministic scenario from fixture payloads.
 * @param {ScenarioDefinition} scenario
 * @param {RunScenarioOptions} [options]
 * @returns {Promise<import('./contracts').ScenarioTrace>}
 */
async function runScenario(scenario, options = {}) {
  const repoRoot = options.repoRoot || path.join(__dirname, '..');
  const trace = createScenarioTrace({ scenario: scenario.name });

  const payload = /** @type {Record<string, unknown>} */ (loadFixtureJson(scenario.eventFixture, repoRoot));
  const githubFixtures = normalizeFixtureMap(scenario.githubFixtures, repoRoot);
  const netlifyFixtures = normalizeFixtureMap(scenario.netlifyFixtures, repoRoot);

  const envPatch = {
    DEFAULT_AGENT: 'codex',
    DEFAULT_MODEL: 'codex',
    DRY_RUN: 'false',
    RUNNER_TEMP: os.tmpdir(),
    TZ: 'America/Los_Angeles',
    ...(scenario.env || {}),
  };

  const context = buildContext(scenario.eventName, payload, envPatch);

  /** @type {Record<string, string>} */
  const outputs = { ...(scenario.seedOutputs || {}) };
  /** @type {import('./types').ActionCore} */
  const core = {
    setOutput: (name, value) => {
      outputs[name] = toText(value);
    },
    setFailed: message => {
      trace.warnings.push(`core.setFailed: ${toText(message)}`);
    },
  };

  /** @type {string[]} */
  const githubCalls = [];
  const fallbackPull = /** @type {Record<string, unknown>} */ ((payload.pull_request && typeof payload.pull_request === 'object')
    ? payload.pull_request
    : {
      number: payload.issue && /** @type {any} */ (payload.issue).number || 0,
      head: { ref: 'fixture/head', sha: 'fixture-sha' },
      base: { ref: 'main' },
      body: '',
    });
  const github = createMockGithub(githubFixtures, githubCalls, fallbackPull);

  let reconciled = reconcileAgentState();
  /** @type {FailureClassification | null} */
  let failure = null;

  await withScopedEnv(envPatch, async () => {
    const logs = await captureConsole(async () => {
      await checkTrigger({ github, context, core });

      if (outputs['should-run'] === 'true' || scenario.runContextEvenIfSkipped === true) {
        await getContext({ github, context, core });
      }

      if (scenario.runExtractAgentId === true) {
        const extractInputs = {
          isPR: toText((scenario.extractInputs || {}).isPR) || outputs['is-pr'] || 'false',
          commentId: toText((scenario.extractInputs || {}).commentId)
            || (Object.prototype.hasOwnProperty.call(githubFixtures, 'issues.getComment') ? '1' : ''),
          prNumber: toText((scenario.extractInputs || {}).prNumber)
            || outputs['pr-number']
            || outputs['issue-number']
            || '',
        };
        await extractAgentId({ github, context, core, inputs: extractInputs });
      }

      const statusCommentBody = toText(
        /** @type {any} */ (githubFixtures['issues.getComment'] || {}).data?.body
      );
      const prBody = toText(
        /** @type {any} */ (githubFixtures['pulls.get'] || {}).data?.body
      );

      reconciled = reconcileAgentState({
        isPr: outputs['is-pr'] === 'true',
        statusCommentBody,
        prBody,
        contextOutputs: outputs,
        siteName: toText((scenario.env || {}).SITE_NAME) || 'agent-runner-action-example',
        existingRunnerIdOutput: outputs['agent-runner-id'] || '',
        existingSessionDataOutput: outputs['session-data-map'] || '',
      });

      for (const warning of reconciled.warnings) {
        trace.warnings.push(warning);
      }

      const failureSignal = deriveFailureSignal(scenario, netlifyFixtures, outputs);
      if (failureSignal) {
        failure = classifyFailure(failureSignal);
        trace.failures.push(failure);
      }

      const outcome = toText(
        scenario.outcome
        || (scenario.env && scenario.env.OUTCOME)
        || outputs.outcome
        || 'unknown'
      ).trim().toLowerCase();

      /** @type {Record<string, unknown>} */
      const summaryInput = {
        outcome,
        eventName: context.eventName,
        isPr: outputs['is-pr'] || toText(payload.pull_request ? 'true' : 'false'),
        issueNumber: outputs['issue-number'] || toText((payload.issue && /** @type {any} */ (payload.issue).number) || ''),
        agent: outputs.agent || outputs.model || toText((scenario.env || {}).DEFAULT_AGENT || (scenario.env || {}).DEFAULT_MODEL || 'codex'),
        model: outputs.model || outputs.agent || toText((scenario.env || {}).DEFAULT_MODEL || (scenario.env || {}).DEFAULT_AGENT || 'codex'),
        runnerId: reconciled.runnerId || toText((scenario.env || {}).AGENT_ID),
        siteName: toText((scenario.env || {}).SITE_NAME),
        dashboardUrl: reconciled.agentRunUrl,
        deployUrl: toText((scenario.env || {}).AGENT_DEPLOY_URL),
        pullRequestUrl: toText((scenario.env || {}).AGENT_PR_URL),
        prompt: outputs['trigger-text'] || toText((scenario.env || {}).TRIGGER_TEXT),
        isDryRun: outputs['is-dry-run'] || toText((scenario.env || {}).DRY_RUN || 'false'),
        isPreflightOnly: toText((scenario.env || {}).IS_PREFLIGHT_ONLY || 'false'),
        timeoutMinutes: scenario.timeoutMinutes || (scenario.env && scenario.env.TIMEOUT_MINUTES),
      };

      if (failure) summaryInput.failure = failure;
      if (scenario.preflight) summaryInput.preflight = scenario.preflight;

      trace.summary = renderStepSummary(summaryInput);

      const commentBody = await generateScenarioComment(
        scenario,
        context,
        outputs,
        failure,
        reconciled
      );
      if (commentBody) {
        trace.comments.push(commentBody);
      }
    });

    trace.logs = logs;
  });

  trace.outputs = outputs;
  trace.state = {
    eventFixture: scenario.eventFixture,
    githubFixtureKeys: Object.keys(githubFixtures),
    netlifyFixtureKeys: Object.keys(netlifyFixtures),
    githubCalls,
    reconciled,
  };

  return trace;
}

module.exports = {
  loadFixtureJson,
  resolveFixturePath,
  runScenario,
};
