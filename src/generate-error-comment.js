// Generate the error status comment body.
// Sets output: comment-body

/** @typedef {import('./types').ActionCore} ActionCore */

/**
 * @param {{core: ActionCore}} params
 * @returns {Promise<void>}
 */
module.exports = async function generateErrorComment({ core }) {
  const isPR = process.env.IS_PR === 'true';
  const agentError = process.env.AGENT_ERROR || '';
  const agentId = process.env.AGENT_ID || '';
  const siteName = process.env.SITE_NAME || '';
  const issueNumber = process.env.ISSUE_NUMBER || '';
  const ghActionUrl = process.env.GH_ACTION_URL || '';

  const agentRunUrl = agentId && siteName
    ? `https://app.netlify.com/projects/${siteName}/agent-runs/${agentId}`
    : '';

  let message = agentRunUrl
    ? `### [❌ Netlify Agent Runner failed](${agentRunUrl})\n\n`
    : `### ❌ Netlify Agent Runner failed\n\n`;
  message += `An error occurred while processing ${isPR ? 'Pull Request' : 'Issue'} #${issueNumber}.\n\n`;

  if (agentError) {
    message += `**Error:**\n\n\`\`\`\n${agentError.substring(0, 500)}\n\`\`\`\n\n`;
    const providerMatch = agentError.match(/Agent Runner (\w+) is not available/i);
    if (providerMatch) {
      const down = providerMatch[1].toLowerCase();
      const others = ['claude', 'codex', 'gemini'].filter(m => m !== down);
      message += `Looks like a temporary downstream issue. Try ${others.map(m => `\`@netlify ${m}\``).join(' or ')} instead.\n\n`;
    }
  } else {
    message += `**Possible causes:**\n`;
    message += `- Missing or expired [\`NETLIFY_AUTH_TOKEN\`](https://app.netlify.com/user/applications#personal-access-tokens) or \`NETLIFY_SITE_ID\` — check your repository secrets\n`;
    message += `- Agent timed out — try breaking down the task into smaller prompts\n`;
    message += `- Temporary Netlify API issue — retry after a few minutes\n\n`;
  }

  /** @type {string[]} */
  const links = [];
  if (agentRunUrl) links.push(`[Netlify agent run](${agentRunUrl})`);
  links.push(`[GitHub Action logs](${ghActionUrl})`);
  message += links.join(' • ') + '\n\n---\n\nTry again with \`@netlify [specific instructions]\`\n';
  if (agentId) message += `\n<!-- netlify-agent-runner-id:${agentId} -->`;
  message += `\n<!-- netlify-agent-run-status -->`;

  core.setOutput('comment-body', message);
};
