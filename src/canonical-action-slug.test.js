const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const REPO_ROOT = path.join(__dirname, '..');
const CANONICAL_SLUG = 'netlify-labs/agent-runner-action@v1';
const PUBLIC_CONSUMER_FILES = [
  'README.md',
  'docs/index.html',
  'example-workflow.yml',
  'workflow-templates/netlify-agents.yml',
];
const DISALLOWED_SLUGS = [
  'netlify/agent-runner@v1',
  'netlify/agent-runner-action@v1',
  'netlify-labs/agent-runner-action@main',
];

describe('canonical action slug in public docs/examples', () => {
  for (const relativePath of PUBLIC_CONSUMER_FILES) {
    it(`${relativePath} uses canonical action slug`, () => {
      const filePath = path.join(REPO_ROOT, relativePath);
      const body = fs.readFileSync(filePath, 'utf8');

      assert.ok(
        body.includes(CANONICAL_SLUG),
        `${relativePath} must include canonical slug: ${CANONICAL_SLUG}`
      );

      for (const slug of DISALLOWED_SLUGS) {
        assert.ok(
          !body.includes(slug),
          `${relativePath} includes disallowed slug: ${slug}`
        );
      }
    });
  }
});
