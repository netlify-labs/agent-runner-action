const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ACTION_PATH = path.join(__dirname, '..', 'action.yml');
const actionYml = fs.readFileSync(ACTION_PATH, 'utf8');

// ---------------------------------------------------------------------------
// Helpers — lightweight YAML parsing for the patterns we care about
// ---------------------------------------------------------------------------

/** Extract all `steps.X.outputs.Y` references from the file */
function extractStepOutputRefs(text) {
  const refs = [];
  const pattern = /steps\.([a-z_-]+)\.outputs\.([a-z_-]+)/gi;
  let m;
  while ((m = pattern.exec(text)) !== null) {
    refs.push({ step: m[1], output: m[2], raw: m[0] });
  }
  return refs;
}

/** Extract all step IDs (lines like `      id: foo`) */
function extractStepIds(text) {
  const ids = new Set();
  for (const m of text.matchAll(/^\s+id:\s*([a-z_-]+)/gim)) {
    ids.add(m[1]);
  }
  return ids;
}

/** Extract all declared input names */
function extractInputNames(text) {
  const names = new Set();
  const inputsSection = text.match(/^inputs:\n([\s\S]*?)^(?:outputs:|runs:)/m);
  if (inputsSection) {
    for (const m of inputsSection[1].matchAll(/^\s{2}([a-z_-]+):/gim)) {
      names.add(m[1]);
    }
  }
  return names;
}

/** Extract all `inputs.X` references from the file */
function extractInputRefs(text) {
  const refs = [];
  for (const m of text.matchAll(/inputs\.([a-z_-]+)/gi)) {
    refs.push(m[1]);
  }
  return refs;
}

/** Extract all declared output names */
function extractOutputNames(text) {
  const names = new Set();
  const outputsSection = text.match(/^outputs:\n([\s\S]*?)^runs:/m);
  if (outputsSection) {
    for (const m of outputsSection[1].matchAll(/^\s{2}([a-z_-]+):/gim)) {
      names.add(m[1]);
    }
  }
  return names;
}

/** Extract all require() paths referencing ACTION_DIR */
function extractRequirePaths(text) {
  const paths = [];
  for (const m of text.matchAll(/require\(`\$\{process\.env\.ACTION_DIR\}\/([^`]+)`\)/g)) {
    paths.push(m[1]);
  }
  return paths;
}

/** Extract rough YAML blocks for composite action steps. */
function extractStepBlocks(text) {
  return text
    .split(/\n(?=\s{4}- name: )/)
    .filter(block => block.trim().startsWith('- name:') || block.includes('\n    - name:'));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('action.yml wiring', () => {
  it('action.yml exists and is non-empty', () => {
    assert.ok(actionYml.length > 100, 'action.yml should be non-trivial');
  });

  it('all step output references point to existing step IDs', () => {
    const stepIds = extractStepIds(actionYml);
    const refs = extractStepOutputRefs(actionYml);
    const missing = refs.filter(r => !stepIds.has(r.step));
    assert.deepEqual(
      missing.map(r => r.raw),
      [],
      `Found references to non-existent step IDs: ${missing.map(r => r.raw).join(', ')}`
    );
  });

  it('all input references match declared inputs', () => {
    const declared = extractInputNames(actionYml);
    const refs = extractInputRefs(actionYml);
    const missing = refs.filter(r => !declared.has(r));
    // Deduplicate
    const unique = [...new Set(missing)];
    assert.deepEqual(
      unique,
      [],
      `Found references to undeclared inputs: ${unique.join(', ')}`
    );
  });

  it('all declared outputs reference existing steps', () => {
    const stepIds = extractStepIds(actionYml);
    const outputRefs = extractStepOutputRefs(actionYml);
    // Filter to only refs in the outputs: section
    const outputsSection = actionYml.match(/^outputs:\n([\s\S]*?)^runs:/m);
    if (!outputsSection) return;
    const outputStepRefs = extractStepOutputRefs(outputsSection[1]);
    const missing = outputStepRefs.filter(r => !stepIds.has(r.step));
    assert.deepEqual(
      missing.map(r => r.raw),
      [],
      `Output references non-existent step: ${missing.map(r => r.raw).join(', ')}`
    );
  });

  it('all require() paths resolve to existing files', () => {
    const requirePaths = extractRequirePaths(actionYml);
    assert.ok(requirePaths.length > 0, 'Should have at least one require() path');
    const actionDir = path.dirname(ACTION_PATH);
    for (const p of requirePaths) {
      const fullPath = path.join(actionDir, p);
      assert.ok(
        fs.existsSync(fullPath),
        `require() references missing file: ${p} (expected at ${fullPath})`
      );
    }
  });

  it('quotes expression env values that include hash placeholders', () => {
    const unquoted = [];
    for (const line of actionYml.split(/\r?\n/)) {
      const match = line.match(/^\s+([A-Z0-9_]+):\s+(.+)$/);
      if (!match) continue;

      const [, name, rawValue] = match;
      const value = rawValue.trim();
      if (!value.includes('${{') || !value.includes('#{')) continue;

      const isQuoted =
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"));
      if (!isQuoted) unquoted.push(`${name}: ${value}`);
    }

    assert.deepEqual(
      unquoted,
      [],
      `GitHub expressions containing # placeholders must be YAML-quoted: ${unquoted.join(', ')}`
    );
  });

  it('passes custom github-token to all peter-evans comment helper actions', () => {
    const commentHelperBlocks = extractStepBlocks(actionYml)
      .filter(block => block.includes('uses: peter-evans/'));

    assert.ok(commentHelperBlocks.length > 0, 'Expected peter-evans comment helper steps');
    for (const block of commentHelperBlocks) {
      assert.match(
        block,
        /token:\s+\$\{\{\s*inputs\.github-token\s*\}\}/,
        `Comment helper step must pass inputs.github-token:\n${block}`
      );
    }
  });

  it('does not hard-code sticky comment discovery to github-actions bot', () => {
    assert.equal(
      actionYml.includes("comment-author: 'github-actions[bot]'"),
      false,
      'Sticky comment discovery must work with GitHub App/custom token authors'
    );
  });

  it('uses pull request review comment reaction endpoints for review comments', () => {
    assert.match(actionYml, /createForPullRequestReviewComment/);
    assert.match(actionYml, /deleteForPullRequestComment/);
    assert.match(actionYml, /reaction-target', 'review-comment'/);
  });

  it('wires Netlify site access into preflight checks', () => {
    assert.match(actionYml, /checkSiteResolution:\s+async/);
    assert.match(actionYml, /https:\/\/api\.netlify\.com\/api\/v1\/sites/);
    assert.match(actionYml, /Netlify site access confirmed/);
  });

  it('fails the run when post-agent commit or PR creation fails', () => {
    assert.match(actionYml, /COMMIT_FAILURE=""/);
    assert.match(actionYml, /emit_failure_context "commit" "commit-to-branch-failed"/);
    assert.match(actionYml, /emit_failure_context "create-pr" "pull-request-create-failed"/);
    assert.match(actionYml, /echo "outcome=failure" >> \$GITHUB_OUTPUT/);
  });

  it('generates rich error comments even after the agent step fails', () => {
    const errorCommentBlock = extractStepBlocks(actionYml)
      .find(block => block.includes('- name: Generate error comment'));
    assert.ok(errorCommentBlock, 'Generate error comment step should exist');
    assert.match(errorCommentBlock, /always\(\)/);
  });

  it('has at least the expected inputs', () => {
    const inputs = extractInputNames(actionYml);
    const expected = [
      'netlify-auth-token',
      'netlify-site-id',
      'github-token',
      'default-agent',
      'default-model',
      'timeout-minutes',
      'debug',
      'dry-run',
      'preflight-only',
    ];
    for (const name of expected) {
      assert.ok(inputs.has(name), `Missing expected input: ${name}`);
    }
  });

  it('has at least the expected outputs', () => {
    const outputs = extractOutputNames(actionYml);
    const expected = [
      'agent-id',
      'outcome',
      'agent',
      'model',
      'trigger-text',
      'is-pr',
      'issue-number',
      'preflight-ok',
      'preflight-json',
      'preflight-summary',
      'should-continue',
      'failure-category',
      'failure-stage',
      'agent-error',
    ];
    for (const name of expected) {
      assert.ok(outputs.has(name), `Missing expected output: ${name}`);
    }
  });

  it('all src/*.js modules required by action.yml are valid Node modules', () => {
    const requirePaths = extractRequirePaths(actionYml);
    const actionDir = path.dirname(ACTION_PATH);
    for (const p of requirePaths) {
      const fullPath = path.join(actionDir, p);
      // Verify the module loads without error
      assert.doesNotThrow(
        () => require(fullPath),
        `Module fails to load: ${p}`
      );
    }
  });
});
