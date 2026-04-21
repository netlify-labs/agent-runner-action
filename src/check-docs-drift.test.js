const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { checkDocsDrift } = require('./check-docs-drift');

const ROOT = path.join(__dirname, '..');

function read(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
}

describe('check-docs-drift', () => {
  it('passes for the current repository state', () => {
    const errors = checkDocsDrift({ rootDir: ROOT });
    assert.deepEqual(errors, []);
  });

  it('detects canonical slug drift in README', () => {
    const readme = read('README.md');
    const brokenReadme = readme.replace(
      /netlify-labs\/agent-runner-action@v1/g,
      'netlify/agent-runner@v1'
    );
    const errors = checkDocsDrift({
      rootDir: ROOT,
      fileOverrides: { 'README.md': brokenReadme },
    });
    assert.ok(
      errors.some((error) => error.includes('README.md') && error.includes('Disallowed slug found')),
      'expected disallowed slug error'
    );
  });

  it('detects undeclared input references in example workflows', () => {
    const workflow = read('workflow-templates/netlify-agents.yml');
    const driftedWorkflow = workflow.replace(
      '# debug: \'false\'                # Enable debug logging',
      "          # imaginary-input: 'true'       # not declared\n          # debug: 'false'                # Enable debug logging"
    );
    const errors = checkDocsDrift({
      rootDir: ROOT,
      fileOverrides: { 'workflow-templates/netlify-agents.yml': driftedWorkflow },
    });
    assert.ok(
      errors.some((error) => error.includes('undeclared action input `imaginary-input`')),
      'expected undeclared input error'
    );
  });

  it('detects missing input documentation rows', () => {
    const readme = read('README.md');
    const driftedReadme = readme.replace(
      "| `dry-run` | No | `false` | Run the agent but skip commit/PR creation |\n",
      ''
    );
    const errors = checkDocsDrift({
      rootDir: ROOT,
      fileOverrides: { 'README.md': driftedReadme },
    });
    assert.ok(
      errors.some((error) => error.includes('Missing input `dry-run` in README inputs table')),
      'expected missing input documentation error'
    );
  });

  it('detects missing output documentation rows', () => {
    const docsIndex = read('docs/index.html');
    const driftedDocsIndex = docsIndex.replace(
      '    <tr><td><code>is-dry-run</code></td><td>Whether the run used preview mode (<code>true</code> / <code>false</code>)</td></tr>\n',
      ''
    );
    const errors = checkDocsDrift({
      rootDir: ROOT,
      fileOverrides: { 'docs/index.html': driftedDocsIndex },
    });
    assert.ok(
      errors.some((error) => error.includes('Missing output `is-dry-run` in docs outputs table')),
      'expected missing output documentation error'
    );
  });

  it('detects workflow template permissions drift', () => {
    const workflow = read('workflow-templates/netlify-agents.yml');
    const driftedWorkflow = workflow.replace('      issues: write\n', '');
    const errors = checkDocsDrift({
      rootDir: ROOT,
      fileOverrides: { 'workflow-templates/netlify-agents.yml': driftedWorkflow },
    });
    assert.ok(
      errors.some((error) => error.includes('Missing required workflow setting: issues: write')),
      'expected missing permissions error'
    );
  });

  it('detects missing docs:check script in package.json', () => {
    const packageJson = read('package.json');
    const driftedPackageJson = packageJson.replace(
      '    "docs:check": "bun src/check-docs-drift.js",\n',
      ''
    );
    const errors = checkDocsDrift({
      rootDir: ROOT,
      fileOverrides: { 'package.json': driftedPackageJson },
    });
    assert.ok(
      errors.some((error) => error.includes('package.json should define docs:check script')),
      'expected docs:check script error'
    );
  });

  it('detects CI that does not call docs:check script', () => {
    const ciWorkflow = read('.github/workflows/ci.yml');
    const driftedCi = ciWorkflow.replace('      - run: bun run docs:check\n', '');
    const errors = checkDocsDrift({
      rootDir: ROOT,
      fileOverrides: { '.github/workflows/ci.yml': driftedCi },
    });
    assert.ok(
      errors.some((error) => error.includes('CI must run docs drift checker via docs:check script')),
      'expected ci docs:check invocation error'
    );
  });
});
