// Attach the pull request's diff to the Agent Runner session as a file.
//
// The runner's checkout is a blobless partial clone: history is there, but the
// base side's file contents are fetched from GitHub on demand. Ask-mode runners
// have no network, so `git diff base...head` fails inside them ("could not fetch
// ... from promisor remote"). The action has a full clone, so it writes the diff
// and uploads it; the runner places attachments under .netlify/assets/.

const fs = require('node:fs');
const path = require('node:path');
const { fetchWithRetry } = require('./fetch-retry');

const API_BASE = 'https://api.netlify.com/api/v1';
// Bigger diffs are skipped: an agent can't use them, and uploads get slow.
const MAX_DIFF_BYTES = 10 * 1024 * 1024;

/**
 * @param {string} filePath
 * @returns {{ ok: true, bytes: number } | { ok: false, reason: string }}
 */
function checkDiffFile(filePath) {
  if (!filePath) return { ok: false, reason: 'no diff file' };
  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch {
    return { ok: false, reason: 'diff file not found' };
  }
  if (stat.size === 0) return { ok: false, reason: 'diff is empty' };
  if (stat.size > MAX_DIFF_BYTES) {
    return { ok: false, reason: `diff is ${stat.size} bytes, over the ${MAX_DIFF_BYTES}-byte limit` };
  }
  return { ok: true, bytes: stat.size };
}

/**
 * Upload a file to the Agent Runner attachment store and return its file key.
 * @param {{ token: string, siteId: string, filePath: string, fetchImpl?: typeof fetch, log?: (message: string) => void }} params
 * @returns {Promise<string>}
 */
async function uploadAttachment({ token, siteId, filePath, fetchImpl = fetch, log = () => {} }) {
  const auth = { Authorization: `Bearer ${token}` };
  const retry = { fetchImpl, log };

  const siteResponse = await fetchWithRetry(`${API_BASE}/sites/${encodeURIComponent(siteId)}`, { headers: auth }, retry);
  if (!siteResponse.ok) throw new Error(`site lookup failed (HTTP ${siteResponse.status})`);
  const site = /** @type {{ account_id?: string }} */ (await siteResponse.json());
  if (!site.account_id) throw new Error('site lookup returned no account_id');

  const query = new URLSearchParams({
    account_id: site.account_id,
    filename: path.basename(filePath),
    content_type: 'text/plain',
  });
  const urlResponse = await fetchWithRetry(`${API_BASE}/agent_runners/upload_url?${query}`, { method: 'POST', headers: auth }, retry);
  if (!urlResponse.ok) throw new Error(`upload URL request failed (HTTP ${urlResponse.status})`);
  const upload = /** @type {{ upload_url?: string, file_key?: string }} */ (await urlResponse.json());
  if (!upload.upload_url || !upload.file_key) throw new Error('upload URL response is missing upload_url or file_key');

  const putResponse = await fetchWithRetry(upload.upload_url, {
    method: 'PUT',
    headers: { 'Content-Type': 'text/plain' },
    body: fs.readFileSync(filePath),
  }, retry);
  if (!putResponse.ok) throw new Error(`upload failed (HTTP ${putResponse.status})`);
  return upload.file_key;
}

/**
 * Prompt note telling the agent where the diff is and not to use git diff.
 * @param {string} filename
 * @param {string} baseRef
 * @returns {string}
 */
function diffAttachmentNote(filename, baseRef) {
  const range = baseRef ? `origin/${baseRef}...HEAD` : 'base...head';
  return `\n\n---\nThe full pull request diff (\`git diff ${range}\`) is attached as \`${filename}\` `
    + 'in this session\'s attachments directory (.netlify/assets/). Read the diff from that file: '
    + '`git diff` against the base branch does not work in this runner.';
}

/**
 * Upload the PR diff if there is one. Never throws: a failed attachment only
 * means the agent works without it.
 * @param {{ token: string, siteId: string, diffPath: string, baseRef: string, fetchImpl?: typeof fetch, log?: (message: string) => void }} params
 * @returns {Promise<{ fileKeys: string[], note: string }>}
 */
async function attachPrDiff({ token, siteId, diffPath, baseRef, fetchImpl = fetch, log = () => {} }) {
  const none = { fileKeys: [], note: '' };
  if (!diffPath) return none;
  const check = checkDiffFile(diffPath);
  if (!check.ok) {
    log(`PR diff not attached: ${check.reason}.`);
    return none;
  }
  try {
    const fileKey = await uploadAttachment({ token, siteId, filePath: diffPath, fetchImpl, log });
    const filename = path.basename(diffPath);
    log(`Attached PR diff ${filename} (${check.bytes} bytes).`);
    return { fileKeys: [fileKey], note: diffAttachmentNote(filename, baseRef) };
  } catch (error) {
    log(`PR diff not attached: ${/** @type {Error} */ (error).message}.`);
    return none;
  }
}

module.exports = { attachPrDiff, uploadAttachment, checkDiffFile, diffAttachmentNote, MAX_DIFF_BYTES };
