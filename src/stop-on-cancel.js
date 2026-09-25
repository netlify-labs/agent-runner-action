// "Stop agent on cancel" step (if: cancelled()). Cancelling the workflow
// means "stop this work": stop the agent run this job started and record it
// in the status comment. GitHub gives cancelled jobs only a short grace
// period and a lost runner runs nothing, so this is best-effort; recovery also
// treats an owner run that ended "cancelled" as a stop request.

const fs = require('node:fs');
const path = require('node:path');
const { createAgentRunnerSdk } = require('nax-agent-runner-sdk');
const {
  STATUS_COMMENT_MARKER,
  formatAgentRunUrl,
  parseCheckpoint,
  parseSessionData,
  renderCheckpointMarker,
  renderRunnerIdMarker,
  renderSessionDataMarker,
} = require('./comment-markers');

const HANDLE_FILE_PREFIX = 'agent-runner-sdk-handle-';
const STOP_TIMEOUT_MS = 20000;

/**
 * Newest saved handle file in RUNNER_TEMP, or null.
 * @param {string} runnerTemp
 * @returns {string | null}
 */
function newestHandleFile(runnerTemp) {
  if (!runnerTemp || !fs.existsSync(runnerTemp)) return null;
  const files = fs.readdirSync(runnerTemp)
    .filter((name) => name.startsWith(HANDLE_FILE_PREFIX) && name.endsWith('.json'))
    .map((name) => path.join(runnerTemp, name))
    .map((file) => ({ file, mtime: fs.statSync(file).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  return files.length > 0 ? files[0].file : null;
}

/**
 * @template T
 * @param {Promise<T>} promise
 * @param {number} ms
 * @returns {Promise<T>}
 */
function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`timed out after ${ms} ms`)), ms).unref()),
  ]);
}

const PR_URL_PATTERN = /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/\d+$/;

/**
 * Did this run already land before the cancel reached it? GitHub can take a
 * minute to deliver a cancel to the running step, and the agent may finish
 * and open its PR in that window. Evidence: the current session is in the
 * landing's committed sessions (saved handle, or the checkpoint written
 * right after landing).
 * @param {any} handle
 * @param {import('./comment-markers').RunCheckpoint | null} previous
 * @returns {string | null} the PR URL when it landed, else null
 */
function landedPrUrl(handle, previous) {
  const sessionId = handle && handle.currentSessionId;
  const sources = [handle && handle.landing, previous && previous.runnerId === handle.runnerId ? previous : null];
  for (const source of sources) {
    if (!source || !Array.isArray(source.committedSessionIds) || !source.committedSessionIds.includes(sessionId)) continue;
    const url = String(source.prUrl || '');
    if (PR_URL_PATTERN.test(url)) return url;
  }
  return null;
}

/**
 * @param {{ state: 'stopped' | 'stop-pending' | 'finalized', runnerId: string, sessionId: string, siteName: string, ghActionUrl: string, previousBody: string, prUrl?: string | null }} input
 * @returns {string}
 */
function renderCancelledStatus({ state, runnerId, sessionId, siteName, ghActionUrl, previousBody, prUrl = null }) {
  const agentRunUrl = formatAgentRunUrl(siteName, runnerId, sessionId);
  const headline = prUrl
    ? `The workflow was cancelled after the agent had already finished, so its changes were applied: [pull request](${prUrl}). Close the pull request (or revert the commit) if you don't want them.`
    : state === 'stopped'
      ? 'The workflow was cancelled, so the agent run was stopped.'
      : "The workflow was cancelled, but stopping the agent run didn't go through. The next `@netlify` comment here (or the recovery workflow) will retry the stop.";
  const links = [agentRunUrl ? `[Agent run](${agentRunUrl})` : '', prUrl ? `[Pull Request](${prUrl})` : '', ghActionUrl ? `[GitHub Action logs](${ghActionUrl})` : ''].filter(Boolean).join(' | ');
  const previous = parseCheckpoint(previousBody);
  const checkpoint = previous && previous.runnerId === runnerId ? { ...previous, state } : null;
  const markers = [
    renderSessionDataMarker(parseSessionData(previousBody)),
    renderRunnerIdMarker(runnerId),
    checkpoint ? renderCheckpointMarker(checkpoint) : '',
    STATUS_COMMENT_MARKER,
  ].filter(Boolean).join('\n');
  const icon = prUrl ? '⚠️' : '⏹';
  return `### Netlify Agent Run Status ${icon}\n\n${headline}\n\n${links}\n\n*Cancelled at ${new Date().toISOString()}*\n\n${markers}`;
}

/**
 * @param {{ github: any, context: { repo: { owner: string, repo: string } }, core: { info: (m: string) => void, warning: (m: string) => void }, env?: Record<string, string | undefined>, sdk?: any }} params
 * @returns {Promise<{ outcome: 'stopped' | 'stop-pending' | 'no-run' | 'landed-before-cancel' }>}
 */
async function stopOnCancel({ github, context, core, env = process.env, sdk }) {
  const handleFile = newestHandleFile(String(env.RUNNER_TEMP || ''));
  if (!handleFile) {
    core.info('Workflow cancelled; no agent run was started, nothing to stop.');
    return { outcome: 'no-run' };
  }
  const client = sdk || createAgentRunnerSdk({ token: String(env.NETLIFY_AUTH_TOKEN || '') });
  const commentId = String(env.STATUS_COMMENT_ID || '');
  const repo = { owner: context.repo.owner, repo: context.repo.repo };
  /** @type {any} */
  let handle = null;
  try {
    handle = client.parseHandle(fs.readFileSync(handleFile, 'utf8'));
  } catch (error) {
    core.warning(`Workflow cancelled, but the saved agent run couldn't be read: ${/** @type {Error} */ (error).message}`);
    return { outcome: 'stop-pending' };
  }
  // null: no status comment, or it couldn't be read (then it isn't updated).
  /** @type {string | null} */
  let previousBody = null;
  if (/^\d+$/.test(commentId)) {
    try {
      const { data } = await github.rest.issues.getComment({ ...repo, comment_id: Number(commentId) });
      previousBody = String((data && data.body) || '');
    } catch (error) {
      core.warning(`Couldn't update the status comment after cancelling: ${/** @type {Error} */ (error).message}`);
    }
  }

  const prUrl = landedPrUrl(handle, previousBody === null ? null : parseCheckpoint(previousBody));
  /** @type {'stopped' | 'stop-pending' | 'finalized'} */
  let state = 'stopped';
  if (prUrl) {
    state = 'finalized';
    core.warning(`Workflow cancelled after Agent Runner ${handle.runnerId} had already landed: ${prUrl}`);
  } else {
    try {
      await withTimeout(client.stop(handle), STOP_TIMEOUT_MS);
      core.info(`Workflow cancelled; stopped Agent Runner ${handle.runnerId}.`);
    } catch (error) {
      state = 'stop-pending';
      core.warning(`Workflow cancelled, but stopping the agent run failed: ${/** @type {Error} */ (error).message}`);
    }
  }

  if (previousBody !== null) {
    try {
      const ghActionUrl = env.GITHUB_SERVER_URL && env.GITHUB_RUN_ID
        ? `${env.GITHUB_SERVER_URL}/${context.repo.owner}/${context.repo.repo}/actions/runs/${env.GITHUB_RUN_ID}`
        : '';
      const body = renderCancelledStatus({
        state,
        runnerId: handle.runnerId,
        sessionId: handle.currentSessionId,
        siteName: env.SITE_NAME || 'unknown',
        ghActionUrl,
        previousBody,
        prUrl,
      });
      await github.rest.issues.updateComment({ ...repo, comment_id: Number(commentId), body });
    } catch (error) {
      core.warning(`Couldn't update the status comment after cancelling: ${/** @type {Error} */ (error).message}`);
    }
  }
  return { outcome: prUrl ? 'landed-before-cancel' : state === 'stop-pending' ? 'stop-pending' : 'stopped' };
}

module.exports = stopOnCancel;
module.exports.landedPrUrl = landedPrUrl;
module.exports.newestHandleFile = newestHandleFile;
module.exports.renderCancelledStatus = renderCancelledStatus;
