// Generate the error status comment body.
// Sets output: comment-body

/** @typedef {import('./types').ActionCore} ActionCore */
const { STATUS_COMMENT_MARKER, renderRunnerIdMarker } = require('./comment-markers');
const { classifyFailure } = require('./failure-taxonomy');

const MAX_ERROR_LENGTH = 500;
const ANSI_PATTERN = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;

/**
 * @param {string} value
 * @returns {number}
 */
function parseStatusCode(value) {
  const parsed = parseInt(value, 10);
  return Number.isNaN(parsed) ? 0 : parsed;
}

/**
 * Remove unsafe control characters and code-fence breaks from error text.
 * @param {string} value
 * @returns {string}
 */
function sanitizeErrorText(value) {
  return (value || '')
    .replace(ANSI_PATTERN, '')
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '')
    .replace(/\bAgent Runner (\w+) is not available\b/gi, 'Agent $1 is not available')
    .replace(/```/g, "'''")
    .trim();
}

/**
 * @param {string} value
 * @returns {string}
 */
function truncateErrorText(value) {
  if (value.length <= MAX_ERROR_LENGTH) return value;
  return `${value.slice(0, MAX_ERROR_LENGTH)}…`;
}

/**
 * Preserve explicit agent fallback guidance when providers are unavailable.
 * @param {string} category
 * @param {string} errorText
 * @returns {string}
 */
function renderAgentUnavailableHint(category, errorText) {
  if (category !== 'agent-unavailable' && category !== 'model-unavailable') return '';
  const providerMatch = errorText.match(/(?:Agent Runner|agent) (\w+) is not available/i);
  if (!providerMatch) return '';

  const unavailableModel = providerMatch[1].toLowerCase();
  const alternates = ['claude', 'codex', 'gemini'].filter(model => model !== unavailableModel);
  if (alternates.length === 0) return '';
  return `Try ${alternates.map(model => `\`@netlify ${model}\``).join(' or ')} instead.`;
}

/**
 * @param {{core: ActionCore}} params
 * @returns {Promise<void>}
 */
module.exports = async function generateErrorComment({ core }) {
  const isPR = process.env.IS_PR === 'true';
  const agentError = process.env.AGENT_ERROR || '';
  const agentId = process.env.AGENT_ID || process.env.RUNNER_ID || '';
  const siteName = process.env.SITE_NAME || '';
  const issueNumber = process.env.ISSUE_NUMBER || '';
  const ghActionUrl = process.env.GH_ACTION_URL || '';
  const failureCategory = process.env.FAILURE_CATEGORY || process.env.AGENT_FAILURE_CATEGORY || '';
  const failureStage = process.env.FAILURE_STAGE || process.env.AGENT_FAILURE_STAGE || '';
  const statusCode = parseStatusCode(process.env.FAILURE_STATUS_CODE || process.env.STATUS_CODE || '');

  const agentDashboardUrl = siteName
    ? `https://app.netlify.com/projects/${siteName}/agent-runs`
    : '';
  const agentRunUrl = agentId && siteName
    ? `${agentDashboardUrl}/${agentId}`
    : '';
  const failure = classifyFailure({
    category: failureCategory,
    stage: failureStage,
    error: agentError,
    statusCode: statusCode || undefined,
  });
  const safeError = truncateErrorText(sanitizeErrorText(agentError));
  const agentUnavailableHint = renderAgentUnavailableHint(failure.category, agentError);

  let message = agentRunUrl
    ? `### [❌ ${failure.title}](${agentRunUrl})\n\n`
    : `### ❌ ${failure.title}\n\n`;
  message += `An error occurred while processing ${isPR ? 'Pull Request' : 'Issue'} #${issueNumber || 'unknown'}.\n\n`;
  message += `${failure.summary}\n\n`;
  message += `- **Category:** \`${failure.category}\`\n`;
  message += `- **Stage:** \`${failure.stage}\`\n`;
  message += `- **Retryable:** ${failure.retryable ? 'yes' : 'no'}\n`;
  message += `- **User action required:** ${failure.userActionRequired ? 'yes' : 'no'}\n\n`;

  if (failure.remediation.length > 0) {
    message += '**Suggested next steps:**\n';
    for (const step of failure.remediation) {
      message += `- ${step}\n`;
    }
    message += '\n';
  }

  if (agentUnavailableHint) {
    message += `${agentUnavailableHint}\n\n`;
  }

  if (safeError) {
    message += `**Error excerpt:**\n\n\`\`\`text\n${safeError}\n\`\`\`\n\n`;
  }

  /** @type {string[]} */
  const links = [];
  if (agentRunUrl) links.push(`[Agent run](${agentRunUrl})`);
  if (!agentRunUrl && agentDashboardUrl) links.push(`[Netlify Agent Runners dashboard](${agentDashboardUrl})`);
  if (ghActionUrl) links.push(`[GitHub Action logs](${ghActionUrl})`);
  if (links.length > 0) {
    message += links.join(' • ') + '\n\n';
  }
  message += '---\n\nTry again with `@netlify [specific instructions]`\n';

  if (agentId) message += `\n${renderRunnerIdMarker(agentId)}`;
  message += `\n${STATUS_COMMENT_MARKER}`;

  core.setOutput('comment-body', message);
};
