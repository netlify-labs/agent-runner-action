// Recovery engine: finish a run whose GitHub job died after the agent started.
// Runs only inside a job that holds the thread's concurrency group (the next
// @netlify trigger, or a dispatched recover_thread run), so it is the single
// writer for the thread's state.
//
// Order: get the handle (sealed, else rebuilt) -> pre-checks (owner alive,
// owner cancelled, thread closed, stop-pending, past deadline) -> snapshot ->
// land / report -> render result + status comments.

const fs = require('node:fs');
const path = require('node:path');
const { openHandle, deriveKey, checkpointAad } = require('./checkpoint-crypto');
const { buildResumeHandle } = require('./resume-handle');
const { findStopRequest, parseResultCommentIdentifiers } = require('./comment-markers');
const { renderResultComment } = require('./generate-result-comment');
const { renderStatusComment } = require('./generate-status-comment');

const LIVE_RUN_STATES = new Set(['queued', 'in_progress', 'waiting', 'requested', 'pending']);

/**
 * @typedef {import('./comment-markers').RunCheckpoint} RunCheckpoint
 * @typedef {'finalized' | 'stopped' | 'still-running' | 'skipped'} RecoveryOutcome
 * @typedef {{ outcome: RecoveryOutcome, reason: string, handle?: any, sessionDataMap?: Record<string, unknown> }} RecoveryResult
 */

/**
 * @param {{ sdk: any, checkpoint: RunCheckpoint, token: string, siteId: string, repoFullName: string, thread: string, log: (m: string) => void }} input
 * @returns {Promise<{ handle: any, source: 'sealed' | 'rebuilt' }>}
 */
async function resolveHandle({ sdk, checkpoint, token, siteId, repoFullName, thread, log }) {
  if (checkpoint.handle) {
    try {
      const handle = openHandle({
        sealed: checkpoint.handle,
        kv: checkpoint.kv,
        sdk,
        key: deriveKey({ token, repo: repoFullName }),
        aad: checkpointAad({ repo: repoFullName, thread, runnerId: checkpoint.runnerId }),
      });
      if (handle.runnerId !== checkpoint.runnerId || handle.currentSessionId !== checkpoint.sessionId || handle.siteId !== siteId) {
        throw Object.assign(new Error('Sealed handle does not match the checkpoint or configured site.'), { mismatch: true });
      }
      return { handle, source: 'sealed' };
    } catch (error) {
      if (/** @type {any} */ (error).mismatch) throw error;
      log(`Recovery: sealed handle unavailable (${/** @type {Error} */ (error).message}); rebuilding from the checkpoint.`);
    }
  }
  const options = { token };
  const [runner, sessions] = await Promise.all([
    sdk.transport.getRunner(checkpoint.runnerId, options),
    sdk.transport.listSessions(checkpoint.runnerId, options),
  ]);
  const handle = buildResumeHandle({
    sdk,
    runner: { ...runner, runnerId: checkpoint.runnerId },
    sessions,
    siteId,
    sessionId: checkpoint.sessionId,
    kind: checkpoint.kind,
    agent: checkpoint.agent,
    ...(checkpoint.model ? { model: checkpoint.model } : {}),
    ...(checkpoint.effort ? { effort: checkpoint.effort } : {}),
    mode: checkpoint.mode,
    landing: checkpoint.landing,
    deadlineAt: checkpoint.deadlineAt,
    ...(checkpoint.prUrl || runner.prUrl ? { prUrl: checkpoint.prUrl || runner.prUrl } : {}),
    ...(checkpoint.committedSessionIds ? { committedSessionIds: checkpoint.committedSessionIds } : {}),
  });
  return { handle, source: 'rebuilt' };
}

/**
 * Is the job that owns the checkpoint still running?
 * @param {{ github: any, repo: { owner: string, repo: string }, checkpoint: RunCheckpoint, env: Record<string, string | undefined> }} input
 * @returns {Promise<{ alive: boolean, conclusion: string }>}
 */
async function ownerState({ github, repo, checkpoint, env }) {
  const currentRunId = Number(env.GITHUB_RUN_ID || 0);
  const currentAttempt = Number(env.GITHUB_RUN_ATTEMPT || 1);
  if (checkpoint.ghRunId === currentRunId) {
    // A re-run attempt of the same workflow run: the earlier attempt is gone.
    return checkpoint.ghRunAttempt < currentAttempt
      ? { alive: false, conclusion: 'rerun' }
      : { alive: true, conclusion: '' };
  }
  try {
    const { data } = await github.rest.actions.getWorkflowRun({ ...repo, run_id: checkpoint.ghRunId });
    return { alive: LIVE_RUN_STATES.has(String(data.status)), conclusion: String(data.conclusion || '') };
  } catch (error) {
    const status = /** @type {any} */ (error).status;
    if (status === 404) return { alive: false, conclusion: 'missing' };
    // Without actions: read the owner can't be inspected. Recovery only runs
    // inside the thread's concurrency group, so no other job on this thread
    // is running; treat the owner as gone (its cancel intent is unknown).
    if (status === 403) return { alive: false, conclusion: 'unknown' };
    throw error;
  }
}

/**
 * @param {{ github: any, repo: { owner: string, repo: string }, thread: string }} input
 * @returns {Promise<{ closed: boolean, isPr: boolean, merged: boolean }>}
 */
async function threadState({ github, repo, thread }) {
  const { data } = await github.rest.issues.get({ ...repo, issue_number: Number(thread) });
  const isPr = Boolean(data.pull_request);
  let merged = false;
  if (isPr && data.state === 'closed') {
    try {
      const pr = await github.rest.pulls.get({ ...repo, pull_number: Number(thread) });
      merged = Boolean(pr.data.merged);
    } catch (_) {
      merged = false;
    }
  }
  return { closed: data.state === 'closed', isPr, merged };
}

/**
 * Has the PR head moved since the session started (a human pushed)?
 * @param {{ github: any, repo: { owner: string, repo: string }, checkpoint: RunCheckpoint }} input
 * @returns {Promise<boolean>}
 */
async function prHeadMoved({ github, repo, checkpoint }) {
  if (!checkpoint.prHeadSha || !checkpoint.prUrl) return false;
  const match = /\/pull\/(\d+)/.exec(checkpoint.prUrl);
  if (!match) return false;
  const { data } = await github.rest.pulls.get({ ...repo, pull_number: Number(match[1]) });
  return Boolean(data.head && data.head.sha && data.head.sha !== checkpoint.prHeadSha);
}

/**
 * @param {{ sdk: any, handle: any, token: string, budgetMs: number, pollIntervalMs: number }} input
 * @returns {Promise<any | null>} the RunResult, or null when the budget ran out first
 */
async function waitWithinBudget({ sdk, handle, token, budgetMs, pollIntervalMs }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(0, budgetMs));
  try {
    return await sdk.waitFor(handle, { token, signal: controller.signal, pollIntervalMs });
  } catch (error) {
    if (controller.signal.aborted) return null;
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * @param {{
 *   sdk: any,
 *   github: any,
 *   context: import('./types').ActionContext,
 *   thread: string,
 *   statusCommentId: string,
 *   checkpoint: RunCheckpoint,
 *   input: { token: string, siteId: string },
 *   budgetMs: number,
 *   env?: Record<string, string | undefined>,
 *   now?: () => number,
 *   pollIntervalMs?: number,
 *   log?: (message: string) => void,
 * }} params
 * @returns {Promise<RecoveryResult>}
 */
async function recoverRun(params) {
  const { sdk, github, context, thread, statusCommentId, checkpoint, input, budgetMs } = params;
  const env = params.env || process.env;
  const now = params.now || Date.now;
  const log = params.log || console.log;
  const repo = { owner: context.repo.owner, repo: context.repo.repo };
  const repoFullName = `${repo.owner}/${repo.repo}`;
  const requestOptions = { token: input.token };

  let resolved;
  try {
    resolved = await resolveHandle({ sdk, checkpoint, token: input.token, siteId: input.siteId, repoFullName, thread, log });
  } catch (error) {
    const kind = /** @type {any} */ (error).kind || (/** @type {any} */ (error).mismatch ? 'mismatch' : 'unavailable');
    log(`Recovery skipped: ${/** @type {Error} */ (error).message}`);
    return { outcome: 'skipped', reason: kind };
  }
  let handle = resolved.handle;
  log(`Recovery: ${resolved.source} handle for Agent Runner ${handle.runnerId}, session ${handle.currentSessionId}.`);

  const owner = await ownerState({ github, repo, checkpoint, env });
  if (owner.alive) return { outcome: 'skipped', reason: 'owner-alive' };

  const stop = async (/** @type {string} */ reason, /** @type {string} */ message) => {
    try {
      handle = await sdk.stop(handle, requestOptions);
    } catch (error) {
      // Already stopped (for example by the @netlify stop run): nothing to retry.
      const snapshot = await sdk.getSnapshot(handle, requestOptions).catch(() => null);
      if (snapshot && snapshot.kind === 'terminal') {
        await writeStatus({ state: 'stopped', outcome: 'failure', stopReason: message });
        return { outcome: /** @type {RecoveryOutcome} */ ('stopped'), reason };
      }
      log(`Recovery: stop failed (${/** @type {Error} */ (error).message}); will retry next time.`);
      await writeStatus({ state: 'stop-pending', outcome: 'failure', stopReason: `${message} Stopping the agent run didn't go through yet; it will be retried.` });
      return { outcome: /** @type {RecoveryOutcome} */ ('still-running'), reason: 'stop-failed' };
    }
    await writeStatus({ state: 'stopped', outcome: 'failure', stopReason: message });
    return { outcome: /** @type {RecoveryOutcome} */ ('stopped'), reason };
  };

  /**
   * @param {{ state: RunCheckpoint['state'], outcome: 'success' | 'failure', stopReason?: string, extraEnv?: Record<string, string> }} update
   */
  const writeStatus = async ({ state, outcome, stopReason, extraEnv = {} }) => {
    const statusEnv = { ...statusEnvBase(), AGENT_OUTCOME: outcome, ...(stopReason ? { STOP_REASON: stopReason } : {}), ...extraEnv };
    const { statusBody } = renderStatusComment({ env: statusEnv, context, checkpoint: { ...checkpoint, state }, outcome });
    await github.rest.issues.updateComment({ ...repo, comment_id: Number(statusCommentId), body: statusBody });
  };

  const statusEnvBase = () => ({
    RUNNER_TEMP: env.RUNNER_TEMP,
    AGENT_ID: handle.runnerId,
    SITE_NAME: env.SITE_NAME,
    SESSION_DATA_MAP: env.SESSION_DATA_MAP,
    GH_ACTION_URL: env.GH_ACTION_URL,
    IS_PR: env.IS_PR,
  });

  if (owner.conclusion === 'cancelled') {
    return stop('owner-cancelled', 'Stopped: the workflow was cancelled while the agent was running.');
  }
  const threadComments = await github.paginate(github.rest.issues.listComments, { ...repo, issue_number: Number(thread), per_page: 100 });
  const stopRequest = env.BOT_LOGIN ? findStopRequest(threadComments, { botLogin: env.BOT_LOGIN, runnerId: checkpoint.runnerId }) : null;
  if (stopRequest) {
    return stop('stop-requested', `Stopped by @${stopRequest.by}.`);
  }
  const threadInfo = await threadState({ github, repo, thread });
  if (threadInfo.closed) {
    return stop('thread-closed', `Stopped: this ${threadInfo.isPr ? 'pull request' : 'issue'} was ${threadInfo.merged ? 'merged' : 'closed'} before the run finished.`);
  }
  if (checkpoint.state === 'stop-pending') {
    return stop('stop-pending', 'Stopped: the workflow was cancelled while the agent was running.');
  }

  let snapshot = await sdk.getSnapshot(handle, requestOptions);
  if (snapshot.kind === 'running') {
    if (now() >= handle.policy.deadlineAt) {
      return stop('past-deadline', "Stopped: the run passed its time limit while nothing was watching it.");
    }
    log(`Recovery: run is still working; waiting up to ${Math.round(budgetMs / 1000)}s.`);
    const result = await waitWithinBudget({ sdk, handle, token: input.token, budgetMs, pollIntervalMs: params.pollIntervalMs ?? 15000 });
    if (!result) return { outcome: 'still-running', reason: 'budget-exhausted', handle };
    snapshot = { kind: 'terminal', result };
  }

  const result = snapshot.result;
  const sessions = await sdk.transport.listSessions(handle.runnerId, requestOptions);
  const { currentSessionLast, legacySession } = require('./run-agent');
  const legacy = currentSessionLast(sessions, handle.currentSessionId).map(legacySession);
  if (env.RUNNER_TEMP) {
    fs.writeFileSync(path.join(env.RUNNER_TEMP, `agent-sessions-${handle.runnerId}.json`), JSON.stringify(legacy), { encoding: 'utf8', mode: 0o600 });
  }

  /** @type {Record<string, string>} */
  const resultEnv = {};
  let note = '';
  let outcome = /** @type {'success' | 'failure'} */ (result.status === 'succeeded' ? 'success' : 'failure');
  if (result.status === 'succeeded' && result.changes === 'changed' && checkpoint.landing === 'pr') {
    if (await prHeadMoved({ github, repo, checkpoint })) {
      note = 'Not applied: the branch changed after this run started. See the agent run to apply it manually.';
    } else {
      const landed = await sdk.land(handle, requestOptions);
      handle = landed.handle;
      if (landed.landing.kind === 'prOpen' || landed.landing.kind === 'merged') {
        resultEnv.AGENT_PR_URL = landed.landing.prUrl;
      } else if (landed.landing.kind === 'failed') {
        outcome = 'failure';
        resultEnv.AGENT_ERROR = `Landing failed during recovery: ${landed.landing.failure.message}`;
      }
    }
  } else if (result.status !== 'succeeded') {
    resultEnv.AGENT_ERROR = result.status === 'failed' ? String(result.failure && result.failure.message || 'Agent run failed.') : `Agent run ${result.status}.`;
  }

  // Result comment (idempotent per session).
  const already = threadComments.some((/** @type {{ body?: string }} */ comment) => {
    const ids = parseResultCommentIdentifiers(comment.body || '');
    return ids && ids.sessionId === handle.currentSessionId;
  });
  const renderEnv = {
    ...statusEnvBase(),
    ...resultEnv,
    AGENT_RESULT: result.status === 'succeeded' ? String(result.resultText || '') : '',
    REQUESTED_AGENT: checkpoint.agent,
    ...(checkpoint.model ? { REQUESTED_MODEL_ID: checkpoint.model } : {}),
    ...(checkpoint.effort ? { REQUESTED_EFFORT: checkpoint.effort } : {}),
    REQUESTED_MODE: checkpoint.mode,
  };
  const rendered = renderResultComment({ env: renderEnv, context, outcome });
  if (!already && rendered.resultBody) {
    const lines = rendered.resultBody.split('\n');
    lines[0] = `${lines[0]} · recovered`;
    const mention = `@${checkpoint.requester}, your earlier request finished${outcome === 'success' ? '' : ' with a problem'}.`;
    const body = [lines[0], '', mention, ...(note ? ['', `> ${note}`] : []), ...lines.slice(1)].join('\n');
    await github.rest.issues.createComment({ ...repo, issue_number: Number(thread), body });
  }

  await writeStatus({ state: 'finalized', outcome, ...(resultEnv.AGENT_PR_URL ? { extraEnv: { AGENT_PR_URL: resultEnv.AGENT_PR_URL } } : {}) });
  return { outcome: 'finalized', reason: note ? 'pr-head-moved' : outcome, handle, sessionDataMap: rendered.sessionDataMap };
}

module.exports = {
  LIVE_RUN_STATES,
  recoverRun,
  resolveHandle,
  ownerState,
  threadState,
  prHeadMoved,
  waitWithinBudget,
};
