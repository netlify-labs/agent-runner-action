const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { parseWorkflowRef, checkWorkflowFile } = require('./workflow-notice');

function core() {
  const warnings = /** @type {string[]} */ ([]);
  const summary = /** @type {string[]} */ ([]);
  return { warnings, summaryText: summary, warning: (/** @type {string} */ m) => warnings.push(m), info: () => {}, summary: { addRaw: (/** @type {string} */ t) => { summary.push(t); return { write: async () => {} }; } } };
}
const github = (/** @type {string | Error} */ file) => ({
  rest: { repos: { getContent: async (/** @type {any} */ params) => {
    if (file instanceof Error) throw file;
    assert.equal(params.path, '.github/workflows/netlify-agents.yml');
    return { data: { content: Buffer.from(file).toString('base64') } };
  } } },
});
const context = { repo: { owner: 'o', repo: 'r' } };
const env = { GITHUB_WORKFLOW_REF: 'o/r/.github/workflows/netlify-agents.yml@refs/heads/main', GITHUB_WORKFLOW_SHA: 'abc' };

describe('workflow notices', () => {
  it('parses GITHUB_WORKFLOW_REF', () => {
    assert.deepEqual(parseWorkflowRef(env.GITHUB_WORKFLOW_REF), { path: '.github/workflows/netlify-agents.yml', ref: 'refs/heads/main' });
    assert.equal(parseWorkflowRef('nonsense'), null);
  });
  it('warns (annotation + summary) when the stop-aware group is missing', async () => {
    const c = core();
    assert.deepEqual(await checkWorkflowFile({ github: github('concurrency:\n  group: netlify-x\n'), context, core: c, env }), ['stop-concurrency']);
    assert.match(c.warnings[0], /stop-aware concurrency group/);
    assert.equal(c.summaryText.length, 1);
  });
  it('stays quiet for an up-to-date workflow or when the file cannot be read', async () => {
    const c = core();
    assert.deepEqual(await checkWorkflowFile({ github: github("format('netlify-stop-{0}', github.run_id)"), context, core: c, env }), []);
    assert.deepEqual(await checkWorkflowFile({ github: github(new Error('403')), context, core: c, env }), []);
    assert.deepEqual(await checkWorkflowFile({ github: github('x'), context, core: c, env: {} }), []);
    assert.deepEqual(c.warnings, []);
  });
});
