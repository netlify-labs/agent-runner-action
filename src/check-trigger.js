// Determine whether the current GitHub event should activate the agent.
// Sets output: should-run (true/false)

/** @typedef {import('./types').ActionParams} ActionParams */

const utils = require('./utils');

/**
 * @param {ActionParams} params
 * @returns {Promise<void>}
 */
module.exports = async function checkTrigger({ github, context, core }) {
  const event = context.eventName;
  let shouldRun = false;
  let triggerBody = '';

  /**
   * @param {string} username
   * @returns {Promise<boolean>}
   */
  async function hasWritePermission(username) {
    if (!username) return false;
    try {
      const { data } = await github.rest.repos.getCollaboratorPermissionLevel({
        owner: context.repo.owner,
        repo: context.repo.repo,
        username,
      });
      return ['write', 'maintain', 'admin'].includes(data.permission);
    } catch (error) {
      console.log(`Permission check failed for ${username}: ${/** @type {Error} */ (error).message}`);
      return false;
    }
  }

  // Determine the text to scan for @netlify
  if (event === 'workflow_dispatch') {
    shouldRun = true;
  } else if (event === 'pull_request_target') {
    triggerBody = (context.payload.pull_request || {}).body || '';
  } else if (event === 'issue_comment') {
    triggerBody = (context.payload.comment || {}).body || '';
  } else if (event === 'pull_request_review_comment') {
    triggerBody = (context.payload.comment || {}).body || '';
  } else if (event === 'pull_request_review') {
    triggerBody = (context.payload.review || {}).body || '';
  } else if (event === 'issues') {
    const title = (context.payload.issue || {}).title || '';
    const body = (context.payload.issue || {}).body || '';
    triggerBody = `${title}\n${body}`;
  }

  if (!shouldRun) {
    shouldRun = utils.matchesTrigger(triggerBody);
  }

  // Bot-loop prevention
  const sender = (context.payload.sender || {}).login || '';
  const botAccounts = ['github-actions[bot]', 'netlify-coding[bot]', 'netlify[bot]'];
  if (botAccounts.includes(sender)) {
    console.log(`Skipping bot sender: ${sender}`);
    shouldRun = false;
  }

  // Permission / author-association check
  if (shouldRun && event !== 'workflow_dispatch') {
    const validAssociations = ['COLLABORATOR', 'MEMBER', 'OWNER'];
    /** @type {string} */
    let association = '';
    let isFork = false;

    if (event === 'pull_request_target') {
      association = (context.payload.pull_request || {}).author_association || '';
      const headRepoName = context.payload.pull_request?.head?.repo?.full_name || '';
      const baseRepoName = context.payload.repository?.full_name || '';
      isFork = headRepoName !== baseRepoName;
    } else if (event === 'issue_comment' || event === 'pull_request_review_comment') {
      association = (context.payload.comment || {}).author_association || '';
    } else if (event === 'pull_request_review') {
      association = (context.payload.review || {}).author_association || '';
    } else if (event === 'issues') {
      association = (context.payload.issue || {}).author_association || '';
    }

    const isOwner = sender === context.repo.owner;
    const hasAssociation = validAssociations.includes(association);
    const hasWriteAccess = !isOwner && !hasAssociation
      ? await hasWritePermission(sender)
      : false;

    if (event === 'pull_request_target') {
      if (isFork && !hasAssociation && !hasWriteAccess) {
        console.log(`Fork PR from ${sender} without valid association (${association}), skipping`);
        shouldRun = false;
      }
    } else if (!isOwner && !hasAssociation && !hasWriteAccess) {
      console.log(`User ${sender} lacks permission (association: ${association}), skipping`);
      shouldRun = false;
    }
  }

  // ALLOWED_USERS check for workflow_dispatch
  if (shouldRun && event === 'workflow_dispatch') {
    const allowedUsersInput = process.env.ALLOWED_USERS || '';
    if (allowedUsersInput.trim()) {
      const allowedUsers = allowedUsersInput.split(',').map(/** @param {string} u */ u => u.trim()).filter(Boolean);
      const actor = (context.payload.inputs || {}).actor || context.actor;
      if (allowedUsers.length > 0 && !allowedUsers.includes(actor)) {
        if (!(await hasWritePermission(actor))) {
          console.log(`User ${actor} not in allowed list and lacks write access`);
          shouldRun = false;
        }
      }
    }
  }

  core.setOutput('should-run', shouldRun.toString());
  console.log(`Trigger check result: ${shouldRun} (event: ${event}, sender: ${sender})`);
};
