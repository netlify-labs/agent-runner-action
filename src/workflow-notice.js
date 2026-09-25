// Upgrade notices for the caller's workflow file (logs and step summary only;
// never a comment). Reads the running workflow file and checks for settings
// newer action features rely on. A fetch failure is silently skipped.

const NOTICES = [
  {
    id: 'stop-concurrency',
    present: (/** @type {string} */ text) => text.includes('netlify-stop-'),
    message: 'Workflow file updates available: add the stop-aware concurrency group so `@netlify stop` runs right away instead of waiting behind the run it stops. See the "Run checkpoints and stopping" section of the README.',
  },
];

/**
 * "owner/repo/.github/workflows/file.yml@refs/heads/main" -> path and ref.
 * @param {string | undefined} workflowRef
 * @returns {{ path: string, ref: string } | null}
 */
function parseWorkflowRef(workflowRef) {
  const match = /^[^/]+\/[^/]+\/(\.github\/workflows\/[^@]+)@(.+)$/.exec(String(workflowRef || ''));
  return match ? { path: match[1], ref: match[2] } : null;
}

/**
 * @param {{ github: any, context: { repo: { owner: string, repo: string } }, core: { warning: (m: string, p?: any) => void, info: (m: string) => void, summary?: { addRaw: (t: string) => any } }, env?: Record<string, string | undefined> }} params
 * @returns {Promise<string[]>} ids of notices shown
 */
async function checkWorkflowFile({ github, context, core, env = process.env }) {
  const target = parseWorkflowRef(env.GITHUB_WORKFLOW_REF);
  if (!target) return [];
  let text = '';
  try {
    const { data } = await github.rest.repos.getContent({
      owner: context.repo.owner,
      repo: context.repo.repo,
      path: target.path,
      ref: env.GITHUB_WORKFLOW_SHA || target.ref,
    });
    text = data && typeof data.content === 'string' ? Buffer.from(data.content, 'base64').toString('utf8') : '';
  } catch (_) {
    return [];
  }
  if (!text) return [];
  const shown = [];
  for (const notice of NOTICES) {
    if (notice.present(text)) continue;
    core.warning(notice.message, { title: 'Workflow file updates available' });
    if (core.summary) await core.summary.addRaw(`${notice.message}\n`).write();
    shown.push(notice.id);
  }
  return shown;
}

module.exports = { NOTICES, parseWorkflowRef, checkWorkflowFile };
