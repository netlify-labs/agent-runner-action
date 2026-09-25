const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const checkRunScope = require('./check-run-scope');
const { parseActions, prNumberFromUrl, REVIEW_LABEL } = checkRunScope;
const { buildScopeBlock } = require('./utils');

let tempDir;
beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scope-step-'));
  fs.writeFileSync(path.join(tempDir, 'agent-sessions-runner1.json'), JSON.stringify([{ id: 'session1' }]));
});
afterEach(() => fs.rmSync(tempDir, { recursive: true, force: true }));

/**
 * Fake github-script client with PR files, base contents, comments, labels.
 * @param {{ prFiles?: any[], commitFiles?: any[], baseTopLevel?: string[], existingComments?: any[], prState?: { state: string, draft: boolean }, graphqlError?: Error }} options
 */
function fakeGithub(options = {}) {
  const calls = /** @type {Array<[string, any]>} */ ([]);
  const record = (/** @type {string} */ name, /** @type {any} */ value) => calls.push([name, value]);
  const github = {
    calls,
    paginate: async (/** @type {any} */ fn, /** @type {any} */ params) => (await fn(params)).data,
    graphql: async (/** @type {string} */ query, /** @type {any} */ vars) => {
      record('graphql', vars);
      if (options.graphqlError) throw options.graphqlError;
      return {};
    },
    rest: {
      pulls: {
        listFiles: async (/** @type {any} */ params) => { record('listFiles', params); return { data: params.page === 1 ? (options.prFiles || []) : [] }; },
        get: async (/** @type {any} */ params) => { record('pulls.get', params); return { data: { node_id: 'PR_node', ...(options.prState || { state: 'open', draft: false }) } }; },
      },
      repos: {
        getCommit: async (/** @type {any} */ params) => { record('getCommit', params); return { data: { files: params.page === 1 ? (options.commitFiles || []) : [] } }; },
        getContent: async (/** @type {any} */ params) => {
          record('getContent', params);
          if ((options.baseTopLevel || []).includes(params.path)) return { data: {} };
          const error = /** @type {Error & { status?: number }} */ (new Error('Not Found'));
          error.status = 404;
          throw error;
        },
      },
      issues: {
        listComments: async () => ({ data: options.existingComments || [] }),
        createComment: async (/** @type {any} */ params) => { record('createComment', params); return { data: { id: 1 } }; },
        createLabel: async (/** @type {any} */ params) => { record('createLabel', params); return { data: {} }; },
        addLabels: async (/** @type {any} */ params) => { record('addLabels', params); return { data: {} }; },
      },
    },
  };
  return github;
}

function fakeCore() {
  /** @type {Record<string, string>} */
  const outputs = {};
  /** @type {string[]} */
  const warnings = [];
  return { outputs, warnings, setOutput: (/** @type {string} */ k, /** @type {string} */ v) => { outputs[k] = v; }, warning: (/** @type {string} */ m) => { warnings.push(m); } };
}

const context = { repo: { owner: 'o', repo: 'r' } };
/** @param {Record<string, string>} overrides */
const env = (overrides) => ({
  AGENT_ID: 'runner1',
  RUNNER_TEMP: tempDir,
  PROTECTED_PATHS: 'default',
  FLAG_NEW_TOP_LEVEL: 'true',
  PROTECTED_PATHS_ACTION: 'comment',
  IS_PR: 'false',
  ISSUE_NUMBER: '53',
  BASE_REF: 'master',
  TRIGGER_TEXT: '@netlify fable high Create docs/agent-runner-fable-smoke-test.md',
  ...overrides,
});

const FABLE_PR_FILES = [
  { filename: 'docs/agent-runner-fable-smoke-test.md', status: 'added' },
  { filename: 'netlify.toml', status: 'added' },
  { filename: 'netlify/publish/index.html', status: 'added' },
  { filename: 'redwood.toml', status: 'added' },
];

describe('checkRunScope', () => {
  it('flags a new PR, writes the result file, and posts the section on the PR', async () => {
    const github = fakeGithub({ prFiles: FABLE_PR_FILES, baseTopLevel: ['docs'] });
    const core = fakeCore();
    await checkRunScope({ github, context, core, env: env({ LANDING_KIND: 'pr-created', AGENT_PR_URL: 'https://github.com/o/r/pull/54' }) });
    assert.equal(core.outputs['scope-flag-count'], '3');
    const saved = JSON.parse(fs.readFileSync(path.join(tempDir, 'agent-scope-runner1.json'), 'utf8'));
    assert.deepEqual(saved.flags.map((/** @type {any} */ flag) => flag.path), ['netlify.toml', 'redwood.toml', 'netlify/']);
    const comment = github.calls.find(([name]) => name === 'createComment');
    assert.ok(comment, 'PR comment posted');
    assert.equal(comment[1].issue_number, 54);
    assert.match(comment[1].body, /Review these changes/);
    assert.match(comment[1].body, /<!-- netlify-agent-scope:runner1:session1 -->$/);
    assert.match(comment[1].body, /\(from #53\)/);
  });

  it('does not post twice for the same run', async () => {
    const github = fakeGithub({ prFiles: FABLE_PR_FILES, existingComments: [{ body: 'x\n<!-- netlify-agent-scope:runner1:session1 -->' }] });
    await checkRunScope({ github, context, core: fakeCore(), env: env({ LANDING_KIND: 'pr-created', AGENT_PR_URL: 'https://github.com/o/r/pull/54' }) });
    assert.equal(github.calls.filter(([name]) => name === 'createComment').length, 0);
  });

  it('posts nothing on the PR for PR-triggered runs (the result comment is already there)', async () => {
    const github = fakeGithub({ commitFiles: [{ filename: 'AGENTS.md', status: 'modified' }] });
    const core = fakeCore();
    await checkRunScope({ github, context, core, env: env({ IS_PR: 'true', LANDING_KIND: 'commit', AGENT_COMMIT_SHA: 'abc', AGENT_PR_URL: 'https://github.com/o/r/pull/9' }) });
    assert.equal(core.outputs['scope-flag-count'], '1');
    assert.equal(github.calls.filter(([name]) => name === 'createComment').length, 0);
    assert.equal(github.calls.find(([name]) => name === 'getCommit')?.[1].ref, 'abc');
  });

  it('uses the dry-run diff file when nothing landed', async () => {
    fs.writeFileSync(path.join(tempDir, 'agent-scope-files-runner1.json'), JSON.stringify({ files: [{ path: 'pnpm-lock.yaml', status: 'modified' }], complete: true }));
    const github = fakeGithub();
    const core = fakeCore();
    await checkRunScope({ github, context, core, env: env({ IS_DRY_RUN: 'true', LANDING_KIND: 'none' }) });
    assert.equal(core.outputs['scope-flag-count'], '1');
    assert.equal(github.calls.filter(([name]) => name === 'listFiles' || name === 'getCommit').length, 0);
  });

  it('skips when nothing landed and there is no diff, or when disabled', async () => {
    const core = fakeCore();
    await checkRunScope({ github: fakeGithub(), context, core, env: env({ LANDING_KIND: 'none' }) });
    assert.equal(core.outputs['scope-flag-count'], '0');
    assert.ok(!fs.existsSync(path.join(tempDir, 'agent-scope-runner1.json')));
    const disabled = fakeGithub({ prFiles: FABLE_PR_FILES });
    await checkRunScope({ github: disabled, context, core: fakeCore(), env: env({ PROTECTED_PATHS: 'none', FLAG_NEW_TOP_LEVEL: 'false', LANDING_KIND: 'pr-created', AGENT_PR_URL: 'https://github.com/o/r/pull/54' }) });
    assert.equal(disabled.calls.length, 0);
  });

  it('applies the label and converts a PR this run opened to draft', async () => {
    const github = fakeGithub({ prFiles: FABLE_PR_FILES, baseTopLevel: ['docs', 'netlify'] });
    await checkRunScope({ github, context, core: fakeCore(), env: env({ LANDING_KIND: 'pr-created', AGENT_PR_URL: 'https://github.com/o/r/pull/54', PROTECTED_PATHS_ACTION: 'comment,label,draft' }) });
    assert.deepEqual(github.calls.find(([name]) => name === 'addLabels')?.[1], { owner: 'o', repo: 'r', issue_number: 54, labels: [REVIEW_LABEL.name] });
    assert.deepEqual(github.calls.find(([name]) => name === 'graphql')?.[1], { id: 'PR_node' });
  });

  it('never converts follow-up commits or already-draft PRs, and draft failures are warnings', async () => {
    const commitRun = fakeGithub({ commitFiles: [{ filename: 'netlify.toml', status: 'modified' }] });
    await checkRunScope({ github: commitRun, context, core: fakeCore(), env: env({ LANDING_KIND: 'commit', AGENT_COMMIT_SHA: 'abc', AGENT_PR_URL: 'https://github.com/o/r/pull/9', PROTECTED_PATHS_ACTION: 'draft' }) });
    assert.equal(commitRun.calls.filter(([name]) => name === 'graphql').length, 0);
    const alreadyDraft = fakeGithub({ prFiles: FABLE_PR_FILES, prState: { state: 'open', draft: true } });
    await checkRunScope({ github: alreadyDraft, context, core: fakeCore(), env: env({ LANDING_KIND: 'pr-created', AGENT_PR_URL: 'https://github.com/o/r/pull/54', PROTECTED_PATHS_ACTION: 'draft' }) });
    assert.equal(alreadyDraft.calls.filter(([name]) => name === 'graphql').length, 0);
    const failing = fakeGithub({ prFiles: FABLE_PR_FILES, graphqlError: new Error('Resource not accessible by integration') });
    const core = fakeCore();
    await checkRunScope({ github: failing, context, core, env: env({ LANDING_KIND: 'pr-created', AGENT_PR_URL: 'https://github.com/o/r/pull/54', PROTECTED_PATHS_ACTION: 'draft' }) });
    assert.match(core.warnings.join(' '), /Couldn't convert PR #54 to a draft: Resource not accessible/);
  });

  it('suppresses files the prompt names', async () => {
    const github = fakeGithub({ prFiles: [{ filename: 'netlify.toml', status: 'modified' }] });
    const core = fakeCore();
    await checkRunScope({ github, context, core, env: env({ LANDING_KIND: 'pr-created', AGENT_PR_URL: 'https://github.com/o/r/pull/5', TRIGGER_TEXT: '@netlify fix the redirect in netlify.toml' }) });
    assert.equal(core.outputs['scope-flag-count'], '0');
    const comment = github.calls.find(([name]) => name === 'createComment');
    assert.match(comment?.[1].body || '', /Protected files changed on request/);
  });

  it('ignores the appended scope block when deciding what the user asked for', async () => {
    const github = fakeGithub({ prFiles: [{ filename: 'netlify.toml', status: 'added' }] });
    const core = fakeCore();
    const trigger = `@netlify add a page${buildScopeBlock('Never touch netlify.toml')}`;
    await checkRunScope({ github, context, core, env: env({ LANDING_KIND: 'pr-created', AGENT_PR_URL: 'https://github.com/o/r/pull/5', TRIGGER_TEXT: trigger }) });
    assert.equal(core.outputs['scope-flag-count'], '1');
  });
});

describe('helpers', () => {
  it('parseActions always includes comment and drops unknown values', () => {
    assert.deepEqual(parseActions('label, draft, bogus'), ['label', 'draft', 'comment']);
    assert.deepEqual(parseActions(''), ['comment']);
  });

  it('prNumberFromUrl', () => {
    assert.equal(prNumberFromUrl('https://github.com/o/r/pull/54'), 54);
    assert.equal(prNumberFromUrl('https://github.com/o/r/pull/54/files'), 54);
    assert.equal(prNumberFromUrl(''), null);
  });
});
