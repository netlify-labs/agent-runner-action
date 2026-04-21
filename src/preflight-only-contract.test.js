const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const REPO_ROOT = path.join(__dirname, '..');
const CONTRACT_PATH = path.join(REPO_ROOT, 'docs', 'plans', 'preflight-only-contract.md');
const CHECKLIST_PATH = path.join(REPO_ROOT, 'docs', 'plans', 'example-repo-verification-checklist.md');

const contractBody = fs.readFileSync(CONTRACT_PATH, 'utf8');
const checklistBody = fs.readFileSync(CHECKLIST_PATH, 'utf8');

describe('preflight-only public contract', () => {
  it('locks all required decision points', () => {
    const requiredStatements = [
      '`preflight-only` is a public input.',
      '`dry-run` semantics do not change.',
      'If both `dry-run=true` and `preflight-only=true`, preflight-only wins.',
      '`failure-category` becomes a formal output.',
      'Do not create issue or PR comments for `workflow_dispatch` preflight runs.',
      'On preflight failure:',
    ];

    for (const statement of requiredStatements) {
      assert.ok(
        contractBody.includes(statement),
        `missing contract statement: ${statement}`
      );
    }
  });

  it('keeps workflow-dispatch preflight expectations explicit in verification checklist', () => {
    assert.ok(
      checklistBody.includes('Because this is `workflow_dispatch`, no status comment is expected.'),
      'checklist should define dispatch preflight comment behavior'
    );
    assert.ok(
      checklistBody.includes('Because this is `workflow_dispatch`, no issue/PR comment is expected.'),
      'checklist should define dispatch failure comment behavior'
    );
  });
});
