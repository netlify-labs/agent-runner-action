// "Check run scope" step: find the files this run changed, flag protected or
// unexpected ones, save the result for the comment renderers, post the
// section on the PR for issue-triggered runs, and apply the optional label and
// draft escalations. Never fails the workflow.

const fs = require('node:fs');
const path = require('node:path');
const { parsePatternList } = require('./path-globs');
const { collectChangedFiles } = require('./scope-files');
const { evaluateScope, renderScopeSection, scopeResultPath } = require('./scope-guard');
const utils = require('./utils');

const REVIEW_LABEL = {
  name: 'netlify-agent:review-scope',
  color: 'D93F0B',
  description: 'Netlify agent run changed protected or unexpected files',
};

/**
 * @param {string} value
 * @returns {string[]}
 */
function parseActions(value) {
  const actions = new Set(String(value || 'comment').split(',').map((entry) => entry.trim().toLowerCase()).filter(Boolean));
  actions.add('comment');
  return [...actions].filter((entry) => ['comment', 'label', 'draft'].includes(entry));
}

/**
 * @param {string} prUrl
 * @returns {number | null}
 */
function prNumberFromUrl(prUrl) {
  const match = /\/pull\/(\d+)(?:$|[/?#])/.exec(String(prUrl || ''));
  return match ? Number(match[1]) : null;
}

/**
 * Latest session ID from the sessions file run-agent.js writes.
 * @param {string} runnerTemp
 * @param {string} runnerId
 * @returns {string}
 */
function latestSessionId(runnerTemp, runnerId) {
  try {
    const sessions = JSON.parse(fs.readFileSync(path.join(runnerTemp, `agent-sessions-${runnerId}.json`), 'utf8'));
    const last = Array.isArray(sessions) ? sessions[sessions.length - 1] : null;
    return last && last.id ? String(last.id) : '';
  } catch (_) {
    return '';
  }
}

/**
 * The shared GitHubClient type in types.js only covers endpoints other modules
 * use; this step needs several more (files, contents, labels, GraphQL).
 * @typedef {{ setOutput: (name: string, value: string) => void, warning: (message: string) => void, summary?: { addRaw: (text: string) => unknown } }} ScopeCore
 */

/**
 * @param {{ github: any, context: { repo: { owner: string, repo: string } }, core: ScopeCore, env?: Record<string, string | undefined> }} params
 * @returns {Promise<void>}
 */
module.exports = async function checkRunScope({ github, context, core, env = process.env }) {
  const repo = { owner: context.repo.owner, repo: context.repo.repo };
  const runnerId = String(env.AGENT_ID || '').replace(/[^A-Za-z0-9_-]/g, '');
  const runnerTemp = String(env.RUNNER_TEMP || '');
  const patterns = parsePatternList(env.PROTECTED_PATHS ?? 'default');
  const flagNewTopLevel = String(env.FLAG_NEW_TOP_LEVEL || 'true').toLowerCase() !== 'false';
  const actions = parseActions(env.PROTECTED_PATHS_ACTION || 'comment');
  const landingKind = env.LANDING_KIND || 'none';
  const isDryRun = env.IS_DRY_RUN === 'true';
  const prNumber = prNumberFromUrl(env.AGENT_PR_URL || '');
  const summary = (/** @type {string} */ line) => core.summary ? core.summary.addRaw(`${line}\n`) : undefined;

  core.setOutput('scope-flags', '[]');
  core.setOutput('scope-flag-count', '0');
  if (!runnerId || !runnerTemp) {
    console.log('Scope check skipped: no agent run.');
    return;
  }
  if (patterns.length === 0 && !flagNewTopLevel) {
    console.log('Scope check disabled (protected-paths: none, flag-new-top-level: false).');
    return;
  }

  /** @type {import('./scope-files').FileSource} */
  let source = { kind: 'none' };
  /** @type {import('./scope-files').ChangedFiles | null} */
  let prepared = null;
  if (landingKind === 'pr-created' && prNumber) source = { kind: 'pr', number: prNumber };
  else if (landingKind === 'commit' && env.AGENT_COMMIT_SHA) source = { kind: 'commit', sha: env.AGENT_COMMIT_SHA };
  else if (isDryRun) {
    try {
      prepared = JSON.parse(fs.readFileSync(path.join(runnerTemp, `agent-scope-files-${runnerId}.json`), 'utf8'));
    } catch (_) {
      prepared = null;
    }
  }
  if (source.kind === 'none' && !prepared) {
    console.log(`Scope check skipped: nothing landed (landing=${landingKind}).`);
    return;
  }

  const changed = prepared || await collectChangedFiles({ github, repo, source });
  const baseRef = env.BASE_REF || '';
  const result = await evaluateScope({
    files: changed.files,
    complete: changed.complete,
    reason: changed.reason,
    patterns,
    flagNewTopLevel,
    prompt: utils.cleanPrompt(env.TRIGGER_TEXT || ''),
    baseTopLevelExists: async (segment) => {
      try {
        await github.rest.repos.getContent({ ...repo, path: segment, ...(baseRef ? { ref: baseRef } : {}) });
        return true;
      } catch (error) {
        const status = /** @type {{ status?: number }} */ (error).status;
        // Anything but a clear 404 counts as "exists" so we never raise a
        // false "new folder" warning from an API hiccup.
        return status !== 404;
      }
    },
  });

  fs.writeFileSync(scopeResultPath(runnerTemp, runnerId), JSON.stringify(result), { encoding: 'utf8', mode: 0o600 });
  core.setOutput('scope-flags', JSON.stringify(result.flags));
  core.setOutput('scope-flag-count', String(result.flags.length));
  console.log(`Scope check: ${changed.files.length} changed file(s), ${result.flags.length} flagged, ${result.requested.length} requested${result.incomplete ? `, incomplete (${result.incomplete})` : ''}.`);

  const section = renderScopeSection(result);
  const isPr = env.IS_PR === 'true';

  // Issue-triggered runs: reviewers work on the PR, so post the section there.
  if (section && !isPr && prNumber) {
    const sessionId = latestSessionId(runnerTemp, runnerId);
    const marker = `<!-- netlify-agent-scope:${runnerId}:${sessionId.replace(/[^A-Za-z0-9_-]/g, '')} -->`;
    try {
      const existing = await github.paginate(github.rest.issues.listComments, { ...repo, issue_number: prNumber, per_page: 100 });
      const already = existing.some((/** @type {{ body?: string }} */ comment) => String(comment.body || '').includes(marker));
      if (!already) {
        const issueRef = env.ISSUE_NUMBER ? ` (from #${env.ISSUE_NUMBER})` : '';
        await github.rest.issues.createComment({
          ...repo,
          issue_number: prNumber,
          body: `${section}\nPosted by the Netlify Agent Runners scope check for this run${issueRef}.\n\n${marker}`,
        });
      }
    } catch (error) {
      core.warning(`Couldn't post the scope section on PR #${prNumber}: ${/** @type {Error} */ (error).message}`);
    }
  }

  if (result.flags.length === 0) return;

  if (actions.includes('label')) {
    const target = prNumber || Number(env.ISSUE_NUMBER || 0);
    if (target) {
      try {
        try {
          await github.rest.issues.createLabel({ ...repo, ...REVIEW_LABEL });
        } catch (_) {
          // Label already exists.
        }
        await github.rest.issues.addLabels({ ...repo, issue_number: target, labels: [REVIEW_LABEL.name] });
      } catch (error) {
        core.warning(`Couldn't apply the ${REVIEW_LABEL.name} label: ${/** @type {Error} */ (error).message}`);
      }
    }
  }

  if (actions.includes('draft') && landingKind === 'pr-created' && prNumber) {
    try {
      const pr = await github.rest.pulls.get({ ...repo, pull_number: prNumber });
      if (pr.data.state === 'open' && !pr.data.draft) {
        await github.graphql(
          'mutation($id: ID!) { convertPullRequestToDraft(input: { pullRequestId: $id }) { pullRequest { isDraft } } }',
          { id: pr.data.node_id },
        );
        summary(`- Converted PR #${prNumber} to a draft (scope check).`);
      }
    } catch (error) {
      core.warning(`Couldn't convert PR #${prNumber} to a draft: ${/** @type {Error} */ (error).message}`);
      summary(`- Draft conversion failed for PR #${prNumber}: ${/** @type {Error} */ (error).message}`);
    }
  }
};

module.exports.parseActions = parseActions;
module.exports.prNumberFromUrl = prNumberFromUrl;
module.exports.REVIEW_LABEL = REVIEW_LABEL;
