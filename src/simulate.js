#!/usr/bin/env node
// Local simulator CLI for fixture-driven action decision previews.
// Reuses scenario-harness logic so trigger/context/state behavior stays centralized.

const path = require('node:path');

const { loadFixtureJson, runScenario } = require('./scenario-harness');

/**
 * @typedef {'human' | 'json' | 'markdown'} OutputFormat
 */

/**
 * @typedef {'success' | 'failure' | 'timeout' | 'skipped' | 'unknown'} Outcome
 */

/**
 * @typedef {object} ParsedArgs
 * @property {string} fixturePath
 * @property {string} stateFixturePath
 * @property {OutputFormat} format
 * @property {boolean} help
 */

/**
 * @typedef {object} RunSimulationOptions
 * @property {string} fixturePath
 * @property {string} [stateFixturePath]
 * @property {string} [repoRoot]
 */

/**
 * @typedef {object} SimulationContext
 * @property {string} issueNumber
 * @property {string} prNumber
 * @property {boolean} isPr
 * @property {string} headRef
 * @property {string} baseRef
 * @property {string} headSha
 * @property {boolean} hasLinkedPr
 * @property {string} linkedPrNumber
 * @property {boolean} isDryRun
 */

/**
 * @typedef {object} SimulationReport
 * @property {string} scenarioName
 * @property {string} fixturePath
 * @property {string} stateFixturePath
 * @property {string} eventName
 * @property {string} decision
 * @property {Outcome} outcome
 * @property {boolean} shouldRun
 * @property {SimulationContext} context
 * @property {string} model
 * @property {string} prompt
 * @property {Record<string, unknown>} recoveredState
 * @property {string[]} warnings
 * @property {import('./contracts').FailureClassification[]} failures
 * @property {string[]} comments
 * @property {string} summary
 */

/**
 * @typedef {object} RunSimulationResult
 * @property {SimulationReport} report
 * @property {import('./contracts').ScenarioTrace} trace
 */

/**
 * @typedef {object} StateFixture
 * @property {Record<string, string | unknown>} [githubFixtures]
 * @property {Record<string, string | unknown>} [netlifyFixtures]
 * @property {Record<string, string | number | boolean>} [env]
 * @property {Record<string, string>} [seedOutputs]
 * @property {unknown} [statusCommentBody]
 * @property {unknown} [prBody]
 * @property {unknown} [linkedPrNumber]
 * @property {unknown} [existingRunnerId]
 * @property {unknown} [existingRunnerIdOutput]
 * @property {unknown} [existingSessionData]
 * @property {unknown} [existingSessionDataOutput]
 * @property {unknown} [outcome]
 */

/**
 * @typedef {object} CliIo
 * @property {{ write: (chunk: string) => unknown }} stdout
 * @property {{ write: (chunk: string) => unknown }} stderr
 */

class UsageError extends Error {
  /**
   * @param {string} message
   */
  constructor(message) {
    super(message);
    this.name = 'UsageError';
  }
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function toText(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (value instanceof Error) return `${value.name}: ${value.message}`;
  return String(value);
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/**
 * @returns {string}
 */
function usageText() {
  return [
    'Usage:',
    '  bun src/simulate.js --fixture <path> [--state-fixture <path>] [--format human|json|markdown]',
    '',
    'Options:',
    '  --fixture <path>          Event fixture JSON path (required)',
    '  --state-fixture <path>    Optional state fixture for runner recovery simulation',
    '  --format <value>          Output format: human (default), json, markdown',
    '  -h, --help                Show this help text',
  ].join('\n');
}

/**
 * @param {string} value
 * @returns {OutputFormat}
 */
function parseFormat(value) {
  const normalized = value.trim().toLowerCase();
  if (normalized === 'human' || normalized === 'json' || normalized === 'markdown') {
    return normalized;
  }
  throw new UsageError(`Invalid format "${value}". Expected human, json, or markdown.`);
}

/**
 * @param {string[]} argv
 * @returns {ParsedArgs}
 */
function parseArgs(argv) {
  /** @type {ParsedArgs} */
  const parsed = {
    fixturePath: '',
    stateFixturePath: '',
    format: 'human',
    help: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];

    if (arg === '-h' || arg === '--help') {
      parsed.help = true;
      continue;
    }

    if (arg === '--fixture') {
      const value = argv[i + 1];
      if (!value || value.startsWith('--')) {
        throw new UsageError('Missing value for --fixture.');
      }
      parsed.fixturePath = value;
      i += 1;
      continue;
    }

    if (arg.startsWith('--fixture=')) {
      const value = arg.slice('--fixture='.length);
      if (!value) throw new UsageError('Missing value for --fixture.');
      parsed.fixturePath = value;
      continue;
    }

    if (arg === '--state-fixture') {
      const value = argv[i + 1];
      if (!value || value.startsWith('--')) {
        throw new UsageError('Missing value for --state-fixture.');
      }
      parsed.stateFixturePath = value;
      i += 1;
      continue;
    }

    if (arg.startsWith('--state-fixture=')) {
      const value = arg.slice('--state-fixture='.length);
      if (!value) throw new UsageError('Missing value for --state-fixture.');
      parsed.stateFixturePath = value;
      continue;
    }

    if (arg === '--format') {
      const value = argv[i + 1];
      if (!value || value.startsWith('--')) {
        throw new UsageError('Missing value for --format.');
      }
      parsed.format = parseFormat(value);
      i += 1;
      continue;
    }

    if (arg.startsWith('--format=')) {
      const value = arg.slice('--format='.length);
      if (!value) throw new UsageError('Missing value for --format.');
      parsed.format = parseFormat(value);
      continue;
    }

    throw new UsageError(`Unknown argument: ${arg}`);
  }

  if (!parsed.help && parsed.fixturePath === '') {
    throw new UsageError('Missing required --fixture <path>.');
  }

  return parsed;
}

/**
 * @param {unknown} payload
 * @returns {string}
 */
function inferEventName(payload) {
  if (!isRecord(payload)) {
    throw new Error('Event fixture must be a JSON object.');
  }

  const hasInputs = isRecord(payload.inputs);
  const hasIssue = isRecord(payload.issue);
  const hasPullRequest = isRecord(payload.pull_request);
  const hasComment = isRecord(payload.comment);
  const hasReview = isRecord(payload.review);

  if (hasInputs) return 'workflow_dispatch';
  if (hasReview && hasPullRequest) return 'pull_request_review';
  if (hasComment && hasPullRequest && !hasIssue) return 'pull_request_review_comment';
  if (hasComment && hasIssue) return 'issue_comment';
  if (hasPullRequest) return 'pull_request_target';
  if (hasIssue) return 'issues';

  throw new Error('Unable to infer event type from fixture payload.');
}

/**
 * @param {unknown} value
 * @returns {Record<string, string | unknown>}
 */
function asFixtureMap(value) {
  if (!isRecord(value)) return {};
  /** @type {Record<string, string | unknown>} */
  const out = {};
  for (const [key, entry] of Object.entries(value)) {
    out[key] = entry;
  }
  return out;
}

/**
 * @param {unknown} value
 * @returns {Record<string, string | number | boolean>}
 */
function asEnvMap(value) {
  if (!isRecord(value)) return {};
  /** @type {Record<string, string | number | boolean>} */
  const out = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === 'string' || typeof entry === 'number' || typeof entry === 'boolean') {
      out[key] = entry;
    }
  }
  return out;
}

/**
 * @param {unknown} value
 * @returns {Record<string, string>}
 */
function asSeedOutputs(value) {
  if (!isRecord(value)) return {};
  /** @type {Record<string, string>} */
  const out = {};
  for (const [key, entry] of Object.entries(value)) {
    out[key] = toText(entry);
  }
  return out;
}

/**
 * @param {Record<string, unknown>} source
 * @param {string[]} keys
 * @returns {string}
 */
function firstText(source, keys) {
  for (const key of keys) {
    const value = toText(source[key]).trim();
    if (value) return value;
  }
  return '';
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function toJsonString(value) {
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) return '';
  return JSON.stringify(value);
}

/**
 * @param {unknown} value
 * @returns {Outcome | ''}
 */
function normalizeOutcome(value) {
  const normalized = toText(value).trim().toLowerCase();
  return (
    normalized === 'success' ||
    normalized === 'failure' ||
    normalized === 'timeout' ||
    normalized === 'skipped' ||
    normalized === 'unknown'
  ) ? normalized : '';
}

/**
 * @param {Record<string, unknown>} payload
 * @returns {{ number: number, headRef: string, baseRef: string, headSha: string }}
 */
function readFallbackPull(payload) {
  const pullRequest = isRecord(payload.pull_request) ? payload.pull_request : {};
  const issue = isRecord(payload.issue) ? payload.issue : {};
  const head = isRecord(pullRequest.head) ? pullRequest.head : {};
  const base = isRecord(pullRequest.base) ? pullRequest.base : {};

  const numberFromPull = typeof pullRequest.number === 'number' ? pullRequest.number : undefined;
  const numberFromIssue = typeof issue.number === 'number' ? issue.number : undefined;
  const number = numberFromPull || numberFromIssue || 1;

  return {
    number,
    headRef: toText(head.ref).trim() || 'fixture/head',
    baseRef: toText(base.ref).trim() || 'main',
    headSha: toText(head.sha).trim() || 'fixture-sha',
  };
}

/**
 * @param {StateFixture} stateFixture
 * @param {Record<string, unknown>} eventPayload
 * @returns {{
 *   githubFixtures: Record<string, string | unknown>,
 *   netlifyFixtures: Record<string, string | unknown>,
 *   env: Record<string, string | number | boolean>,
 *   seedOutputs: Record<string, string>,
 *   explicitOutcome: Outcome | ''
 * }}
 */
function buildStateOverrides(stateFixture, eventPayload) {
  const githubFixtures = asFixtureMap(stateFixture.githubFixtures);
  const netlifyFixtures = asFixtureMap(stateFixture.netlifyFixtures);
  const env = asEnvMap(stateFixture.env);
  const seedOutputs = asSeedOutputs(stateFixture.seedOutputs);

  const statusCommentBody = firstText(
    /** @type {Record<string, unknown>} */ (stateFixture),
    ['statusCommentBody', 'statusComment']
  );
  if (statusCommentBody) {
    githubFixtures['issues.getComment'] = {
      data: {
        id: 1,
        body: statusCommentBody,
      },
    };
  }

  const prBody = firstText(
    /** @type {Record<string, unknown>} */ (stateFixture),
    ['prBody', 'pullRequestBody']
  );
  if (prBody) {
    const fallbackPull = readFallbackPull(eventPayload);
    githubFixtures['pulls.get'] = {
      data: {
        number: fallbackPull.number,
        body: prBody,
        head: {
          ref: fallbackPull.headRef,
          sha: fallbackPull.headSha,
        },
        base: {
          ref: fallbackPull.baseRef,
        },
      },
    };
  }

  const linkedPrNumber = firstText(
    /** @type {Record<string, unknown>} */ (stateFixture),
    ['linkedPrNumber']
  );
  if (linkedPrNumber) {
    seedOutputs['linked-pr-number'] = linkedPrNumber;
  }

  const existingRunnerId = firstText(
    /** @type {Record<string, unknown>} */ (stateFixture),
    ['existingRunnerId', 'existingRunnerIdOutput']
  );
  if (existingRunnerId) {
    seedOutputs['agent-runner-id'] = existingRunnerId;
  }

  const existingSessionData = toJsonString(
    stateFixture.existingSessionData !== undefined
      ? stateFixture.existingSessionData
      : stateFixture.existingSessionDataOutput
  ).trim();
  if (existingSessionData) {
    seedOutputs['session-data-map'] = existingSessionData;
  }

  const explicitOutcome = normalizeOutcome(stateFixture.outcome || env.OUTCOME);

  return {
    githubFixtures,
    netlifyFixtures,
    env,
    seedOutputs,
    explicitOutcome,
  };
}

/**
 * @param {import('./contracts').ScenarioTrace} trace
 * @param {{ fixturePath: string, stateFixturePath: string, eventName: string, outcome: Outcome }} meta
 * @returns {SimulationReport}
 */
function buildReport(trace, meta) {
  const outputs = trace.outputs || {};
  const rawState = isRecord(trace.state) ? trace.state : {};
  const reconciled = isRecord(rawState.reconciled) ? rawState.reconciled : {};
  const shouldRun = toText(outputs['should-run']).trim().toLowerCase() === 'true';

  /** @type {SimulationContext} */
  const context = {
    issueNumber: toText(outputs['issue-number']),
    prNumber: toText(outputs['pr-number']),
    isPr: toText(outputs['is-pr']).trim().toLowerCase() === 'true',
    headRef: toText(outputs['head-ref']),
    baseRef: toText(outputs['base-ref']),
    headSha: toText(outputs['head-sha']),
    hasLinkedPr: toText(outputs['has-linked-pr']).trim().toLowerCase() === 'true',
    linkedPrNumber: toText(outputs['linked-pr-number']),
    isDryRun: toText(outputs['is-dry-run']).trim().toLowerCase() === 'true',
  };

  return {
    scenarioName: toText(trace.scenario),
    fixturePath: meta.fixturePath,
    stateFixturePath: meta.stateFixturePath,
    eventName: meta.eventName,
    decision: shouldRun ? 'run' : 'skip',
    outcome: meta.outcome,
    shouldRun,
    context,
    model: toText(outputs.model),
    prompt: toText(outputs['trigger-text']),
    recoveredState: { ...reconciled },
    warnings: Array.isArray(trace.warnings) ? trace.warnings.map(toText) : [],
    failures: Array.isArray(trace.failures) ? trace.failures : [],
    comments: Array.isArray(trace.comments) ? trace.comments.map(toText) : [],
    summary: toText(trace.summary),
  };
}

/**
 * @param {string} value
 * @param {string} [prefix]
 * @returns {string}
 */
function indentBlock(value, prefix = '  ') {
  return value
    .split('\n')
    .map(line => `${prefix}${line}`)
    .join('\n');
}

/**
 * @param {SimulationReport} report
 * @returns {string}
 */
function renderHumanReport(report) {
  /** @type {string[]} */
  const lines = [];

  lines.push('Local Simulator');
  lines.push(`Scenario: ${report.scenarioName || 'n/a'}`);
  lines.push(`Fixture: ${report.fixturePath}`);
  lines.push(`State fixture: ${report.stateFixturePath || 'n/a'}`);
  lines.push(`Event: ${report.eventName}`);
  lines.push(`Decision: ${report.decision}`);
  lines.push(`Should run: ${report.shouldRun ? 'true' : 'false'}`);
  lines.push(`Outcome: ${report.outcome}`);
  lines.push(`Model: ${report.model || 'n/a'}`);
  lines.push('');

  lines.push('Prompt:');
  lines.push(report.prompt ? indentBlock(report.prompt) : '  (empty)');
  lines.push('');

  lines.push('Context:');
  lines.push(indentBlock(JSON.stringify(report.context, null, 2)));
  lines.push('');

  lines.push('Recovered state:');
  lines.push(indentBlock(JSON.stringify(report.recoveredState, null, 2)));
  lines.push('');

  lines.push('Warnings:');
  if (report.warnings.length === 0) {
    lines.push('  (none)');
  } else {
    for (const warning of report.warnings) {
      lines.push(`  - ${warning}`);
    }
  }
  lines.push('');

  lines.push('Failures:');
  if (report.failures.length === 0) {
    lines.push('  (none)');
  } else {
    for (const failure of report.failures) {
      lines.push(`  - [${failure.category}] ${failure.summary}`);
    }
  }
  lines.push('');

  lines.push('Would-render comments:');
  if (report.comments.length === 0) {
    lines.push('  (none)');
  } else {
    report.comments.forEach((comment, index) => {
      lines.push(`  [${index + 1}]`);
      lines.push(indentBlock(comment, '    '));
    });
  }
  lines.push('');

  lines.push('Summary:');
  lines.push(report.summary ? indentBlock(report.summary) : '  (empty)');

  return lines.join('\n');
}

/**
 * @param {SimulationReport} report
 * @returns {string}
 */
function renderMarkdownReport(report) {
  /** @type {string[]} */
  const lines = [];

  lines.push('# Local Simulator');
  lines.push('');
  lines.push('| Field | Value |');
  lines.push('|---|---|');
  lines.push(`| Scenario | \`${report.scenarioName || 'n/a'}\` |`);
  lines.push(`| Fixture | \`${report.fixturePath}\` |`);
  lines.push(`| State fixture | ${report.stateFixturePath ? `\`${report.stateFixturePath}\`` : 'n/a'} |`);
  lines.push(`| Event | \`${report.eventName}\` |`);
  lines.push(`| Decision | \`${report.decision}\` |`);
  lines.push(`| Should run | ${report.shouldRun ? 'true' : 'false'} |`);
  lines.push(`| Outcome | \`${report.outcome}\` |`);
  lines.push(`| Model | \`${report.model || 'n/a'}\` |`);
  lines.push('');
  lines.push('## Prompt');
  lines.push('');
  if (report.prompt) {
    lines.push('```text');
    lines.push(report.prompt);
    lines.push('```');
  } else {
    lines.push('_No prompt captured._');
  }
  lines.push('');
  lines.push('## Context');
  lines.push('');
  lines.push('```json');
  lines.push(JSON.stringify(report.context, null, 2));
  lines.push('```');
  lines.push('');
  lines.push('## Recovered State');
  lines.push('');
  lines.push('```json');
  lines.push(JSON.stringify(report.recoveredState, null, 2));
  lines.push('```');
  lines.push('');
  lines.push('## Warnings');
  lines.push('');
  if (report.warnings.length === 0) {
    lines.push('_None._');
  } else {
    for (const warning of report.warnings) {
      lines.push(`- ${warning}`);
    }
  }
  lines.push('');
  lines.push('## Failures');
  lines.push('');
  if (report.failures.length === 0) {
    lines.push('_None._');
  } else {
    for (const failure of report.failures) {
      lines.push(`- **${failure.category}**: ${failure.summary}`);
    }
  }
  lines.push('');
  lines.push('## Would-Render Comments');
  lines.push('');
  if (report.comments.length === 0) {
    lines.push('_None._');
  } else {
    report.comments.forEach((comment, index) => {
      lines.push(`### Comment ${index + 1}`);
      lines.push('');
      lines.push('```markdown');
      lines.push(comment);
      lines.push('```');
      lines.push('');
    });
  }
  lines.push('## Step Summary');
  lines.push('');
  lines.push(report.summary || '_No summary generated._');

  return lines.join('\n');
}

/**
 * @param {SimulationReport} report
 * @param {OutputFormat} format
 * @returns {string}
 */
function formatReport(report, format) {
  if (format === 'json') return JSON.stringify(report, null, 2);
  if (format === 'markdown') return renderMarkdownReport(report);
  return renderHumanReport(report);
}

/**
 * @param {RunSimulationOptions} options
 * @returns {Promise<RunSimulationResult>}
 */
async function runSimulation(options) {
  const repoRoot = options.repoRoot || path.join(__dirname, '..');
  const fixturePath = options.fixturePath;
  const stateFixturePath = options.stateFixturePath || '';

  const eventPayloadRaw = loadFixtureJson(fixturePath, repoRoot);
  if (!isRecord(eventPayloadRaw)) {
    throw new Error('Event fixture must contain an object payload.');
  }
  const eventPayload = /** @type {Record<string, unknown>} */ (eventPayloadRaw);
  const eventName = inferEventName(eventPayload);

  const stateFixtureRaw = stateFixturePath
    ? loadFixtureJson(stateFixturePath, repoRoot)
    : {};
  if (!isRecord(stateFixtureRaw)) {
    throw new Error('State fixture must contain an object payload.');
  }
  const stateFixture = /** @type {StateFixture} */ (stateFixtureRaw);
  const state = buildStateOverrides(stateFixture, eventPayload);

  /** @type {Record<string, unknown>} */
  const scenarioBase = {
    name: `simulate:${path.basename(fixturePath)}`,
    eventName,
    eventFixture: fixturePath,
    runContextEvenIfSkipped: true,
  };

  if (Object.keys(state.githubFixtures).length > 0) {
    scenarioBase.githubFixtures = state.githubFixtures;
  }
  if (Object.keys(state.netlifyFixtures).length > 0) {
    scenarioBase.netlifyFixtures = state.netlifyFixtures;
  }
  if (Object.keys(state.env).length > 0) {
    scenarioBase.env = state.env;
  }
  if (Object.keys(state.seedOutputs).length > 0) {
    scenarioBase.seedOutputs = state.seedOutputs;
  }

  /** @type {Record<string, unknown>} */
  const warmupScenario = {
    ...scenarioBase,
    commentMode: 'none',
  };
  if (state.explicitOutcome) {
    warmupScenario.outcome = state.explicitOutcome;
  }

  const warmupTrace = await runScenario(
    /** @type {any} */ (warmupScenario),
    { repoRoot }
  );

  /** @type {Outcome} */
  const finalOutcome = state.explicitOutcome || (warmupTrace.outputs['should-run'] === 'true' ? 'success' : 'skipped');
  const simulationScenario = {
    ...scenarioBase,
    commentMode: 'auto',
    outcome: finalOutcome,
  };

  const trace = await runScenario(
    /** @type {any} */ (simulationScenario),
    { repoRoot }
  );

  const report = buildReport(trace, {
    fixturePath,
    stateFixturePath,
    eventName,
    outcome: finalOutcome,
  });

  return { report, trace };
}

/**
 * @param {string[]} [argv]
 * @param {CliIo} [io]
 * @returns {Promise<number>}
 */
async function main(
  argv = process.argv.slice(2),
  io = { stdout: process.stdout, stderr: process.stderr }
) {
  let parsed;
  try {
    parsed = parseArgs(argv);
  } catch (error) {
    if (error instanceof UsageError) {
      io.stderr.write(`${error.message}\n`);
      io.stderr.write(`${usageText()}\n`);
      return 1;
    }
    throw error;
  }

  if (parsed.help) {
    io.stdout.write(`${usageText()}\n`);
    return 0;
  }

  try {
    const result = await runSimulation({
      fixturePath: parsed.fixturePath,
      stateFixturePath: parsed.stateFixturePath || undefined,
    });
    const output = formatReport(result.report, parsed.format);
    io.stdout.write(output.endsWith('\n') ? output : `${output}\n`);
    return 0;
  } catch (error) {
    io.stderr.write(`simulate: ${toText(error instanceof Error ? error.message : error)}\n`);
    return 1;
  }
}

if (require.main === module) {
  void main()
    .then(code => {
      if (code !== 0) process.exit(code);
    })
    .catch(error => {
      console.error(error);
      process.exit(1);
    });
}

module.exports = {
  formatReport,
  inferEventName,
  main,
  parseArgs,
  renderHumanReport,
  renderMarkdownReport,
  runSimulation,
  usageText,
};
