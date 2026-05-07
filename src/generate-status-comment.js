// Generate the short mutable status comment body.
// Sets outputs: status-body, comment-body, session-data-map

const utils = require('./utils');
const { classifyFailure } = require('./failure-taxonomy');
const {
  STATUS_COMMENT_MARKER,
  renderRunnerIdMarker,
  renderSessionDataMarker,
  stripAllHtmlComments,
} = require('./comment-markers');
const { assembleStatusBody } = require('./comment-truncation');
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
  const agentRunUrl = agentId ? `https://app.netlify.com/projects/${siteName}/agent-runs/${agentId}` : '';
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
 * @param {{
 *   env?: Record<string, string | undefined>,
 *   context: import('./types').ActionContext,
 *   outcome?: 'success' | 'failure',
 * }} params
 * @returns {{statusBody: string, sessionDataMap: Record<string, unknown>}}
 */
function renderStatusComment({ env = process.env, context, outcome }) {
  const agentId = env.AGENT_ID || env.RUNNER_ID || '';
  const sessions = readSessions(agentId, env.RUNNER_TEMP);
  const latestSession = sessions.length > 0 ? sessions[sessions.length - 1] : null;
  const sessionDataMap = buildSessionDataMap(env, sessions);
  const siteName = env.SITE_NAME || context.repo.repo;
  const agentRunUrl = agentId ? `https://app.netlify.com/projects/${siteName}/agent-runs/${agentId}` : '';
  const isFailure = outcome ? outcome === 'failure' : Boolean(env.AGENT_ERROR);
  const isDryRun = env.IS_DRY_RUN === 'true';
  const model = (latestSession && latestSession.agent_config && latestSession.agent_config.agent) || env.AGENT_MODEL || 'codex';
  const runNumber = sessions.length || 1;
  const timestamp = new Date().toISOString();
  const title = cleanInline((latestSession && latestSession.title) || env.AGENT_TITLE || '');
  const resultUrl = env.RESULT_COMMENT_URL ||
    (env.RESULT_COMMENT_ID ? `#issuecomment-${env.RESULT_COMMENT_ID}` : '');

  let headerText = 'Netlify Agent Run completed';
  if (isDryRun) headerText = 'Netlify Agent Run completed (preview)';
  if (isFailure) headerText = 'Netlify Agent Run failed';
  const statusIcon = isFailure ? '❌' : '✅';
  const header = agentRunUrl
    ? `### [${headerText}](${agentRunUrl}) ${statusIcon}`
    : `### ${headerText} ${statusIcon}`;
  const subtitle = `Run #${runNumber} | ${model} | ${isFailure ? 'failed' : 'completed'} at ${timestamp}`;

  const deployUrl = env.AGENT_DEPLOY_URL || (latestSession && latestSession.deploy_url) || '';
  const screenshotUrl = env.AGENT_SCREENSHOT_URL || '';
  const screenshot = screenshotUrl && deployUrl
    ? `<a href="${deployUrl}"><img src="${screenshotUrl}" alt="Preview" width="180" align="right"></a>`
    : '';

  let statusTitle = title ? `**${title}**` : '';
  if (isFailure) {
    const failure = classifyFailure({
      category: env.FAILURE_CATEGORY || env.AGENT_FAILURE_CATEGORY || '',
      stage: env.FAILURE_STAGE || env.AGENT_FAILURE_STAGE || '',
      error: env.AGENT_ERROR || '',
      statusCode: env.FAILURE_STATUS_CODE ? parseInt(env.FAILURE_STATUS_CODE, 10) : undefined,
    });
    statusTitle = `**${failure.title}**`;
  }

  const markers = [
    renderSessionDataMarker(sessionDataMap),
    agentId ? renderRunnerIdMarker(agentId) : '',
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
 * @param {{context: import('./types').ActionContext, core: import('./types').ActionCore}} params
 * @returns {Promise<void>}
 */
module.exports = async function generateStatusComment({ context, core }) {
  const rendered = renderStatusComment({ context });
  core.setOutput('status-body', rendered.statusBody);
  core.setOutput('comment-body', rendered.statusBody);
  core.setOutput('session-data-map', JSON.stringify(rendered.sessionDataMap));
};

module.exports.renderStatusComment = renderStatusComment;
module.exports.resultCommentLink = resultCommentLink;
