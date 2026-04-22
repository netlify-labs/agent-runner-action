const fs = require('node:fs');
const path = require('node:path');

const CANONICAL_SLUG = 'netlify-labs/agent-runner-action@v1';
const DISALLOWED_SLUGS = [
  'netlify/agent-runner@v1',
  'netlify/agent-runner-action@v1',
  'netlify-labs/agent-runner-action@main',
];
const PUBLIC_EXAMPLE_FILES = [
  'README.md',
  'docs/index.html',
  'example-workflow.yml',
  'workflow-templates/netlify-agents.yml',
];
const WORKFLOW_FILES = [
  'example-workflow.yml',
  'workflow-templates/netlify-agents.yml',
];
const IMPORTANT_DEFAULT_INPUTS = [
  'default-agent',
  'dry-run',
  'timeout-minutes',
  'timezone',
];

/**
 * @typedef {{line: number}} OutputRow
 * @typedef {{defaultValue: string, line: number}} InputRow
 * @typedef {{body: string, startIndex: number}} SectionSlice
 * @typedef {{name: string, line: number}} WorkflowInputRef
 * @typedef {{rootDir?: string, fileOverrides?: Record<string, string>}} CheckDocsDriftOptions
 */

/**
 * @param {string} line
 * @returns {number}
 */
function leadingSpaces(line) {
  return line.length - line.trimStart().length;
}

/**
 * @param {string} text
 * @param {number} index
 * @returns {number}
 */
function lineNumberFromIndex(text, index) {
  return text.slice(0, Math.max(0, index)).split('\n').length;
}

/**
 * @param {string} text
 * @param {string} needle
 * @returns {number}
 */
function lineForNeedle(text, needle) {
  const idx = text.indexOf(needle);
  return idx === -1 ? 1 : lineNumberFromIndex(text, idx);
}

/**
 * @param {string} raw
 * @returns {string}
 */
function normalizeCell(raw) {
  return raw
    .replace(/<code>/g, '')
    .replace(/<\/code>/g, '')
    .replace(/&mdash;/g, '—')
    .replace(/`/g, '')
    .trim()
    .replace(/^['"]/, '')
    .replace(/['"]$/, '');
}

/**
 * @param {string} text
 * @param {string} startMarker
 * @param {string} endMarker
 * @returns {SectionSlice | null}
 */
function sectionSlice(text, startMarker, endMarker) {
  const start = text.indexOf(startMarker);
  if (start === -1) return null;
  const bodyStart = start + startMarker.length;
  const end = text.indexOf(endMarker, bodyStart);
  if (end === -1) return null;
  return { body: text.slice(bodyStart, end), startIndex: bodyStart };
}

/**
 * @param {string} actionYml
 * @returns {Map<string, InputRow>}
 */
function parseActionInputs(actionYml) {
  const section = sectionSlice(actionYml, 'inputs:\n', '\n# ---------------------------------------------------------------------------\n# Outputs');
  if (!section) return new Map();
  /** @type {Map<string, InputRow>} */
  const entries = new Map();
  const pattern = /^  ([a-z0-9-]+):\n((?: {4}.*\n?)*)/gm;
  let match;
  while ((match = pattern.exec(section.body)) !== null) {
    const [, name, block] = match;
    const defaultMatch = block.match(/^ {4}default:\s*(.+)$/m);
    const defaultValue = defaultMatch ? normalizeCell(defaultMatch[1]) : '';
    const absIndex = section.startIndex + match.index;
    entries.set(name, {
      defaultValue,
      line: lineNumberFromIndex(actionYml, absIndex),
    });
  }
  return entries;
}

/**
 * @param {string} actionYml
 * @returns {Map<string, OutputRow>}
 */
function parseActionOutputs(actionYml) {
  const section = sectionSlice(actionYml, 'outputs:\n', '\n# ---------------------------------------------------------------------------\n# Composite action steps');
  if (!section) return new Map();
  /** @type {Map<string, OutputRow>} */
  const entries = new Map();
  const pattern = /^  ([a-z0-9-]+):\n/gm;
  let match;
  while ((match = pattern.exec(section.body)) !== null) {
    const name = match[1];
    const absIndex = section.startIndex + match.index;
    entries.set(name, {
      line: lineNumberFromIndex(actionYml, absIndex),
    });
  }
  return entries;
}

/**
 * @param {string} readme
 * @returns {Map<string, InputRow>}
 */
function parseReadmeInputs(readme) {
  const section = sectionSlice(readme, '## Inputs\n\n', '\n## Outputs');
  if (!section) return new Map();
  /** @type {Map<string, InputRow>} */
  const entries = new Map();
  const pattern = /^\|\s*`([^`]+)`\s*\|\s*(Yes|No)\s*\|\s*([^|]+)\|\s*([^|]+)\|/gm;
  let match;
  while ((match = pattern.exec(section.body)) !== null) {
    const [, name, , defaultRaw] = match;
    const absIndex = section.startIndex + match.index;
    entries.set(name, {
      defaultValue: normalizeCell(defaultRaw),
      line: lineNumberFromIndex(readme, absIndex),
    });
  }
  return entries;
}

/**
 * @param {string} readme
 * @returns {Map<string, OutputRow>}
 */
function parseReadmeOutputs(readme) {
  const section = sectionSlice(readme, '## Outputs\n\n', '\n### Using outputs');
  if (!section) return new Map();
  /** @type {Map<string, OutputRow>} */
  const entries = new Map();
  const pattern = /^\|\s*`([^`]+)`\s*\|\s*([^|]+)\|/gm;
  let match;
  while ((match = pattern.exec(section.body)) !== null) {
    const [, name] = match;
    const absIndex = section.startIndex + match.index;
    entries.set(name, {
      line: lineNumberFromIndex(readme, absIndex),
    });
  }
  return entries;
}

/**
 * @param {string} html
 * @returns {Map<string, InputRow>}
 */
function parseDocsIndexInputs(html) {
  const sectionMatch = html.match(/<section id="inputs">([\s\S]*?)<\/section>/);
  if (!sectionMatch) return new Map();
  const sectionText = sectionMatch[1];
  const sectionStart = html.indexOf(sectionMatch[0]);
  /** @type {Map<string, InputRow>} */
  const entries = new Map();
  const pattern = /<tr><td><code>([^<]+)<\/code><\/td><td>[^<]*<\/td><td>([\s\S]*?)<\/td><td>[\s\S]*?<\/td><\/tr>/g;
  let match;
  while ((match = pattern.exec(sectionText)) !== null) {
    const [, name, defaultRaw] = match;
    const absIndex = sectionStart + match.index;
    entries.set(name, {
      defaultValue: normalizeCell(defaultRaw),
      line: lineNumberFromIndex(html, absIndex),
    });
  }
  return entries;
}

/**
 * @param {string} html
 * @returns {Map<string, OutputRow>}
 */
function parseDocsIndexOutputs(html) {
  const sectionMatch = html.match(/<section id="outputs">([\s\S]*?)<\/section>/);
  if (!sectionMatch) return new Map();
  const sectionText = sectionMatch[1];
  const sectionStart = html.indexOf(sectionMatch[0]);
  /** @type {Map<string, OutputRow>} */
  const entries = new Map();
  const pattern = /<tr><td><code>([^<]+)<\/code><\/td><td>[\s\S]*?<\/td><\/tr>/g;
  let match;
  while ((match = pattern.exec(sectionText)) !== null) {
    const name = match[1];
    const absIndex = sectionStart + match.index;
    entries.set(name, {
      line: lineNumberFromIndex(html, absIndex),
    });
  }
  return entries;
}

/**
 * @param {string} workflowBody
 * @returns {WorkflowInputRef[]}
 */
function extractActionInputReferences(workflowBody) {
  /** @type {WorkflowInputRef[]} */
  const refs = [];
  const lines = workflowBody.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    if (!lines[i].includes('uses: netlify-labs/agent-runner-action@')) continue;
    const usesIndent = leadingSpaces(lines[i]);
    let withIndent = -1;
    for (let j = i + 1; j < lines.length; j += 1) {
      const line = lines[j];
      const trimmed = line.trim();
      const indent = leadingSpaces(line);
      if (trimmed.length === 0) continue;
      if (indent <= usesIndent && !trimmed.startsWith('#')) break;
      if (/^\s*with:\s*$/.test(line)) {
        withIndent = indent;
        continue;
      }
      if (withIndent === -1) continue;
      if (indent <= withIndent && !trimmed.startsWith('#')) break;
      const keyMatch = line.match(/^\s*#?\s*([a-z0-9-]+):/i);
      if (keyMatch) {
        refs.push({ name: keyMatch[1], line: j + 1 });
      }
    }
  }
  return refs;
}

/**
 * @param {string[]} errors
 * @param {string} filePath
 * @param {string} content
 * @param {string} needle
 * @param {string} message
 * @returns {void}
 */
function checkContains(errors, filePath, content, needle, message) {
  if (content.includes(needle)) return;
  errors.push(`${filePath}:${lineForNeedle(content, needle)} ${message}`);
}

/**
 * @param {CheckDocsDriftOptions} [options]
 * @returns {string[]}
 */
function checkDocsDrift(options = {}) {
  const opts = /** @type {CheckDocsDriftOptions} */ (options);
  const rootDir = opts.rootDir || path.join(__dirname, '..');
  const fileOverrides = opts.fileOverrides || {};
  /**
   * @param {string} relativePath
   * @returns {string}
   */
  const read = (relativePath) => {
    if (Object.prototype.hasOwnProperty.call(fileOverrides, relativePath)) {
      return fileOverrides[relativePath];
    }
    return fs.readFileSync(path.join(rootDir, relativePath), 'utf8');
  };

  /** @type {string[]} */
  const errors = [];
  const actionYml = read('action.yml');
  const readme = read('README.md');
  const docsIndex = read('docs/index.html');
  const exampleWorkflow = read('example-workflow.yml');
  const templateWorkflow = read('workflow-templates/netlify-agents.yml');
  const ciWorkflow = read('.github/workflows/ci.yml');
  const packageJsonText = read('package.json');

  /** @type {{scripts?: Record<string, string>}} */
  let packageJson = {};
  try {
    packageJson = /** @type {{scripts?: Record<string, string>}} */ (JSON.parse(packageJsonText));
  } catch (_) {
    errors.push('package.json:1 package.json is not valid JSON');
  }

  const actionInputs = parseActionInputs(actionYml);
  const actionOutputs = parseActionOutputs(actionYml);
  const readmeInputs = parseReadmeInputs(readme);
  const readmeOutputs = parseReadmeOutputs(readme);
  const docsInputs = parseDocsIndexInputs(docsIndex);
  const docsOutputs = parseDocsIndexOutputs(docsIndex);

  for (const [inputName] of actionInputs) {
    if (!readmeInputs.has(inputName)) {
      const line = lineForNeedle(readme, '## Inputs');
      errors.push(`README.md:${line} Missing input \`${inputName}\` in README inputs table`);
    }
    if (!docsInputs.has(inputName)) {
      const line = lineForNeedle(docsIndex, '<section id="inputs">');
      errors.push(`docs/index.html:${line} Missing input \`${inputName}\` in docs inputs table`);
    }
  }

  for (const [outputName] of actionOutputs) {
    if (!readmeOutputs.has(outputName)) {
      const line = lineForNeedle(readme, '## Outputs');
      errors.push(`README.md:${line} Missing output \`${outputName}\` in README outputs table`);
    }
    if (!docsOutputs.has(outputName)) {
      const line = lineForNeedle(docsIndex, '<section id="outputs">');
      errors.push(`docs/index.html:${line} Missing output \`${outputName}\` in docs outputs table`);
    }
  }

  for (const key of IMPORTANT_DEFAULT_INPUTS) {
    const actionInput = actionInputs.get(key);
    if (!actionInput) continue;
    const expected = actionInput.defaultValue;
    const readmeRow = readmeInputs.get(key);
    const docsRow = docsInputs.get(key);
    if (readmeRow && readmeRow.defaultValue !== expected) {
      errors.push(`README.md:${readmeRow.line} Default mismatch for \`${key}\` (expected "${expected}", found "${readmeRow.defaultValue}")`);
    }
    if (docsRow && docsRow.defaultValue !== expected) {
      errors.push(`docs/index.html:${docsRow.line} Default mismatch for \`${key}\` (expected "${expected}", found "${docsRow.defaultValue}")`);
    }
  }

  for (const file of PUBLIC_EXAMPLE_FILES) {
    const body = read(file);
    if (!body.includes(CANONICAL_SLUG)) {
      errors.push(`${file}:${lineForNeedle(body, 'uses:')} Missing canonical slug ${CANONICAL_SLUG}`);
    }
    for (const badSlug of DISALLOWED_SLUGS) {
      if (body.includes(badSlug)) {
        errors.push(`${file}:${lineForNeedle(body, badSlug)} Disallowed slug found: ${badSlug}`);
      }
    }
  }

  const declaredInputNames = new Set(actionInputs.keys());
  for (const workflowFile of WORKFLOW_FILES) {
    const workflowBody = read(workflowFile);
    const refs = extractActionInputReferences(workflowBody);
    for (const ref of refs) {
      if (!declaredInputNames.has(ref.name)) {
        errors.push(`${workflowFile}:${ref.line} Example references undeclared action input \`${ref.name}\``);
      }
    }

    const requiredSnippets = [
      'concurrency:',
      'group: netlify-${{ github.repository }}-${{ github.event.pull_request.number || github.event.issue.number || github.run_id }}',
      'cancel-in-progress: false',
      'permissions:',
      'contents: write',
      'pull-requests: write',
      'issues: write',
    ];
    for (const snippet of requiredSnippets) {
      if (!workflowBody.includes(snippet)) {
        errors.push(`${workflowFile}:${lineForNeedle(workflowBody, 'jobs:')} Missing required workflow setting: ${snippet}`);
      }
    }

    for (const key of IMPORTANT_DEFAULT_INPUTS) {
      const actionInput = actionInputs.get(key);
      const expected = actionInput ? actionInput.defaultValue : '';
      if (!expected) continue;
      const needle = `${key}: '${expected}'`;
      if (!workflowBody.includes(needle)) {
        errors.push(`${workflowFile}:${lineForNeedle(workflowBody, 'Optional settings')} Missing default example for \`${key}\` (${needle})`);
      }
    }
  }

  if (actionInputs.has('preflight-only')) {
    const preflightNeedles = [
      { file: 'README.md', body: readme, needle: '`preflight-only`' },
      { file: 'docs/index.html', body: docsIndex, needle: '<code>preflight-only</code>' },
      { file: 'example-workflow.yml', body: exampleWorkflow, needle: 'preflight-only' },
      { file: 'workflow-templates/netlify-agents.yml', body: templateWorkflow, needle: 'preflight-only' },
    ];
    for (const entry of preflightNeedles) {
      if (!entry.body.includes(entry.needle)) {
        errors.push(`${entry.file}:${lineForNeedle(entry.body, 'Inputs')} Missing preflight-only mention after input was added`);
      }
    }
  }

  checkContains(
    errors,
    'package.json',
    packageJsonText,
    '"docs:check"',
    'package.json should define docs:check script'
  );
  if ((packageJson.scripts || {})['docs:check'] !== 'bun src/check-docs-drift.js') {
    errors.push(
      `package.json:${lineForNeedle(packageJsonText, '"docs:check"')} scripts.docs:check must be "bun src/check-docs-drift.js"`
    );
  }

  checkContains(
    errors,
    '.github/workflows/ci.yml',
    ciWorkflow,
    'bun run docs:check',
    'CI must run docs drift checker via docs:check script'
  );

  const requiredCiPathSnippets = [
    "docs/**",
    "workflow-templates/**",
    "example-workflow.yml",
    "README.md",
  ];
  for (const snippet of requiredCiPathSnippets) {
    if (!ciWorkflow.includes(snippet)) {
      errors.push(`.github/workflows/ci.yml:${lineForNeedle(ciWorkflow, 'paths:')} CI path filters should include ${snippet}`);
    }
  }

  return errors;
}

function runCli() {
  const errors = checkDocsDrift();
  if (errors.length === 0) {
    console.log('docs-drift: OK');
    return;
  }
  console.error('docs-drift: FAIL');
  for (const error of errors) {
    console.error(`- ${error}`);
  }
  process.exit(1);
}

if (require.main === module) {
  runCli();
}

module.exports = {
  checkDocsDrift,
};
