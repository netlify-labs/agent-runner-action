// Generate the success status comment body.
// Sets outputs: comment-body, session-data-map

/**
 * @typedef {import('./types').ActionContext} ActionContext
 * @typedef {import('./types').ActionCore} ActionCore
 * @typedef {import('./types').AgentSession} AgentSession
 * @typedef {import('./types').SessionDataMap} SessionDataMap
 */

const fs = require('fs');
const utils = require('./utils');

/**
 * @param {{context: ActionContext, core: ActionCore}} params
 * @returns {Promise<void>}
 */
module.exports = async function generateSuccessComment({ context, core }) {
  const isPR = process.env.IS_PR === 'true';
  const repo = context.repo.repo;
  const agentId = process.env.AGENT_ID || '';
  const agentDeployUrl = process.env.AGENT_DEPLOY_URL || '';
  const agentScreenshotUrl = process.env.AGENT_SCREENSHOT_URL || '';
  const agentPrUrl = process.env.AGENT_PR_URL || '';
  const agentPrBranch = process.env.AGENT_PR_BRANCH || '';
  const agentCommitSha = process.env.AGENT_COMMIT_SHA || '';
  const repoName = process.env.REPOSITORY_NAME || `${context.repo.owner}/${repo}`;
  const isDryRun = process.env.IS_DRY_RUN === 'true';

  let agentSessionsJson = '[]';
  try {
    agentSessionsJson = fs.readFileSync(
      `${process.env.RUNNER_TEMP}/agent-sessions-${agentId}.json`, 'utf8'
    );
  } catch (_) { /* no file */ }

  const siteName = process.env.SITE_NAME || repo;
  const triggerText = process.env.TRIGGER_TEXT || '';
  const ghActionUrl = process.env.GH_ACTION_URL || '';

  /** @type {AgentSession[]} */
  let sessions = [];
  try { sessions = JSON.parse(agentSessionsJson); } catch (_) { /* invalid json */ }
  const latestSession = sessions.length > 0 ? sessions[sessions.length - 1] : null;

  const agentTitle = latestSession ? (latestSession.title || '') : (process.env.AGENT_TITLE || '');
  const agentResultSummary = latestSession ? (latestSession.result || '') : (process.env.AGENT_RESULT || '');

  /** @type {SessionDataMap} */
  let sessionDataMap = {};
  try { sessionDataMap = JSON.parse(process.env.SESSION_DATA_MAP || '{}'); } catch (_) { /* invalid */ }

  if (latestSession) {
    const sessionData = {
      screenshot: agentScreenshotUrl || '',
      gh_action_url: ghActionUrl
    };
    if (agentCommitSha) sessionData.commit_sha = agentCommitSha;
    if (agentPrUrl) sessionData.pr_url = agentPrUrl;
    sessionDataMap[latestSession.id] = sessionData;
  }

  const rawPrompt = (latestSession && latestSession.prompt) ? latestSession.prompt : triggerText;
  const cleanPrompt = utils.cleanPrompt(rawPrompt);
  const sourceUrlMatch = rawPrompt.match(/◌\s+(\S+)/);
  const sourceUrl = sourceUrlMatch ? sourceUrlMatch[1] : '';
  const agentRunUrl = `https://app.netlify.com/projects/${siteName}/agent-runs/${agentId}`;

  const dryRunTag = isDryRun ? ' (preview)' : '';
  let message = `### [Netlify Agent Runner completed${dryRunTag}](${agentRunUrl}) ✅\n\n`;

  if (isDryRun) {
    message += `> **Preview mode** — no PR was created and no commits were made.\n\n`;
  }

  if (cleanPrompt) message += utils.formatPromptBlock(cleanPrompt);
  message += agentTitle ? `### Result: ${agentTitle}\n\n` : `### Result\n\n`;

  if (agentScreenshotUrl && agentDeployUrl) {
    message += `<a href="${agentDeployUrl}"><img src="${agentScreenshotUrl}" alt="Preview" width="250" align="right"></a>\n\n`;
  }

  if (agentResultSummary.trim()) message += `${agentResultSummary.trim()}\n\n`;

  /** @type {string[]} */
  const links = [];
  if (sourceUrl) links.push(sourceUrl);
  links.push(`[Netlify agent run](${agentRunUrl})`);
  if (agentDeployUrl) links.push(`[Deploy preview](${agentDeployUrl})`);
  links.push(`[GitHub Action logs](${ghActionUrl})`);
  message += links.join(' • ') + '\n\n';

  if (!isPR && agentPrUrl) {
    const prNumMatch = agentPrUrl.match(/\/pull\/(\d+)/);
    message += prNumMatch
      ? `Changes in Pull Request #${prNumMatch[1]}\n`
      : `Changes in [Pull Request](${agentPrUrl})\n`;
  } else if (!isPR && agentPrBranch) {
    message += `Branch: \`${agentPrBranch}\`\n`;
  }

  message += `\n<!-- netlify-agent-session-data:${JSON.stringify(sessionDataMap)} -->`;
  message += `\n<!-- netlify-agent-runner-id:${agentId} -->`;
  message += `\n<!-- netlify-agent-run-status -->`;

  core.setOutput('comment-body', message);
  core.setOutput('session-data-map', JSON.stringify(sessionDataMap));
};
