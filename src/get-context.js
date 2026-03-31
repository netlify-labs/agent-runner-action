// Extract context information from the GitHub event.
// Sets outputs: issue-number, pr-number, head-ref, base-ref, head-sha,
//               is-pr, trigger-text, has-linked-pr, model, is-dry-run

/** @typedef {import('./types').ActionParams} ActionParams */

const utils = require('./utils');

/**
 * @param {ActionParams} params
 * @returns {Promise<void>}
 */
module.exports = async function getContext({ github, context, core }) {
  const defaultModel = process.env.DEFAULT_MODEL || 'codex';

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
  let triggerText = '';
  let hasLinkedPR = false;
  let isPR = false;

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
    if (utils.matchesTrigger(issueBody)) {
      // Strip @netlify mention from title (if duplicated in both title and body)
      issueTitle = issueTitle
        .replace(utils.TRIGGER_PATTERN, '')
        // Only strip whitespace+model when a model name or preposition is actually present
        .replace(/\s+(?:with|using|use|via)\s+(?:claude|codex|gemini)\s*/i, '')
        .replace(/\s+(?:claude|codex|gemini)\s*/i, '')
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
      try {
        const { data: timeline } = await github.rest.issues.listEventsForTimeline({
          owner: context.repo.owner, repo: context.repo.repo,
          issue_number: /** @type {number} */ (issueNumber), per_page: 100,
          headers: { accept: 'application/vnd.github.mockingbird-preview+json' }
        });
        const linkedPRs = timeline
          .filter(/** @param {import('./types').TimelineEvent} e */ e => e.event === 'cross-referenced')
          .filter(/** @param {import('./types').TimelineEvent} e */ e => e.source?.issue?.pull_request?.url);
        hasLinkedPR = linkedPRs.length > 0;
        console.log(`Issue #${issueNumber}, linked PRs: ${linkedPRs.length}`);
      } catch (error) {
        console.error('Error checking linked PRs:', error);
      }
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

  // Detect preview/dry-run mode from trigger text
  const isDryRun = process.env.DRY_RUN === 'true' ||
    /\b(?:preview|dry[- ]?run)\b/i.test(triggerText.split('\n')[0] || '');

  // Extract model
  let model = defaultModel;
  if (context.eventName === 'workflow_dispatch' && payload.inputs?.model) {
    model = payload.inputs.model.toLowerCase();
  } else {
    model = utils.extractModel(triggerText, defaultModel);
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
  core.setOutput('model', model);
  core.setOutput('is-dry-run', isDryRun.toString());

  console.log(`Context: event=${context.eventName} issue=#${issueNumber} isPR=${isPR} model=${model} dryRun=${isDryRun}`);
};
