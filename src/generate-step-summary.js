// Render a structured Markdown summary for GitHub Actions step summaries.
// Pure functions only: no GitHub/Netlify API calls.

/**
 * @typedef {import('./contracts').StepSummaryInput} StepSummaryInput
 * @typedef {import('./contracts').PreflightResult} PreflightResult
 */

const { createStepSummaryInput } = require('./contracts');
const { classifyFailure } = require('./failure-taxonomy');

/**
 * @param {unknown} value
 * @returns {string}
 */
function toText(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (value instanceof Error) return `${value.name}: ${value.message}`;
  return String(value);
}

/**
 * Escape table values so Markdown tables remain stable.
 * @param {unknown} value
 * @returns {string}
 */
function escapeMarkdownTableValue(value) {
  return toText(value)
    .replace(/\r\n/g, '\n')
    .replace(/\n/g, '<br>')
    .replace(/\|/g, '\\|')
    .trim();
}

/**
 * @param {unknown} value
 * @returns {boolean}
 */
function toBool(value) {
  const text = toText(value).trim().toLowerCase();
  return text === 'true' || text === '1' || text === 'yes';
}

/**
 * @param {unknown} value
 * @returns {number}
 */
function toInt(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value);
  const parsed = parseInt(toText(value), 10);
  return Number.isNaN(parsed) ? 0 : parsed;
}

/**
 * @template T
 * @param {unknown} value
 * @returns {T | null}
 */
function parseJson(value) {
  if (typeof value !== 'string' || value.trim() === '') return null;
  try {
    return /** @type {T} */ (JSON.parse(value));
  } catch (_) {
    return null;
  }
}

/**
 * @param {Record<string, unknown>} source
 * @returns {string}
 */
function inferContextLabel(source) {
  const provided = toText(source.contextLabel || source.CONTEXT_LABEL).trim();
  if (provided) return provided;

  const issueNumber = toText(source.issueNumber || source.issue || source.ISSUE_NUM || source.ISSUE_NUMBER).trim();
  const isPr = toBool(source.isPr || source.IS_PR);
  if (!issueNumber) return '';
  return isPr ? `PR #${issueNumber}` : `Issue #${issueNumber}`;
}

/**
 * @param {Record<string, unknown>} source
 * @returns {PreflightResult | null}
 */
function normalizePreflight(source) {
  const fromObject = source.preflight;
  if (fromObject && typeof fromObject === 'object') {
    return /** @type {PreflightResult} */ (fromObject);
  }

  const fromJson = parseJson(/** @type {unknown} */ (
    source.PREFLIGHT_RESULT_JSON || source.preflightResultJson
  ));
  return fromJson;
}

/**
 * @param {Record<string, unknown>} source
 * @returns {import('./contracts').FailureClassification | null}
 */
function normalizeFailure(source) {
  const explicit = source.failure;
  if (explicit && typeof explicit === 'object') {
    return classifyFailure(/** @type {Record<string, unknown>} */ (explicit));
  }

  const fromJson = parseJson(/** @type {unknown} */ (
    source.FAILURE_JSON || source.failureJson
  ));
  if (fromJson && typeof fromJson === 'object') {
    return classifyFailure(/** @type {Record<string, unknown>} */ (fromJson));
  }

  const category = toText(source.failureCategory || source.FAILURE_CATEGORY).trim();
  const stage = toText(source.failureStage || source.FAILURE_STAGE).trim();
  const error = toText(source.agentError || source.AGENT_ERROR || source.error).trim();
  const statusCode = toInt(source.statusCode || source.STATUS_CODE);

  if (!category && !stage && !error && statusCode === 0) return null;

  return classifyFailure({
    category,
    stage,
    error,
    statusCode: statusCode > 0 ? statusCode : undefined,
  });
}

/**
 * Normalize mixed env/object input into the step summary contract.
 * @param {Record<string, unknown>} [source]
 * @returns {StepSummaryInput}
 */
function normalizeStepSummaryInput(source = {}) {
  const rawOutcome = toText(source.outcome || source.OUTCOME).trim().toLowerCase();
  /** @type {'success' | 'failure' | 'timeout' | 'skipped' | 'unknown'} */
  const outcome = (
    rawOutcome === 'success' ||
    rawOutcome === 'failure' ||
    rawOutcome === 'timeout' ||
    rawOutcome === 'skipped'
  ) ? rawOutcome : 'unknown';
  const eventName = toText(source.eventName || source.EVENT_NAME || source.GITHUB_EVENT_NAME).trim();
  const issueNumber = toText(
    source.issueNumber || source.issue || source.ISSUE_NUM || source.ISSUE_NUMBER
  ).trim();

  return createStepSummaryInput({
    outcome,
    eventName,
    contextLabel: inferContextLabel(source),
    model: toText(source.model || source.MODEL).trim() || 'codex',
    isDryRun: toBool(source.isDryRun || source.IS_DRY_RUN),
    isPreflightOnly: toBool(source.isPreflightOnly || source.IS_PREFLIGHT_ONLY),
    issueNumber,
    runnerId: toText(source.runnerId || source.RUNNER_ID || source.AGENT_ID).trim(),
    siteName: toText(source.siteName || source.SITE_NAME).trim(),
    dashboardUrl: toText(source.dashboardUrl || source.AGENT_RUN_URL || source.DASHBOARD_URL).trim(),
    deployUrl: toText(source.deployUrl || source.AGENT_DEPLOY_URL || source.DEPLOY_URL).trim(),
    pullRequestUrl: toText(
      source.pullRequestUrl || source.AGENT_PR_URL || source.PULL_REQUEST_URL
    ).trim(),
    prompt: toText(source.prompt || source.TRIGGER_TEXT || source.PROMPT).trim(),
    failure: normalizeFailure(source),
    preflight: normalizePreflight(source),
  });
}

/**
 * @param {string} label
 * @param {string} url
 * @returns {string}
 */
function formatLink(label, url) {
  if (!url) return '';
  return `[${label}](${url})`;
}

/**
 * @param {string} title
 * @param {[string, string][]} rows
 * @returns {string}
 */
function renderTableSection(title, rows) {
  let markdown = `## ${title}\n\n`;
  markdown += '| Field | Value |\n';
  markdown += '|---|---|\n';
  for (const [field, value] of rows) {
    markdown += `| ${escapeMarkdownTableValue(field)} | ${escapeMarkdownTableValue(value)} |\n`;
  }
  markdown += '\n';
  return markdown;
}

/**
 * Render a markdown summary from mixed input (object or env-like map).
 * @param {Record<string, unknown>} [source]
 * @returns {string}
 */
function renderStepSummary(source = {}) {
  const normalized = normalizeStepSummaryInput(source);
  const timeoutMinutes = toInt(source.timeoutMinutes || source.TIMEOUT_MINUTES);
  let markdown = '# Netlify Agent Runner\n\n';

  markdown += renderTableSection('Run Overview', [
    ['Outcome', normalized.outcome || 'unknown'],
    ['Event', normalized.eventName || 'unknown'],
    ['Context', normalized.contextLabel || 'n/a'],
    ['Model', normalized.model || 'codex'],
    ['Dry-run', normalized.isDryRun ? 'true' : 'false'],
    ['Preflight-only', normalized.isPreflightOnly ? 'true' : 'false'],
  ]);

  markdown += renderTableSection('Agent', [
    ['Runner ID', normalized.runnerId || 'n/a'],
    ['Site', normalized.siteName || 'n/a'],
    ['Dashboard', formatLink('Open run', normalized.dashboardUrl) || 'n/a'],
    ['Deploy Preview', formatLink('Open deploy', normalized.deployUrl) || 'n/a'],
    ['Pull Request', formatLink('Open PR', normalized.pullRequestUrl) || 'n/a'],
  ]);

  markdown += '## Prompt\n\n';
  if (normalized.prompt) {
    const lines = normalized.prompt.split(/\r?\n/);
    markdown += lines.map(line => `> ${line}`).join('\n') + '\n\n';
  } else {
    markdown += '_No prompt captured._\n\n';
  }

  if (normalized.isDryRun) {
    markdown += '> Preview mode: no commit or pull request creation is performed.\n\n';
  }

  if (normalized.isPreflightOnly) {
    markdown += '> Preflight-only mode: configuration was validated without starting a Netlify agent run.\n\n';
  }

  if (normalized.outcome === 'timeout') {
    const timeoutText = timeoutMinutes > 0
      ? `${timeoutMinutes} minute${timeoutMinutes === 1 ? '' : 's'}`
      : 'configured timeout window';
    markdown += `> Timeout: run did not complete within ${timeoutText}.\n\n`;
  }

  if (normalized.failure) {
    markdown += '## Failure\n\n';
    markdown += `**Category:** \`${normalized.failure.category}\`  \n`;
    markdown += `**Stage:** \`${normalized.failure.stage}\`  \n`;
    markdown += `**Retryable:** ${normalized.failure.retryable ? 'yes' : 'no'}  \n`;
    markdown += `**User action required:** ${normalized.failure.userActionRequired ? 'yes' : 'no'}\n\n`;
    markdown += `${normalized.failure.summary}\n\n`;
    if (normalized.failure.remediation.length > 0) {
      markdown += 'Suggested next steps:\n';
      for (const item of normalized.failure.remediation) {
        markdown += `- ${item}\n`;
      }
      markdown += '\n';
    }
  }

  if (normalized.preflight) {
    markdown += '## Preflight Checks\n\n';
    markdown += '| Check | Status | Notes |\n';
    markdown += '|---|---|---|\n';
    for (const check of normalized.preflight.checks) {
      markdown += `| ${escapeMarkdownTableValue(check.id)} | ${escapeMarkdownTableValue(check.status)} | ${escapeMarkdownTableValue(check.message)} |\n`;
    }
    markdown += '\n';

    if (normalized.preflight.warnings.length > 0) {
      markdown += 'Warnings:\n';
      for (const warning of normalized.preflight.warnings) {
        markdown += `- ${warning}\n`;
      }
      markdown += '\n';
    }

    if (normalized.preflight.failures.length > 0) {
      markdown += 'Failures:\n';
      for (const failure of normalized.preflight.failures) {
        markdown += `- ${failure}\n`;
      }
      markdown += '\n';
    }
  }

  return markdown;
}

module.exports = {
  escapeMarkdownTableValue,
  normalizeStepSummaryInput,
  renderStepSummary,
};
