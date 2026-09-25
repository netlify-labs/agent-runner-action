// Extract context information from the GitHub event.
// Sets outputs: issue-number, pr-number, head-ref, base-ref, head-sha,
//               is-pr, trigger-text, has-linked-pr, agent, model, effort,
//               is-dry-run

/** @typedef {import('./types').ActionParams} ActionParams */

const utils = require('./utils');

/**
 * @param {ActionParams} params
 * @returns {Promise<void>}
 */
module.exports = async function getContext({ github, context, core }) {
  const defaultAgent = process.env.DEFAULT_AGENT || process.env.DEFAULT_MODEL || 'codex';
  let defaultEffort = utils.normalizeEffort(process.env.DEFAULT_EFFORT);
  if (defaultEffort === null) {
    console.log(`Ignoring unsupported default-effort "${process.env.DEFAULT_EFFORT}"; using Auto. Supported: ${utils.VALID_EFFORTS.join(', ')}, auto.`);
    defaultEffort = '';
  }

  /** @type {number | undefined} */
  let issueNumber;
  /** @type {number | undefined} */
  let prNumber;
  /** @type {string | undefined} */
  let headRef;
  /** @type {string | undefined} */
  let baseRef;
  /** @type {string | undefined} */
  let headSha;
  let linkedPrNumber = '';
  let triggerText = '';
  let hasLinkedPR = false;
  let isPR = false;
  // Text used to select agent and effort. Differs from triggerText only when
  // an issue title's @netlify mention is stripped for display.
  let selectionText = '';

  const { payload } = context;

  if (context.eventName === 'workflow_dispatch') {
    triggerText = payload.inputs?.trigger_text || '';
    if (!utils.matchesTrigger(triggerText)) {
      triggerText = '@netlify ' + triggerText;
    }

  } else if (context.eventName === 'pull_request_target') {
    const pr = payload.pull_request;
    isPR = true;
    issueNumber = pr?.number;
    prNumber = pr?.number;
    headRef = pr?.head.ref;
    baseRef = pr?.base.ref;
    headSha = pr?.head.sha;
    triggerText = pr?.body || '';

  } else if (context.eventName === 'issues') {
    const issue = payload.issue;
    isPR = false;
    issueNumber = issue?.number;
    let issueTitle = issue?.title || '';
    const issueBody = issue?.body || '';
    if (utils.matchesTrigger(issueTitle)) {
      selectionText = `${issueTitle}\n\n${issueBody}`;
      // Strip @netlify mention from title only when the title itself contains the trigger
      issueTitle = issueTitle
        .replace(utils.TRIGGER_PATTERN, '')
        .replace(new RegExp(`\\s+(?:with|using|use|via)\\s+(?:claude|codex|gemini)(?:[ \\t]+(?:${utils.VALID_EFFORTS.join('|')})(?=\\s|:|$))?\\s*`, 'i'), '')
        .replace(new RegExp(`\\s+(?:claude|codex|gemini)(?:[ \\t]+(?:${utils.VALID_EFFORTS.join('|')})(?=\\s|:|$))?\\s*`, 'i'), '')
        .replace(new RegExp(`\\s*${utils.EXPLICIT_EFFORT_PATTERN.source}`, 'i'), '')
        .trim();
    }
    triggerText = `${issueTitle}\n\n${issueBody}`.trim();

  } else if (context.eventName === 'issue_comment') {
    issueNumber = payload.issue?.number;
    triggerText = payload.comment?.body || '';
    if (payload.issue?.pull_request) {
      isPR = true;
      try {
        const pr = await github.rest.pulls.get({
          owner: context.repo.owner, repo: context.repo.repo,
          pull_number: /** @type {number} */ (issueNumber)
        });
        prNumber = issueNumber;
        headRef = pr.data.head.ref;
        baseRef = pr.data.base.ref;
        headSha = pr.data.head.sha;
      } catch (error) {
        console.error('Error fetching PR info:', error);
        isPR = false;
      }
    } else {
      isPR = false;
    }

  } else if (context.eventName === 'pull_request_review_comment' || context.eventName === 'pull_request_review') {
    const pr = payload.pull_request;
    isPR = true;
    issueNumber = pr?.number;
    prNumber = pr?.number;
    headRef = pr?.head.ref;
    baseRef = pr?.base.ref;
    headSha = pr?.head.sha;
    triggerText = context.eventName === 'pull_request_review_comment'
      ? (payload.comment?.body || '')
      : (payload.review?.body || '');
  }

  selectionText = selectionText || triggerText;

  // Detect preview/dry-run mode from trigger text
  const isDryRun = process.env.DRY_RUN === 'true' ||
    /\b(?:preview|dry[- ]?run)\b/i.test(triggerText.split('\n')[0] || '');

  // Extract selected agent. `model` remains an output alias for compatibility.
  let agent = defaultAgent;
  const workflowDispatchAgent = payload.inputs?.agent || payload.inputs?.model;
  if (context.eventName === 'workflow_dispatch' && workflowDispatchAgent) {
    agent = workflowDispatchAgent.toLowerCase();
  } else {
    agent = utils.extractModel(selectionText, defaultAgent);
  }

  // Extract effort. Empty means omit it and let the backend choose (Auto).
  let effort = defaultEffort;
  const workflowDispatchEffort = utils.normalizeEffort(payload.inputs?.effort);
  if (context.eventName === 'workflow_dispatch' && workflowDispatchEffort) {
    effort = workflowDispatchEffort;
  } else {
    effort = utils.extractEffort(selectionText, defaultEffort);
  }

  // Append source URL for back-linking
  /** @type {string} */
  let sourceUrl = '';
  if (context.eventName === 'issue_comment' || context.eventName === 'pull_request_review_comment') {
    sourceUrl = payload.comment?.html_url || '';
  } else if (context.eventName === 'pull_request_review') {
    sourceUrl = payload.review?.html_url || '';
  } else if (context.eventName === 'issues') {
    sourceUrl = payload.issue?.html_url || '';
  } else if (context.eventName === 'pull_request_target') {
    sourceUrl = payload.pull_request?.html_url || '';
  }
  if (sourceUrl) {
    triggerText = `${triggerText}\n\n◌ ${sourceUrl}`;
  }

  core.setOutput('issue-number', issueNumber || '');
  core.setOutput('pr-number', prNumber || '');
  core.setOutput('head-ref', headRef || '');
  core.setOutput('base-ref', baseRef || '');
  core.setOutput('head-sha', headSha || '');
  core.setOutput('is-pr', isPR.toString());
  core.setOutput('trigger-text', triggerText);
  core.setOutput('has-linked-pr', hasLinkedPR.toString());
  core.setOutput('linked-pr-number', linkedPrNumber);
  core.setOutput('agent', agent);
  core.setOutput('model', agent);
  core.setOutput('effort', effort);
  core.setOutput('is-dry-run', isDryRun.toString());

  console.log(`Context: event=${context.eventName} issue=#${issueNumber} isPR=${isPR} agent=${agent} effort=${effort || 'auto'} dryRun=${isDryRun}`);
};
