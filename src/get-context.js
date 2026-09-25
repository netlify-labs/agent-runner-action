// Extract context information from the GitHub event.
// Sets outputs: issue-number, pr-number, head-ref, base-ref, head-sha,
//               is-pr, trigger-text, has-linked-pr, agent, model, model-id,
//               model-label, effort, effort-label, config-warnings,
//               is-dry-run

/** @typedef {import('./types').ActionParams} ActionParams */

const utils = require('./utils');
const catalog = require('./agent-catalog');

/**
 * @param {ActionParams} params
 * @returns {Promise<void>}
 */
module.exports = async function getContext({ github, context, core }) {
  const defaultAgent = process.env.DEFAULT_AGENT || process.env.DEFAULT_MODEL || 'codex';
  const defaultModelId = process.env.DEFAULT_MODEL_ID || '';
  const defaultEffort = process.env.DEFAULT_EFFORT || '';

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
  // Text used to select agent, model, and effort. Differs from triggerText
  // only when an issue title's @netlify mention is stripped for display.
  let selectionText = '';

  const { payload } = context;

  const recoverThread = context.eventName === 'workflow_dispatch'
    ? String(payload.inputs?.recover_thread || '').trim()
    : '';
  if (recoverThread && /^\d+$/.test(recoverThread)) {
    // Recovery dispatch (from the recovery cron or a dead-owner stop): target
    // an existing thread and finish its unfinished run; start nothing new.
    issueNumber = Number(recoverThread);
    triggerText = '@netlify (recovering an unfinished run)';
    try {
      const pr = await github.rest.pulls.get({ owner: context.repo.owner, repo: context.repo.repo, pull_number: issueNumber });
      isPR = true;
      prNumber = issueNumber;
      headRef = pr.data.head.ref;
      baseRef = pr.data.base.ref;
      headSha = pr.data.head.sha;
    } catch (_) {
      isPR = false;
    }
  } else if (context.eventName === 'workflow_dispatch') {
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
      // Strip @netlify mention and selector words from the displayed title
      // only when the title itself contains the trigger.
      issueTitle = utils.stripSelection(issueTitle).replace(/\s{2,}/g, ' ').trim();
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
  // One parsed command object for the trigger (before the source-URL line is
  // appended below). Stop and ask mode build on this.
  const parsedCommand = utils.parseCommand(selectionText);
  if (recoverThread && issueNumber) parsedCommand.command = 'recover';

  // Detect preview/dry-run mode from trigger text
  const isDryRun = process.env.DRY_RUN === 'true' ||
    /\b(?:preview|dry[- ]?run)\b/i.test(triggerText.split('\n')[0] || '');

  // Select agent, model, and effort. Mention words win over defaults; a
  // workflow_dispatch input wins over both. `model` remains an output alias
  // for the agent for compatibility; `model-id` is the actual model.
  const inputs = context.eventName === 'workflow_dispatch' ? (payload.inputs || {}) : {};
  const selection = utils.parseSelection(selectionText);
  const dispatchAgent = String(inputs.agent || inputs.model || '').trim().toLowerCase();
  const dispatchModelId = String(inputs.model_id || '').trim().toLowerCase();
  const dispatchEffort = String(inputs.effort || '').trim().toLowerCase();
  /** @type {import('./utils').MentionSelection} */
  const merged = {
    agent: selection?.agent || null,
    model: selection?.model || null,
    effort: selection?.effort || null,
    start: 0,
    end: 0,
  };
  if (dispatchModelId && dispatchModelId !== 'auto') {
    merged.model = dispatchModelId;
    // The dispatch agent choice defaults to codex, so let a catalog model
    // pick its own agent instead of reporting a mismatch.
    merged.agent = selection?.agent
      || (catalog.resolveConfiguredModel(dispatchModelId) ? null : dispatchAgent || null);
  } else if (dispatchAgent) {
    merged.agent = dispatchAgent;
  }
  if (dispatchEffort && dispatchEffort !== 'auto') merged.effort = dispatchEffort;

  const resolved = utils.resolveSelection(merged, { defaultAgent, defaultModelId, defaultEffort });
  const { agent, modelId, modelLabel, effort, effortLabel, warnings } = resolved;
  for (const warning of warnings) {
    console.log(`::warning title=Agent configuration::${warning}`);
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
  core.setOutput('model-id', modelId);
  core.setOutput('model-label', modelLabel);
  core.setOutput('effort', effort);
  core.setOutput('effort-label', effortLabel);
  core.setOutput('config-warnings', warnings.join('\n'));
  core.setOutput('scope-block', utils.buildScopeBlock(process.env.SCOPE_INSTRUCTIONS));
  core.setOutput('command', parsedCommand.command);
  core.setOutput('runner-mode', parsedCommand.mode);
  core.setOutput('is-dry-run', isDryRun.toString());

  console.log(`Context: event=${context.eventName} issue=#${issueNumber} isPR=${isPR} agent=${agent} model=${modelId || 'auto'} effort=${effort || 'auto'} dryRun=${isDryRun}`);
};
