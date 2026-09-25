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

/**
 * @param {{ state: 'stopped' | 'stop-pending', runnerId: string, sessionId: string, siteName: string, ghActionUrl: string, previousBody: string }} input
 * @returns {string}
 */
function renderCancelledStatus({ state, runnerId, sessionId, siteName, ghActionUrl, previousBody }) {
  const agentRunUrl = formatAgentRunUrl(siteName, runnerId, sessionId);
  const headline = state === 'stopped'
    ? 'The workflow was cancelled, so the agent run was stopped.'
    : "The workflow was cancelled, but stopping the agent run didn't go through. The next `@netlify` comment here (or the recovery workflow) will retry the stop.";
  const links = [agentRunUrl ? `[Agent run](${agentRunUrl})` : '', ghActionUrl ? `[GitHub Action logs](${ghActionUrl})` : ''].filter(Boolean).join(' | ');
  const previous = parseCheckpoint(previousBody);
  const checkpoint = previous && previous.runnerId === runnerId ? { ...previous, state } : null;
  const markers = [
    renderSessionDataMarker(parseSessionData(previousBody)),
    renderRunnerIdMarker(runnerId),
    checkpoint ? renderCheckpointMarker(checkpoint) : '',
    STATUS_COMMENT_MARKER,
  ].filter(Boolean).join('\n');
  return `### Netlify Agent Run Status ⏹\n\n${headline}\n\n${links}\n\n*Cancelled at ${new Date().toISOString()}*\n\n${markers}`;
}

/**
 * @param {{ github: any, context: { repo: { owner: string, repo: string } }, core: { info: (m: string) => void, warning: (m: string) => void }, env?: Record<string, string | undefined>, sdk?: any }} params
 * @returns {Promise<{ outcome: 'stopped' | 'stop-pending' | 'no-run' }>}
 */
async function stopOnCancel({ github, context, core, env = process.env, sdk }) {
  const handleFile = newestHandleFile(String(env.RUNNER_TEMP || ''));
  if (!handleFile) {
    core.info('Workflow cancelled; no agent run was started, nothing to stop.');
    return { outcome: 'no-run' };
  }
  const client = sdk || createAgentRunnerSdk({ token: String(env.NETLIFY_AUTH_TOKEN || '') });
  let state = /** @type {'stopped' | 'stop-pending'} */ ('stopped');
  /** @type {any} */
  let handle = null;
  try {
    handle = client.parseHandle(fs.readFileSync(handleFile, 'utf8'));
    await withTimeout(client.stop(handle), STOP_TIMEOUT_MS);
    core.info(`Workflow cancelled; stopped Agent Runner ${handle.runnerId}.`);
  } catch (error) {
    state = 'stop-pending';
    core.warning(`Workflow cancelled, but stopping the agent run failed: ${/** @type {Error} */ (error).message}`);
  }
  if (!handle) return { outcome: state };

  const commentId = String(env.STATUS_COMMENT_ID || '');
  if (/^\d+$/.test(commentId)) {
    try {
      const repo = { owner: context.repo.owner, repo: context.repo.repo };
      const { data } = await github.rest.issues.getComment({ ...repo, comment_id: Number(commentId) });
      const ghActionUrl = env.GITHUB_SERVER_URL && env.GITHUB_RUN_ID
        ? `${env.GITHUB_SERVER_URL}/${context.repo.owner}/${context.repo.repo}/actions/runs/${env.GITHUB_RUN_ID}`
        : '';
      const body = renderCancelledStatus({
        state,
        runnerId: handle.runnerId,
        sessionId: handle.currentSessionId,
        siteName: env.SITE_NAME || 'unknown',
        ghActionUrl,
        previousBody: String((data && data.body) || ''),
      });
      await github.rest.issues.updateComment({ ...repo, comment_id: Number(commentId), body });
    } catch (error) {
      core.warning(`Couldn't update the status comment after cancelling: ${/** @type {Error} */ (error).message}`);
    }
  }
  return { outcome: state };
}

module.exports = stopOnCancel;
module.exports.newestHandleFile = newestHandleFile;
module.exports.renderCancelledStatus = renderCancelledStatus;
