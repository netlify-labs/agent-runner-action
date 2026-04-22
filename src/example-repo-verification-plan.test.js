const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const REPO_ROOT = path.join(__dirname, '..');
const CHECKLIST_PATH = path.join(REPO_ROOT, 'docs', 'plans', 'example-repo-verification-checklist.md');
const WORKFLOW_PATH = path.join(REPO_ROOT, 'docs', 'plans', 'example-repo-verification-workflow.yml');

const checklistBody = fs.readFileSync(CHECKLIST_PATH, 'utf8');
const workflowBody = fs.readFileSync(WORKFLOW_PATH, 'utf8');

describe('example repo branch verification artifacts', () => {
  it('workflow pins verification to dw/actions-updates and never to @main', () => {
    assert.match(
      workflowBody,
      /uses:\s+netlify-labs\/agent-runner-action@dw\/actions-updates/
    );
    assert.ok(
      !workflowBody.includes('uses: netlify-labs/agent-runner-action@main'),
      'workflow must not validate against @main'
    );
  });

  it('workflow records tested ref and resolved SHA in step summary metadata', () => {
    assert.ok(
      workflowBody.includes('ACTION_UNDER_TEST_REF: dw/actions-updates'),
      'workflow must declare the action ref under test'
    );
    assert.ok(
      workflowBody.includes('Resolved action commit SHA'),
      'workflow must capture the resolved action SHA'
    );
    assert.match(
      workflowBody,
      /do not repoint .*@main.*release tags during verification/i
    );
  });

  it('checklist covers required scenarios and rollback policy', () => {
    const requiredPhrases = [
      'Preflight-only success',
      'Invalid site ID failure',
      'Dry-run prompt',
      'Normal issue trigger',
      'PR follow-up trigger',
      'Failure path with readable summary/comment output',
      'Do not overwrite or repoint `@main` or any release tags during validation.',
      'Rollback Behavior',
    ];

    for (const phrase of requiredPhrases) {
      assert.ok(
        checklistBody.includes(phrase),
        `missing required checklist item: ${phrase}`
      );
    }
  });
});
