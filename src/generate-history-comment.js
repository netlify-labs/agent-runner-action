// Generate the run history comment body.
// Sets output: comment-body

/**
 * @typedef {import('./types').ActionContext} ActionContext
 * @typedef {import('./types').ActionCore} ActionCore
 * @typedef {import('./types').AgentSession} AgentSession
 * @typedef {import('./types').SessionDataMap} SessionDataMap
 */

const fs = require('fs');
const utils = require('./utils');
const { HISTORY_COMMENT_MARKER } = require('./comment-markers');

/**
 * @param {{context: ActionContext, core: ActionCore}} params
 * @returns {Promise<void>}
 */
module.exports = async function generateHistoryComment({ context, core }) {
  const agentId = process.env.AGENT_ID || '';
  let agentSessionsJson = '[]';
  try {
    agentSessionsJson = fs.readFileSync(
      `${process.env.RUNNER_TEMP}/agent-sessions-${agentId}.json`, 'utf8'
    );
  } catch (_) { /* no file */ }

  const siteName = process.env.SITE_NAME || context.repo.repo;
  /** @type {AgentSession[]} */
  let sessions = [];
  try { sessions = JSON.parse(agentSessionsJson); } catch (_) { /* invalid */ }
  /** @type {SessionDataMap} */
  let sessionDataMap = {};
  try { sessionDataMap = JSON.parse(process.env.SESSION_DATA_MAP || '{}'); } catch (_) { /* invalid */ }

  if (sessions.length === 0) {
    core.setOutput('comment-body', '');
    return;
  }

  const agentRunUrl = `https://app.netlify.com/projects/${siteName}/agent-runs/${agentId}`;
  let message = `### Agent Run History\n\nView the full history in the [Netlify Agent Runners dashboard](${agentRunUrl})\n\n---\n\n`;

  const reversed = [...sessions].reverse();
  reversed.forEach((session, idx) => {
    const runNum = sessions.length - idx;
    const isLatest = idx === 0;
    const model = (session.agent_config && session.agent_config.agent) || 'codex';
    const data = sessionDataMap[session.id] || {};
    const screenshot = data.screenshot || '';
    const ghUrl = data.gh_action_url || '';
    const deployUrl = session.deploy_url || '';
    const isFailed = session.state === 'failed' || session.state === 'error';
    const rawPrompt = session.prompt || '';
    const sourceUrlMatch = rawPrompt.match(/◌\s+(\S+)/);
    const sourceUrl = sourceUrlMatch ? sourceUrlMatch[1] : '';
    let cleanPrompt = utils.cleanPrompt(rawPrompt);

    const runDate = session.created_at ? utils.formatRunDate(session.created_at) : '';
    const datePart = runDate ? ` at ${runDate}` : '';
    const runHeader = `Run ${runNum}${datePart} using ${model}`;

    if (isFailed) {
      message += `❌ \`${runHeader}\`\n\nFailed\n\n`;
      if (cleanPrompt) message += utils.formatPromptBlock(cleanPrompt, sourceUrl);
      if (ghUrl) message += `[GitHub Action logs](${ghUrl})\n\n`;
    } else {
      const title = session.title || '';
      if (screenshot && deployUrl) {
        message += `<a href="${deployUrl}"><img src="${screenshot}" alt="Preview" width="180" align="right"></a>`;
      }
      message += `✅ \`${runHeader}\`\n\n${title}\n\n`;
      if (cleanPrompt) message += utils.formatPromptBlock(cleanPrompt, sourceUrl);
      const commitSha = data.commit_sha || '';
      const prUrl = data.pr_url || '';
      const repoFullName = `${context.repo.owner}/${context.repo.repo}`;
      /** @type {string[]} */
      const links = [];
      if (deployUrl) links.push(`[Open Preview URL](${deployUrl})`);
      links.push(`[Agent run](${agentRunUrl})`);
      if (commitSha && prUrl) {
        const prNum = prUrl.match(/\/pull\/(\d+)/);
        if (prNum) {
          links.push(`[Code Changes](https://github.com/${repoFullName}/pull/${prNum[1]}/commits/${commitSha})`);
        }
      } else if (commitSha) {
        links.push(`[Code Changes](https://github.com/${repoFullName}/commit/${commitSha})`);
      }
      if (ghUrl) links.push(`[GitHub Action logs](${ghUrl})`);
      message += links.join(' • ') + '\n\n';
    }
    message += `---\n\n`;
  });

  message += HISTORY_COMMENT_MARKER;
  core.setOutput('comment-body', message);
};
