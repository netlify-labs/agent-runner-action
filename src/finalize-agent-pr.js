// Preserve the action's post-landing PR title/body cleanup without owning any
// Agent Runner lifecycle or landing calls.

const { renderRunnerIdMarker } = require('./comment-markers');

/** @typedef {import('./types').ActionParams} ActionParams */

/**
 * @param {string} title
 * @returns {string}
 */
function cleanPullRequestTitle(title) {
  return title
    .replace(
      /@(netlify|nelify|netlfy|netify|netlif|netfly)([_-](agents?([_-]runs?)?|ai))?\s+((with|using|use|via)\s+)?(claude|codex|gemini)?\s*/i,
      '',
    )
    .trim();
}

/**
 * @param {string} body
 * @param {string} issueNumber
 * @param {string} runnerId
 * @returns {string}
 */
function buildPullRequestBody(body, issueNumber, runnerId) {
  const additions = [];
  if (
    issueNumber
    && !new RegExp(`\\bResolves\\s+#${issueNumber}\\b`, 'i').test(body)
  ) {
    additions.push(`Resolves #${issueNumber}`);
  }
  const marker = renderRunnerIdMarker(runnerId);
  if (marker && !body.includes(marker)) additions.push(marker);
  const existing = body.trim();
  if (additions.length === 0) return existing;
  return [
    ...(existing ? [existing, '---'] : []),
    additions.join('\n'),
  ].join('\n\n');
}

/**
 * @param {ActionParams} params
 * @returns {Promise<void>}
 */
module.exports = async function finalizeAgentPr({
  github,
  context,
  core,
}) {
  const prUrl = String(process.env.AGENT_PR_URL || '').trim();
  const runnerId = String(process.env.AGENT_ID || '').trim();
  const issueNumber = String(process.env.ISSUE_NUMBER || '').trim();
  const match = prUrl.match(
    /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)(?:[/?#].*)?$/,
  );
  if (!match) {
    core.setFailed('Agent Runner returned an invalid GitHub pull request URL.');
    return;
  }
  const [, owner, repo, number] = match;
  if (owner !== context.repo.owner || repo !== context.repo.repo) {
    core.setFailed('Agent Runner pull request does not belong to this repository.');
    return;
  }

  const pullNumber = Number(number);
  const response = await github.rest.pulls.get({
    owner,
    repo,
    pull_number: pullNumber,
  });
  const currentTitle = String(
    /** @type {Record<string, unknown>} */ (response.data).title || '',
  );
  const currentBody = String(
    /** @type {Record<string, unknown>} */ (response.data).body || '',
  );
  const title = cleanPullRequestTitle(currentTitle);
  const body = buildPullRequestBody(currentBody, issueNumber, runnerId);

  /** @type {{owner: string, repo: string, pull_number: number, title?: string, body?: string}} */
  const update = { owner, repo, pull_number: pullNumber };
  if (title && title !== currentTitle) update.title = title;
  if (body && body !== currentBody) update.body = body;
  if (update.title !== undefined || update.body !== undefined) {
    await github.rest.pulls.update(update);
  }
};

module.exports.buildPullRequestBody = buildPullRequestBody;
module.exports.cleanPullRequestTitle = cleanPullRequestTitle;
