// Generate the short mutable status comment body.
// Sets outputs: status-body, comment-body, session-data-map

const utils = require('./utils');
const { classifyFailure } = require('./failure-taxonomy');
const {
  STATUS_COMMENT_MARKER,
  formatAgentRunUrl,
  renderRunnerIdMarker,
  renderSessionDataMarker,
  renderCheckpointMarker,
  parseCheckpoint,
  stripAllHtmlComments,
} = require('./comment-markers');
const { assembleStatusBody } = require('./comment-truncation');
const { readScopeResult, renderScopeStatusLine } = require('./scope-guard');
const { readSessions } = require('./generate-result-comment');

/**
 * @param {string} value
 * @returns {string}
 */
function cleanInline(value) {
  return stripAllHtmlComments(value || '').replace(/\s+/g, ' ').trim();
}

/**
 * @param {string} value
 * @returns {Record<string, unknown>}
 */
function parseJsonMap(value) {
  try {
    const parsed = JSON.parse(value || '{}');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch (_) {
    return {};
  }
}

/**
 * @param {Record<string, string | undefined>} env
 * @param {Array<Record<string, any>>} sessions
 * @returns {Record<string, unknown>}
 */
function buildSessionDataMap(env, sessions) {
  const sessionDataMap = parseJsonMap(env.SESSION_DATA_MAP || '{}');
  const latestSession = sessions.length > 0 ? sessions[sessions.length - 1] : null;
  if (!latestSession || !latestSession.id) return sessionDataMap;

  const entry = Object.assign(
    {},
    /** @type {Record<string, unknown>} */ (sessionDataMap[latestSession.id] || {})
  );
  if (env.AGENT_SCREENSHOT_URL) entry.screenshot = env.AGENT_SCREENSHOT_URL;
  if (env.GH_ACTION_URL) entry.gh_action_url = env.GH_ACTION_URL;
  if (env.AGENT_COMMIT_SHA) entry.commit_sha = env.AGENT_COMMIT_SHA;
  if (env.AGENT_PR_URL) entry.pr_url = env.AGENT_PR_URL;
  if (env.REQUESTED_AGENT) entry.agent = env.REQUESTED_AGENT;
  if (env.REQUESTED_MODEL_ID) entry.model = env.REQUESTED_MODEL_ID;
  if (env.REQUESTED_EFFORT) entry.effort = env.REQUESTED_EFFORT;
  if (env.REQUESTED_MODE) entry.mode = env.REQUESTED_MODE;
  sessionDataMap[latestSession.id] = entry;
  return sessionDataMap;
}

/**
 * @param {string} url
 * @returns {string}
 */
function resultCommentLink(url) {
  if (!url) return '';
  return `[Read full result](${url})`;
}

/**
 * @param {Record<string, string | undefined>} env
 * @param {import('./types').ActionContext} context
 * @param {Record<string, any> | null} latestSession
 * @returns {string[]}
 */
function buildLinks(env, context, latestSession) {
  const repoName = env.REPOSITORY_NAME || `${context.repo.owner}/${context.repo.repo}`;
  const agentId = env.AGENT_ID || env.RUNNER_ID || '';
  const siteName = env.SITE_NAME || context.repo.repo;
  const sessionId = latestSession && latestSession.id ? String(latestSession.id) : '';
  const agentRunUrl = formatAgentRunUrl(siteName, agentId, sessionId);
  const deployUrl = env.AGENT_DEPLOY_URL || (latestSession && latestSession.deploy_url) || '';
  const ghActionUrl = env.GH_ACTION_URL || '';
  const commitSha = env.AGENT_COMMIT_SHA || '';
  const prUrl = env.AGENT_PR_URL || '';

  const links = [];
  if (deployUrl) links.push(`[Open Preview](${deployUrl})`);
  if (agentRunUrl) links.push(`[Agent run](${agentRunUrl})`);
  if (commitSha && prUrl) {
    const prNum = prUrl.match(/\/pull\/(\d+)/);
    if (prNum) links.push(`[Code Changes](https://github.com/${repoName}/pull/${prNum[1]}/commits/${commitSha})`);
  } else if (commitSha) {
    links.push(`[Code Changes](https://github.com/${repoName}/commit/${commitSha})`);
  }
  if (ghActionUrl) links.push(`[Action logs](${ghActionUrl})`);
  return links;
}

/**
 * A run failed if any signal says so. An empty agent outcome alone is not a
 * success: the agent step may have crashed before reporting anything.
 * @param {Record<string, string | undefined>} env
 * @returns {boolean}
 */
function inferFailure(env) {
  const agentOutcome = String(env.AGENT_OUTCOME || '').trim().toLowerCase();
  return Boolean(env.AGENT_ERROR)
    || Boolean(env.FAILURE_CATEGORY || env.AGENT_FAILURE_CATEGORY)
    || agentOutcome === 'failure'
    || agentOutcome === 'timeout'
    || String(env.AGENT_STEP_OUTCOME || '').trim().toLowerCase() === 'failure';
}

/**
 * @param {{
 *   env?: Record<string, string | undefined>,
 *   context: import('./types').ActionContext,
 *   outcome?: 'success' | 'failure',
 *   checkpoint?: import('./comment-markers').RunCheckpoint | null,
 * }} params
 * @returns {{statusBody: string, sessionDataMap: Record<string, unknown>}}
 */
function renderStatusComment({ env = process.env, context, outcome, checkpoint = null }) {
  const agentId = env.AGENT_ID || env.RUNNER_ID || '';
  const sessions = readSessions(agentId, env.RUNNER_TEMP);
  const latestSession = sessions.length > 0 ? sessions[sessions.length - 1] : null;
  const sessionDataMap = buildSessionDataMap(env, sessions);
  const siteName = env.SITE_NAME || context.repo.repo;
  const sessionId = latestSession && latestSession.id ? String(latestSession.id) : '';
  const agentRunUrl = formatAgentRunUrl(siteName, agentId, sessionId);
  const isFailure = outcome ? outcome === 'failure' : inferFailure(env);
  const isDryRun = env.IS_DRY_RUN === 'true';
  const config = (latestSession && latestSession.agent_config) || {};
  const requested = /** @type {Record<string, string | undefined>} */ ((latestSession && sessionDataMap[latestSession.id]) || {});
  const model = utils.describeRunConfig({
    agent: config.agent || requested.agent || env.AGENT_MODEL || 'codex',
    model: config.model || requested.model,
    effort: config.effort || requested.effort,
  });
  const runNumber = sessions.length || 1;
  const timestamp = new Date().toISOString();
  const title = cleanInline((latestSession && latestSession.title) || env.AGENT_TITLE || '');
  const resultUrl = env.RESULT_COMMENT_URL ||
    (env.RESULT_COMMENT_ID ? `#issuecomment-${env.RESULT_COMMENT_ID}` : '');

  // A run stopped on purpose (workflow cancelled, or @netlify stop) is not a
  // failure; show why it stopped instead.
  const stopped = Boolean(checkpoint && checkpoint.state === 'stopped' && env.AGENT_OUTCOME !== 'success');
  const stoppedBy = String(env.STOP_REQUESTED_BY || '').replace(/[^A-Za-z0-9-]/g, '');
  const statusIcon = stopped ? '⏹' : isFailure ? '❌' : '✅';
  const statusLine = stopped
    ? (stoppedBy ? `Stopped by @${stoppedBy}.` : 'The workflow was cancelled, so the agent run was stopped.')
    : isFailure
      ? 'Netlify Agent Run failed.'
      : isDryRun
        ? 'Netlify Agent Run completed (preview).'
        : 'Netlify Agent Run completed.';
  const header = agentRunUrl
    ? `### [Netlify Agent Run Status](${agentRunUrl}) ${statusIcon}`
    : `### Netlify Agent Run Status ${statusIcon}`;
  const subtitle = statusLine;
  const runLine = `Run #${runNumber} | ${model} | ${stopped ? 'stopped' : isFailure ? 'failed' : 'completed'} at ${timestamp}`;

  const deployUrl = utils.safeHttpUrl(env.AGENT_DEPLOY_URL || (latestSession && latestSession.deploy_url) || '');
  const screenshotUrl = utils.safeHttpUrl(env.AGENT_SCREENSHOT_URL || '');
  const screenshot = screenshotUrl && deployUrl
    ? `<a href="${utils.escapeAttr(deployUrl)}"><img src="${utils.escapeAttr(screenshotUrl)}" alt="Preview" width="180" align="right"></a>`
    : '';

  let statusTitle = title ? `${runLine}\n\n**Prompt summary:** ${utils.escapeMarkdownLinks(title)}` : runLine;
  const scope = isFailure ? null : readScopeResult(env, agentId);
  const scopeLine = scope ? renderScopeStatusLine(scope) : '';
  if (scopeLine) statusTitle = `${statusTitle}\n\n${scopeLine}`;
  if (isFailure && !stopped) {
    const failure = classifyFailure({
      category: env.FAILURE_CATEGORY || env.AGENT_FAILURE_CATEGORY || '',
      stage: env.FAILURE_STAGE || env.AGENT_FAILURE_STAGE || '',
      error: env.AGENT_ERROR || '',
      statusCode: env.FAILURE_STATUS_CODE ? parseInt(env.FAILURE_STATUS_CODE, 10) : undefined,
    });
    statusTitle = `${runLine}\n\n**Failure summary:** ${failure.title}`;
  }

  const markers = [
    renderSessionDataMarker(sessionDataMap),
    agentId ? renderRunnerIdMarker(agentId) : '',
    checkpoint ? renderCheckpointMarker(checkpoint) : '',
    STATUS_COMMENT_MARKER,
  ].filter(Boolean);

  const statusBody = assembleStatusBody({
    header,
    subtitle,
    screenshot,
    title: statusTitle,
    links: buildLinks(env, context, latestSession),
    redirectNote: env.REDIRECT_NOTE || '',
    resultCommentLink: resultCommentLink(resultUrl),
    markers,
  });

  return { statusBody, sessionDataMap };
}

/**
 * Carry the run checkpoint forward into the final status comment. Never
 * regress a terminal state: a run stopped by the cancel step or by
 * `@netlify stop` stays "stopped"; everything else becomes "finalized".
 * Checkpoints for a different runner (an older run) are left untouched.
 * @param {import('./comment-markers').RunCheckpoint | null} current
 * @param {string} runnerId
 * @returns {import('./comment-markers').RunCheckpoint | null}
 */
function mergeFinalCheckpoint(current, runnerId) {
  if (!current) return null;
  if (runnerId && current.runnerId !== runnerId) return current;
  if (current.state === 'stopped' || current.state === 'finalized') return current;
  return { ...current, state: 'finalized' };
}

/**
 * Re-read the live status comment so a checkpoint written during the run (or
 * a stop recorded by another job) is merged rather than overwritten.
 * @param {any} github
 * @param {import('./types').ActionContext} context
 * @param {string | undefined} commentId
 * @returns {Promise<import('./comment-markers').RunCheckpoint | null>}
 */
async function readLiveCheckpoint(github, context, commentId) {
  if (!github || !commentId || !/^\d+$/.test(String(commentId))) return null;
  try {
    const { data } = await github.rest.issues.getComment({ owner: context.repo.owner, repo: context.repo.repo, comment_id: Number(commentId) });
    return parseCheckpoint(data && data.body);
  } catch (_) {
    return null;
  }
}

/**
 * @param {{ github?: any, context: import('./types').ActionContext, core: import('./types').ActionCore }} params
 * @returns {Promise<void>}
 */
module.exports = async function generateStatusComment({ github, context, core }) {
  const live = await readLiveCheckpoint(github, context, process.env.STATUS_COMMENT_ID);
  const checkpoint = mergeFinalCheckpoint(live, process.env.AGENT_ID || process.env.RUNNER_ID || '');
  const rendered = renderStatusComment({ context, checkpoint });
  core.setOutput('status-body', rendered.statusBody);
  core.setOutput('comment-body', rendered.statusBody);
  core.setOutput('session-data-map', JSON.stringify(rendered.sessionDataMap));
};

module.exports.renderStatusComment = renderStatusComment;
module.exports.mergeFinalCheckpoint = mergeFinalCheckpoint;
module.exports.readLiveCheckpoint = readLiveCheckpoint;
module.exports.inferFailure = inferFailure;
module.exports.resultCommentLink = resultCommentLink;
