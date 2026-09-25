// Structural and behavioral tests for composite steps defined inline in
// action.yml, which unit tests of src/ modules would not otherwise cover.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ACTION_YML = fs.readFileSync(path.join(__dirname, '..', 'action.yml'), 'utf8');

/**
 * Split the composite steps into raw text blocks keyed by name.
 * @returns {{ name: string, text: string }[]}
 */
function steps() {
  const body = ACTION_YML.slice(ACTION_YML.indexOf('\n  steps:\n'));
  return body.split(/\n    - name: /).slice(1).map((chunk) => ({
    name: chunk.split('\n')[0].trim(),
    text: chunk,
  }));
}

/**
 * Extract a step's `run: |` script, de-indented.
 * @param {string} name
 * @returns {string}
 */
function runScript(name) {
  const step = steps().find((entry) => entry.name === name);
  assert.ok(step, `step "${name}" exists`);
  const lines = step.text.split('\n');
  const start = lines.findIndex((line) => /^      run: \|$/.test(line));
  assert.ok(start >= 0, `step "${name}" has a run: | block`);
  const script = [];
  for (const line of lines.slice(start + 1)) {
    if (line.trim() !== '' && !line.startsWith('        ')) break;
    script.push(line.slice(8));
  }
  return script.join('\n');
}

describe('action.yml runtime staging', () => {
  it('stages the action outside the workspace before any step needs dependencies', () => {
    const all = steps();
    const installIndex = all.findIndex((step) => step.name === 'Install action dependencies');
    assert.ok(installIndex > 0);
    assert.match(all[installIndex].text, /id: install-deps/);
    assert.match(all[installIndex].text, /RUNNER_TEMP/);
    assert.match(all[installIndex].text, /action-dir=/);
    assert.doesNotMatch(all[installIndex].text, /working-directory: \$\{\{ github\.action_path \}\}/);
  });

  it('loads every later step from the staged copy, not github.action_path', () => {
    const all = steps();
    const installIndex = all.findIndex((step) => step.name === 'Install action dependencies');
    for (const step of all.slice(installIndex + 1)) {
      for (const line of step.text.split('\n').filter((entry) => /ACTION_DIR:/.test(entry))) {
        assert.match(
          line,
          /ACTION_DIR: \$\{\{ steps\.install-deps\.outputs\.action-dir \|\| github\.action_path \}\}/,
          `step "${step.name}"`,
        );
      }
    }
  });

  it('runs the staging script end to end with a copied src tree', () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'action-stage-'));
    try {
      const actionPath = path.join(temp, 'action');
      fs.mkdirSync(path.join(actionPath, 'src'), { recursive: true });
      fs.writeFileSync(path.join(actionPath, 'src', 'marker.js'), 'module.exports = 1;\n');
      fs.writeFileSync(path.join(actionPath, 'package.json'), JSON.stringify({ name: 'stage-test', version: '1.0.0' }));
      fs.writeFileSync(path.join(actionPath, 'package-lock.json'), JSON.stringify({
        name: 'stage-test', version: '1.0.0', lockfileVersion: 3, requires: true,
        packages: { '': { name: 'stage-test', version: '1.0.0' } },
      }));
      const runnerTemp = path.join(temp, 'runner');
      fs.mkdirSync(runnerTemp);
      const output = path.join(temp, 'output');
      fs.writeFileSync(output, '');
      const result = spawnSync('bash', ['-c', runScript('Install action dependencies')], {
        env: { ...process.env, ACTION_PATH: actionPath, RUNNER_TEMP: runnerTemp, GITHUB_OUTPUT: output },
        encoding: 'utf8',
      });
      assert.equal(result.status, 0, result.stderr);
      const stage = path.join(runnerTemp, 'netlify-agent-runner-action');
      assert.equal(fs.readFileSync(output, 'utf8').trim(), `action-dir=${stage}`);
      assert.ok(fs.existsSync(path.join(stage, 'src', 'marker.js')));
      assert.ok(fs.existsSync(path.join(stage, 'package-lock.json')));
    } finally {
      fs.rmSync(temp, { recursive: true, force: true });
    }
  });
});

describe('action.yml run-agent crash fallback', () => {
  /**
   * @param {string} scriptBody Contents of the fake src/run-agent.js.
   * @returns {{ status: number | null, output: string, stdout: string }}
   */
  function runWith(scriptBody) {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'action-run-'));
    try {
      fs.mkdirSync(path.join(temp, 'src'));
      fs.writeFileSync(path.join(temp, 'src', 'run-agent.js'), scriptBody);
      const output = path.join(temp, 'output');
      fs.writeFileSync(output, '');
      const result = spawnSync('bash', ['-c', runScript('Run Netlify Agent Runners')], {
        env: { ...process.env, ACTION_DIR: temp, GITHUB_OUTPUT: output },
        encoding: 'utf8',
      });
      return { status: result.status, output: fs.readFileSync(output, 'utf8'), stdout: result.stdout };
    } finally {
      fs.rmSync(temp, { recursive: true, force: true });
    }
  }

  const writeOutput = (name, value) =>
    `require('fs').appendFileSync(process.env.GITHUB_OUTPUT, '${name}<<EOF_X\\n${value}\\nEOF_X\\n');`;

  it('records a failure when run-agent crashes before reporting an outcome', () => {
    const result = runWith("require('nax-agent-runner-sdk-that-does-not-exist');\n");
    assert.notEqual(result.status, 0);
    assert.match(result.output, /^outcome=failure$/m);
    assert.match(result.output, /^failure-category=unknown$/m);
    assert.match(result.output, /^failure-stage=run-agent$/m);
    assert.match(result.output, /^agent-error=The Agent Runner step exited \(status 1\)/m);
    assert.match(result.stdout, /::error title=Agent Runner step crashed::/);
  });

  it('records a failure when only the initial empty outcome was written', () => {
    const result = runWith(`${writeOutput('outcome', '')}\nprocess.exit(1);\n`);
    assert.notEqual(result.status, 0);
    assert.match(result.output, /^outcome=failure$/m);
  });

  it('keeps run-agent\'s own failure report untouched', () => {
    const result = runWith(`${writeOutput('outcome', '')}${writeOutput('outcome', 'timeout')}\nprocess.exit(1);\n`);
    assert.notEqual(result.status, 0);
    assert.doesNotMatch(result.output, /^outcome=failure$/m);
    assert.doesNotMatch(result.output, /failure-stage=run-agent/);
  });

  it('passes a successful run through unchanged', () => {
    const result = runWith(`${writeOutput('outcome', 'success')}\n`);
    assert.equal(result.status, 0);
    assert.doesNotMatch(result.output, /outcome=failure/);
  });

  it('preserves the original exit status', () => {
    assert.equal(runWith('process.exit(3);\n').status, 3);
  });
});
