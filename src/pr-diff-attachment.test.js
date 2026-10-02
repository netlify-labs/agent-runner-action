const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { attachPrDiff, checkDiffFile, diffAttachmentNote, MAX_DIFF_BYTES } = require('./pr-diff-attachment');

/** @param {number} status @param {unknown} [body] */
const response = (status, body = {}) => /** @type {any} */ ({
  status,
  ok: status >= 200 && status < 300,
  headers: { get: () => null },
  json: async () => body,
});

function writeDiff(contents) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-diff-'));
  const file = path.join(dir, 'pr-352.diff');
  fs.writeFileSync(file, contents);
  return file;
}

/** Fake Netlify API: site lookup, upload URL, then the signed PUT. */
function fakeApi({ site = 200, uploadUrl = 200, put = 200 } = {}) {
  /** @type {{ url: string, init: any }[]} */
  const calls = [];
  const fetchImpl = /** @type {any} */ (async (url, init = {}) => {
    calls.push({ url, init });
    if (url.includes('/sites/')) return response(site, { account_id: 'acct-1' });
    if (url.includes('/agent_runners/upload_url')) {
      return response(uploadUrl, { upload_url: 'https://storage.example/signed', file_key: 'user-uploaded-content/acct-1/x/pr-352.diff' });
    }
    return response(put);
  });
  return { calls, fetchImpl };
}

describe('attachPrDiff', () => {
  it('uploads the diff and returns its file key and a prompt note', async () => {
    const diffPath = writeDiff('diff --git a/a.txt b/a.txt\n');
    const api = fakeApi();
    const result = await attachPrDiff({ token: 't', siteId: 'site-1', diffPath, baseRef: 'main', fetchImpl: api.fetchImpl });

    assert.deepEqual(result.fileKeys, ['user-uploaded-content/acct-1/x/pr-352.diff']);
    assert.match(result.note, /attached as `pr-352\.diff`/);
    assert.match(result.note, /git diff origin\/main\.\.\.HEAD/);

    const upload = api.calls[1];
    assert.equal(upload.init.method, 'POST');
    const query = new URL(upload.url).searchParams;
    assert.equal(query.get('account_id'), 'acct-1');
    assert.equal(query.get('filename'), 'pr-352.diff');
    assert.equal(query.get('content_type'), 'text/plain');

    const put = api.calls[2];
    assert.equal(put.url, 'https://storage.example/signed');
    assert.equal(put.init.method, 'PUT');
    assert.equal(put.init.body.toString(), 'diff --git a/a.txt b/a.txt\n');
    assert.equal('Authorization' in put.init.headers, false, 'the Netlify token is not sent to the signed storage URL');
  });

  it('returns nothing when there is no diff path', async () => {
    const api = fakeApi();
    const result = await attachPrDiff({ token: 't', siteId: 's', diffPath: '', baseRef: 'main', fetchImpl: api.fetchImpl });
    assert.deepEqual(result, { fileKeys: [], note: '' });
    assert.equal(api.calls.length, 0);
  });

  it('skips an empty diff without calling the API', async () => {
    const api = fakeApi();
    const logs = [];
    const result = await attachPrDiff({ token: 't', siteId: 's', diffPath: writeDiff(''), baseRef: 'main', fetchImpl: api.fetchImpl, log: (m) => logs.push(m) });
    assert.deepEqual(result.fileKeys, []);
    assert.equal(api.calls.length, 0);
    assert.match(logs.join('\n'), /diff is empty/);
  });

  it('fails open when the upload fails', async () => {
    const api = fakeApi({ put: 403 });
    const logs = [];
    const result = await attachPrDiff({ token: 't', siteId: 's', diffPath: writeDiff('x'), baseRef: 'main', fetchImpl: api.fetchImpl, log: (m) => logs.push(m) });
    assert.deepEqual(result, { fileKeys: [], note: '' });
    assert.match(logs.join('\n'), /upload failed \(HTTP 403\)/);
  });

  it('fails open when the site lookup fails', async () => {
    const api = fakeApi({ site: 404 });
    const result = await attachPrDiff({ token: 't', siteId: 's', diffPath: writeDiff('x'), baseRef: 'main', fetchImpl: api.fetchImpl });
    assert.deepEqual(result.fileKeys, []);
    assert.equal(api.calls.length, 1);
  });
});

describe('checkDiffFile', () => {
  it('rejects missing and oversized files', () => {
    assert.equal(checkDiffFile('/nonexistent/pr.diff').ok, false);
    const big = writeDiff('');
    fs.truncateSync(big, MAX_DIFF_BYTES + 1);
    const result = checkDiffFile(big);
    assert.equal(result.ok, false);
    assert.match(/** @type {any} */ (result).reason, /over the/);
  });
});

describe('diffAttachmentNote', () => {
  it('falls back to a generic range without a base ref', () => {
    assert.match(diffAttachmentNote('pr.diff', ''), /git diff base\.\.\.head/);
  });
});
