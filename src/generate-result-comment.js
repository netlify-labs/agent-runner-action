// Generate the immutable per-run result comment body.
// Sets outputs: result-body, result-marker, session-data-map

const fs = require('fs');
const utils = require('./utils');
const { classifyFailure } = require('./failure-taxonomy');
const {
  renderResultCommentMarker,
  assertNoStateMarkers,
  stripAllHtmlComments,
} = require('./comment-markers');
const { truncateResultBody } = require('./comment-truncation');

const MAX_ERROR_LENGTH = 500;
const ANSI_PATTERN = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;

/**
 * @param {string} value
 * @returns {string}
 */
function cleanProse(value) {
  return stripAllHtmlComments(value || '')
    .replace(ANSI_PATTERN, '')
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '')
    .trim();
}

/**
 * @param {string} value
 * @returns {string}
 */
function truncateErrorText(value) {
  if (value.length <= MAX_ERROR_LENGTH) return value;
  return `${value.slice(0, MAX_ERROR_LENGTH)}...`;
}

/**
 * @param {string} agentId
 * @param {string} [runnerTemp]
 * @returns {Array<Record<string, any>>}
 */
function readSessions(agentId, runnerTemp = process.env.RUNNER_TEMP || '') {
  if (!agentId || !runnerTemp) return [];
  try {
    const raw = fs.readFileSync(`${runnerTemp}/agent-sessions-${agentId}.json`, 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (_) {
    return [];
  }
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
 * @param {Record<string, string | undefined>} env
 * @param {import('./types').ActionContext} context
 * @param {Record<string, any>} latestSession
 * @param {Array<Record<string, any>>} sessions
 * @returns {string[]}
 */
function buildLinks(env, context, latestSession, sessions) {
  const repoName = env.REPOSITORY_NAME || `${context.repo.owner}/${context.repo.repo}`;
  const agentId = env.AGENT_ID || '';
  const siteName = env.SITE_NAME || context.repo.repo;
  const agentRunUrl = agentId ? `https://app.netlify.com/projects/${siteName}/agent-runs/${agentId}` : '';
  const deployUrl = env.AGENT_DEPLOY_URL || latestSession.deploy_url || '';
  const commitSha = env.AGENT_COMMIT_SHA || '';
  const prUrl = env.AGENT_PR_URL || '';
  const ghActionUrl = env.GH_ACTION_URL || '';

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
 * @returns {{resultBody: string, resultMarker: string, sessionDataMap: Record<string, unknown>}}
 */
function renderResultComment({ env = process.env, context, outcome }) {
  const agentId = env.AGENT_ID || env.RUNNER_ID || '';
  const sessions = readSessions(agentId, env.RUNNER_TEMP);
  const latestSession = sessions.length > 0 ? sessions[sessions.length - 1] : null;
  const sessionId = latestSession && latestSession.id ? String(latestSession.id) : '';
  const resultMarker = renderResultCommentMarker({ runnerId: agentId, sessionId });
  const sessionDataMap = buildSessionDataMap(env, sessions);

  if (!resultMarker || !latestSession) {
    return { resultBody: '', resultMarker: '', sessionDataMap };
  }

  const siteName = env.SITE_NAME || context.repo.repo;
  const agentRunUrl = `https://app.netlify.com/projects/${siteName}/agent-runs/${agentId}`;
  const isFailure = outcome ? outcome === 'failure' : Boolean(env.AGENT_ERROR);
  const model = (latestSession.agent_config && latestSession.agent_config.agent) || env.AGENT_MODEL || 'codex';
  const runNumber = sessions.length;
  const timestamp = new Date().toISOString();
  const rawPrompt = latestSession.prompt || env.TRIGGER_TEXT || '';
  const cleanPrompt = utils.cleanPrompt(rawPrompt);
  const sourceUrlMatch = rawPrompt.match(/◌\s+(\S+)/);
  const sourceUrl = sourceUrlMatch ? sourceUrlMatch[1] : '';
  const deployUrl = env.AGENT_DEPLOY_URL || latestSession.deploy_url || '';
  const screenshotUrl = env.AGENT_SCREENSHOT_URL || '';
  const title = cleanProse(latestSession.title || env.AGENT_TITLE || '');
  const resultSummary = cleanProse(latestSession.result || env.AGENT_RESULT || '');
  const links = buildLinks(env, context, latestSession, sessions);

  let body = `### [Run #${runNumber} | ${model} | Agent Run ${isFailure ? 'failed' : 'completed'}](${agentRunUrl}) ${isFailure ? 'FAILED' : 'OK'}\n\n`;
  if (cleanPrompt) body += utils.formatPromptBlock(cleanPrompt, sourceUrl);

  if (isFailure) {
    const failure = classifyFailure({
      category: env.FAILURE_CATEGORY || env.AGENT_FAILURE_CATEGORY || '',
      stage: env.FAILURE_STAGE || env.AGENT_FAILURE_STAGE || '',
      error: env.AGENT_ERROR || '',
      statusCode: env.FAILURE_STATUS_CODE ? parseInt(env.FAILURE_STATUS_CODE, 10) : undefined,
    });
    body += title ? `### Result: ${title}\n\n` : '### Result\n\n';
    body += `${failure.summary}\n\n`;
    body += `- **Category:** \`${failure.category}\`\n`;
    body += `- **Stage:** \`${failure.stage}\`\n`;
    body += `- **Retryable:** ${failure.retryable ? 'yes' : 'no'}\n`;
    body += `- **User action required:** ${failure.userActionRequired ? 'yes' : 'no'}\n\n`;
    if (failure.remediation.length > 0) {
      body += '**Suggested next steps:**\n';
      for (const step of failure.remediation) body += `- ${cleanProse(step)}\n`;
      body += '\n';
    }
    const errorText = truncateErrorText(cleanProse(env.AGENT_ERROR || '').replace(/```/g, "'''"));
    if (errorText) body += `**Error excerpt:**\n\n\`\`\`text\n${errorText}\n\`\`\`\n\n`;
  } else {
    body += title ? `### Result: ${title}\n\n` : '### Result\n\n';
    if (screenshotUrl && deployUrl) {
      body += `<a href="${deployUrl}"><img src="${screenshotUrl}" alt="Preview" width="250" align="right"></a>\n\n`;
    }
    if (resultSummary) body += `${resultSummary}\n\n`;
  }

  if (links.length > 0) body += `${links.join(' | ')}\n\n`;
  body += `*${isFailure ? 'Failed' : 'Completed'} at ${timestamp}*\n`;

  assertNoStateMarkers(body);
  body = truncateResultBody(body, agentRunUrl);
  assertNoStateMarkers(body);
  body += `\n\n${resultMarker}`;

  return { resultBody: body, resultMarker, sessionDataMap };
}

/**
 * @param {{context: import('./types').ActionContext, core: import('./types').ActionCore}} params
 * @returns {Promise<void>}
 */
module.exports = async function generateResultComment({ context, core }) {
  const rendered = renderResultComment({ context });
  core.setOutput('result-body', rendered.resultBody);
  core.setOutput('result-marker', rendered.resultMarker);
  core.setOutput('session-data-map', JSON.stringify(rendered.sessionDataMap));
};

module.exports.renderResultComment = renderResultComment;
module.exports.cleanProse = cleanProse;
module.exports.readSessions = readSessions;
