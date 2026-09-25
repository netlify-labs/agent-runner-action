// Write the run checkpoint (and the in-progress status body) to the thread's
// status comment from inside run-agent.js, so a run that loses its GitHub job
// can be found and finished later. Writes are best-effort: a failure is a
// warning, never a run failure.

const {
  STATUS_COMMENT_MARKER,
  formatAgentRunUrl,
  renderCheckpointMarker,
  renderSessionDataMarker,
} = require('./comment-markers');
const { checkpointAad, deriveKey, sealHandle } = require('./checkpoint-crypto');
const utils = require('./utils');

/**
 * @typedef {import('./comment-markers').RunCheckpoint} RunCheckpoint
 */

/**
 * @param {string | undefined} value
 * @returns {Record<string, unknown>}
 */
function parseJsonMap(value) {
  try {
    const parsed = JSON.parse(String(value || '{}'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch (_) {
    return {};
  }
}

/**
 * Build the public checkpoint fields plus the sealed handle.
 * @param {{
 *   handle: any,
 *   sdk: { serializeHandle: (h: any) => string, parseHandle: (v: any) => any },
 *   token: string,
 *   env: Record<string, string | undefined>,
 *   state: RunCheckpoint['state'],
 *   startedAt: number,
 *   model?: string,
 *   effort?: string,
 * }} input
 * @returns {{ checkpoint: RunCheckpoint, promptStripped: boolean }}
 */
function buildCheckpoint({ handle, sdk, token, env, state, startedAt, model, effort }) {
  const repo = String(env.GITHUB_REPOSITORY || '');
  const thread = String(env.ISSUE_NUMBER || '');
  const key = deriveKey({ token, repo });
  const { sealed, promptStripped } = sealHandle({
    handle,
    sdk,
    key,
    aad: checkpointAad({ repo, thread, runnerId: handle.runnerId }),
  });
  const landing = handle.landing || {};
  /** @type {any} */
  const checkpoint = {
    v: 1,
    state,
    runnerId: handle.runnerId,
    sessionId: handle.currentSessionId,
    kind: handle.kind,
    agent: handle.agent,
    mode: env.RUNNER_MODE === 'ask' ? 'ask' : 'normal',
    landing: handle.policy && handle.policy.landing === 'pr' ? 'pr' : 'none',
    deadlineAt: handle.policy.deadlineAt,
    startedAt,
    ghRunId: Number(env.GITHUB_RUN_ID || 0),
    ghRunAttempt: Number(env.GITHUB_RUN_ATTEMPT || 1),
    requester: String(env.REQUESTER || env.GITHUB_ACTOR || 'unknown'),
    kv: 1,
    handle: sealed,
  };
  if (model) checkpoint.model = model;
  if (effort) checkpoint.effort = effort;
  if (env.PR_HEAD_SHA) checkpoint.prHeadSha = env.PR_HEAD_SHA;
  if (landing.prUrl) checkpoint.prUrl = landing.prUrl;
  if (Array.isArray(landing.committedSessionIds) && landing.committedSessionIds.length > 0) {
    checkpoint.committedSessionIds = landing.committedSessionIds.slice(-50);
  }
  return { checkpoint, promptStripped };
}

/**
 * Render the in-progress status comment with runner link and state markers.
 * @param {{ checkpoint: RunCheckpoint, env: Record<string, string | undefined> }} input
 * @returns {string}
 */
function renderCheckpointStatusBody({ checkpoint, env }) {
  const siteName = env.SITE_NAME || 'unknown';
  const ghActionUrl = env.GITHUB_SERVER_URL && env.GITHUB_REPOSITORY && env.GITHUB_RUN_ID
    ? `${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}`
    : '';
  const base = utils.buildInProgressComment({
    agentRunUrl: formatAgentRunUrl(siteName, checkpoint.runnerId, checkpoint.sessionId),
    prompt: env.TRIGGER_TEXT || '',
    model: checkpoint.agent,
    modelLabel: env.MODEL_LABEL || '',
    effort: checkpoint.effort || '',
    effortLabel: env.EFFORT_LABEL || '',
    configWarnings: env.CONFIG_WARNINGS || '',
    runnerId: checkpoint.runnerId,
    ghActionUrl,
  });
  const sessionData = parseJsonMap(env.SESSION_DATA_MAP);
  sessionData[checkpoint.sessionId] = {
    .../** @type {Record<string, unknown>} */ (sessionData[checkpoint.sessionId] || {}),
    agent: checkpoint.agent,
    ...(checkpoint.model ? { model: checkpoint.model } : {}),
    ...(checkpoint.effort ? { effort: checkpoint.effort } : {}),
    mode: checkpoint.mode,
    ...(ghActionUrl ? { gh_action_url: ghActionUrl } : {}),
  };
  const markers = [renderSessionDataMarker(sessionData), renderCheckpointMarker(checkpoint)].filter(Boolean).join('\n');
  return base.replace(STATUS_COMMENT_MARKER, `${markers}\n${STATUS_COMMENT_MARKER}`);
}

/**
 * PATCH the status comment. Returns true on success; never throws.
 * @param {{ body: string, env: Record<string, string | undefined>, fetchImpl?: typeof fetch, log?: (message: string) => void }} input
 * @returns {Promise<boolean>}
 */
async function patchStatusComment({ body, env, fetchImpl = fetch, log = console.log }) {
  const commentId = String(env.STATUS_COMMENT_ID || '').trim();
  const repo = String(env.GITHUB_REPOSITORY || '');
  const token = String(env.GITHUB_TOKEN || '');
  if (!/^\d+$/.test(commentId) || !repo || !token) return false;
  const api = String(env.GITHUB_API_URL || 'https://api.github.com').replace(/\/$/, '');
  try {
    const response = await fetchImpl(`${api}/repos/${repo}/issues/comments/${commentId}`, {
      method: 'PATCH',
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'User-Agent': 'netlify-agent-runner-action',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      body: JSON.stringify({ body }),
    });
    if (!response.ok) {
      log(`Checkpoint write failed: GitHub returned HTTP ${response.status}.`);
      return false;
    }
    return true;
  } catch (error) {
    log(`Checkpoint write failed: ${/** @type {Error} */ (error).message}`);
    return false;
  }
}

/**
 * Build and write a checkpoint. Returns whether it was persisted.
 * @param {Parameters<typeof buildCheckpoint>[0] & { fetchImpl?: typeof fetch, log?: (message: string) => void }} input
 * @returns {Promise<{ written: boolean, reason?: string, promptStripped?: boolean }>}
 */
async function writeCheckpoint(input) {
  const { env, log = console.log } = input;
  if (!env.STATUS_COMMENT_ID || !env.ISSUE_NUMBER) {
    return { written: false, reason: 'no status comment (runs without an issue or PR are not recoverable)' };
  }
  let built;
  try {
    built = buildCheckpoint(input);
  } catch (error) {
    log(`Checkpoint not built: ${/** @type {Error} */ (error).message}`);
    return { written: false, reason: 'checkpoint could not be sealed' };
  }
  const body = renderCheckpointStatusBody({ checkpoint: built.checkpoint, env });
  const written = await patchStatusComment({ body, env, fetchImpl: input.fetchImpl, log });
  return written
    ? { written, promptStripped: built.promptStripped }
    : { written, reason: 'status comment update failed' };
}

module.exports = {
  buildCheckpoint,
  renderCheckpointStatusBody,
  patchStatusComment,
  writeCheckpoint,
};
