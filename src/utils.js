// Shared utilities for the Netlify Agent Runners action.
// Used by actions/github-script steps via:
//   const utils = require(`${process.env.ACTION_DIR}/src/utils.js`)

/** @typedef {import('./types').InProgressCommentOptions} InProgressCommentOptions */

const path = require('path');
const catalog = require('./agent-catalog');
const {
  STATUS_COMMENT_MARKER,
  renderRunnerIdMarker,
  stripAllHtmlComments,
} = require('./comment-markers');

/** @type {[string, string][]} */
const FLAVOR_MESSAGES = require(path.join(__dirname, 'flavor-messages.json'));

// ---------------------------------------------------------------------------
// Trigger detection
// ---------------------------------------------------------------------------

/**
 * All accepted mention variants (base + common typos).
 * @type {string[]}
 */
const TRIGGER_BASES = ['netlify', 'nelify', 'netlfy', 'netify', 'netlif', 'netfly'];

const TRIGGER_BASE_PATTERN = `(?:${TRIGGER_BASES.join('|')})`;

// ---------------------------------------------------------------------------
// Agent, model, and effort selection. Legacy API fields still use the name
// "model" for the agent provider; actual model IDs are "model IDs" here.
// ---------------------------------------------------------------------------

/** @type {string[]} */
const VALID_MODELS = catalog.PROVIDERS;
const DEFAULT_MODEL = 'codex';

/** @type {string[]} */
const VALID_EFFORTS = catalog.EFFORT_WORDS;

/**
 * Selector suffixes such as @netlify-claude or @netlify-fable. Longest first
 * so alternation never stops at a shorter prefix.
 * @type {string[]}
 */
const SELECTOR_SUFFIXES = [...VALID_MODELS, ...catalog.STANDALONE_SUFFIXES, 'ask']
  .sort((a, b) => b.length - a.length);

const TRIGGER_SUFFIX_PATTERN = `(?:[_-](?:agents?(?:[_-]runs?)?|ai|${SELECTOR_SUFFIXES.join('|')}))?`;

/**
 * Standalone @netlify mention (and typos) with optional suffixes like -agent,
 * -agents, -ai, or a selector such as -claude or -fable. Rejects package
 * scopes like @netlify/pkg and email-like strings such as me@netlify.com.
 */
const TRIGGER_PATTERN = new RegExp(
  `(?<!\\w)@${TRIGGER_BASE_PATTERN}${TRIGGER_SUFFIX_PATTERN}(?![\\w./-])`,
  'i'
);

/** Same as TRIGGER_PATTERN, capturing the selector suffix when present. */
const TRIGGER_CAPTURE_PATTERN = new RegExp(
  `(?<!\\w)@${TRIGGER_BASE_PATTERN}(?:[_-](?:agents?(?:[_-]runs?)?|ai|(${SELECTOR_SUFFIXES.join('|')})))?(?![\\w./-])`,
  'i'
);

/** Match "@netlify [with|using|via] <agent>" (legacy agent-only pattern). */
const MODEL_PATTERN = new RegExp(
  `${TRIGGER_PATTERN.source}\\s+(?:(?:with|using|use|via)\\s+)?(${VALID_MODELS.join('|')})\\b`,
  'i'
);

/** Match an explicit "effort:high" or "effort=high" token. */
const EXPLICIT_EFFORT_PATTERN = new RegExp(
  `(?<![\\w-])effort[:=](auto|${VALID_EFFORTS.join('|')})(?![\\w-])`,
  'i'
);

/** Match an explicit "model:<id>" or "model=<id>" token. */
const EXPLICIT_MODEL_PATTERN = /(?<![\w-])model[:=](~?[A-Za-z0-9][A-Za-z0-9._~\/-]*)(?![\w-])/i;

/**
 * One selector word, followed by whitespace (including the '\r' of CRLF
 * bodies), ':', ',', a sentence-ending '.', or end of line. A '.' inside a
 * word (opus-4.8) is part of the word.
 */
const SELECTOR_WORD_PATTERN = /^[ \t]+(~?[A-Za-z0-9][A-Za-z0-9._~\/-]*?)(?=\s|[:,]|\.(?:\s|$)|$)/;
const CONNECTOR_PATTERN = /^[ \t]+(?:with|using|use|via)(?=[ \t])/i;
/** "ask:" as the first word after the mention (the colon is required). */
const ASK_PREFIX_PATTERN = /^[ \t]+ask:(?=\s|$)/i;
/** "mode:ask" / "mode=normal", honored only inside the selector prefix. */
const MODE_WORD_PATTERN = /^[ \t]+mode[:=](ask|normal)(?=\s|[:,]|\.(?:\s|$)|$)/i;

// ---------------------------------------------------------------------------
// Helper functions
// ---------------------------------------------------------------------------

/**
 * Strip Markdown code regions (fenced blocks and inline code spans) from text
 * so trigger detection ignores @netlify mentions a user is quoting verbatim.
 *
 * Handles:
 *   - ```fenced``` and ~~~fenced~~~ blocks
 *   - `inline` and ``inline with backtick`` spans (any number of paired backticks)
 *
 * @param {string} text
 * @returns {string}
 */
function stripMarkdownCode(text) {
  if (!text) return '';
  return text
    .replace(/```[\s\S]*?```/g, '')
    .replace(/~~~[\s\S]*?~~~/g, '')
    .replace(/(`+)[\s\S]*?\1/g, '');
}

/**
 * Check whether `text` contains any recognised trigger mention.
 * Mentions inside Markdown code spans or fenced blocks are ignored so users
 * can quote `@netlify` verbatim without firing the action.
 * @param {string | null | undefined} text
 * @returns {boolean}
 */
function matchesTrigger(text) {
  if (!text) return false;
  return TRIGGER_PATTERN.test(stripMarkdownCode(text));
}

/**
 * @typedef {object} MentionSelection
 * @property {string | null} agent Agent word named in the mention.
 * @property {string | null} model Model word or `model:` value, as written.
 * @property {string | null} effort Effort word or `effort:` value.
 * @property {'ask' | 'normal' | null} mode Runner mode (the -ask suffix, "ask:", or mode:ask).
 * @property {number} start Index of the mention within the line.
 * @property {number} end Index just past the consumed selector words.
 */

/**
 * Parse the selector words that follow the first @netlify mention in `line`.
 * Words are read in order agent -> model -> effort; each slot is optional,
 * and reading stops at the first word that doesn't fit the next slot. A
 * model word needs a preceding agent unless its alias is standalone (fable,
 * opus, sonnet, haiku) or it is an exact model ID; a standalone alias after a
 * different agent is still read as a model. An effort word needs a
 * preceding agent or model. Explicit `model:<id>` / `effort:<level>` tokens
 * anywhere on the line override the positional words.
 *
 * @param {string} line
 * @returns {MentionSelection | null}
 */
function parseMentionLine(line) {
  const trigger = TRIGGER_CAPTURE_PATTERN.exec(line);
  if (!trigger) return null;
  /** @type {MentionSelection} */
  const selection = {
    agent: null,
    model: null,
    effort: null,
    mode: null,
    start: trigger.index,
    end: trigger.index + trigger[0].length,
  };

  /** @param {string} word @returns {boolean} */
  const accept = (word) => {
    const normalized = word.toLowerCase();
    if (!selection.agent && !selection.model && !selection.effort && VALID_MODELS.includes(normalized)) {
      selection.agent = normalized;
      return true;
    }
    // Models of another agent are consumed too; resolveSelection() switches
    // to the model's agent and warns.
    if (!selection.model && !selection.effort && (
      catalog.resolveModelWord(normalized, selection.agent)
      || (selection.agent && catalog.resolveModelWord(normalized, null))
    )) {
      selection.model = normalized;
      return true;
    }
    if (!selection.effort && (selection.agent || selection.model) && VALID_EFFORTS.includes(normalized)) {
      selection.effort = normalized;
      return true;
    }
    return false;
  };

  if (trigger[1] && trigger[1].toLowerCase() === 'ask') selection.mode = 'ask';
  else if (trigger[1]) accept(trigger[1]);

  let rest = line.slice(selection.end);
  const askPrefix = rest.match(ASK_PREFIX_PATTERN);
  if (askPrefix) {
    selection.mode = 'ask';
    selection.end += askPrefix[0].length;
    rest = rest.slice(askPrefix[0].length);
  }
  const connector = rest.match(CONNECTOR_PATTERN);
  if (connector && !selection.agent && !selection.model) {
    const afterConnector = rest.slice(connector[0].length).match(SELECTOR_WORD_PATTERN);
    if (afterConnector && (
      VALID_MODELS.includes(afterConnector[1].toLowerCase())
      || catalog.resolveModelWord(afterConnector[1], null)
    )) {
      selection.end += connector[0].length;
      rest = rest.slice(connector[0].length);
    }
  }
  for (;;) {
    const modeWord = rest.match(MODE_WORD_PATTERN);
    if (modeWord) {
      selection.mode = /** @type {'ask' | 'normal'} */ (modeWord[1].toLowerCase());
      selection.end += modeWord[0].length;
      rest = rest.slice(modeWord[0].length);
      continue;
    }
    const word = rest.match(SELECTOR_WORD_PATTERN);
    if (!word || !accept(word[1])) break;
    selection.end += word[0].length;
    rest = rest.slice(word[0].length);
  }

  const explicitModel = line.match(EXPLICIT_MODEL_PATTERN);
  if (explicitModel) {
    // Keep the agent a positional model implied (e.g. "fable" -> claude).
    const implied = selection.model ? catalog.resolveModelWord(selection.model, selection.agent) : undefined;
    if (!selection.agent && implied) selection.agent = implied.provider;
    selection.model = explicitModel[1].toLowerCase();
  }
  const explicitEffort = line.match(EXPLICIT_EFFORT_PATTERN);
  if (explicitEffort) selection.effort = explicitEffort[1].toLowerCase();
  return selection;
}

/**
 * Parse agent, model, and effort from the first @netlify mention line that
 * names any of them. Mentions inside code spans and fences are ignored.
 * @param {string | null | undefined} text
 * @returns {MentionSelection | null}
 */
function parseSelection(text) {
  if (!text) return null;
  /** @type {MentionSelection | null} */
  let first = null;
  for (const line of stripMarkdownCode(text).split('\n')) {
    const selection = parseMentionLine(line);
    if (!selection) continue;
    if (selection.agent || selection.model || selection.effort || selection.mode) return selection;
    first = first || selection;
  }
  return first;
}

/**
 * Extract the agent name from trigger text. A model alias implies its agent
 * (e.g. "@netlify fable" selects claude). Falls back to `defaultModel`.
 * @param {string | null | undefined} text
 * @param {string} [defaultModel]
 * @returns {string}
 */
function extractModel(text, defaultModel) {
  const selection = parseSelection(text);
  const model = selection?.model
    ? catalog.resolveModelWord(selection.model, selection.agent)
    : undefined;
  return selection?.agent || model?.provider || defaultModel || DEFAULT_MODEL;
}

/**
 * Normalize a configured effort value. Empty and `auto` mean backend Auto
 * (returned as ''); unrecognized values return null.
 * @param {string | null | undefined} value
 * @returns {string | null}
 */
function normalizeEffort(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized === '' || normalized === 'auto') return '';
  return VALID_EFFORTS.includes(normalized) ? normalized : null;
}

/**
 * Extract the effort word from trigger text, unvalidated against the model.
 * Returns '' for backend Auto when nothing matches and no valid default is
 * given.
 * @param {string | null | undefined} text
 * @param {string} [defaultEffort]
 * @returns {string}
 */
function extractEffort(text, defaultEffort) {
  const selection = parseSelection(text);
  if (selection?.effort) return normalizeEffort(selection.effort) || '';
  return normalizeEffort(defaultEffort) || '';
}

/**
 * @typedef {object} ResolvedSelection
 * @property {string} agent Agent provider to run.
 * @property {string} modelId Wire model ID; '' means backend Auto.
 * @property {string} modelLabel Display label for the model ('' for Auto).
 * @property {string} effort Wire effort; '' means backend Auto.
 * @property {string} effortLabel Effort as typed/displayed (e.g. `max` when
 *   the wire value is `xhigh`).
 * @property {string[]} warnings Human-readable adjustments that were made.
 */

/**
 * Resolve the final agent/model/effort from a parsed mention plus defaults.
 * Mention values win over defaults. A catalog model implies its agent. Effort
 * outside the resolved model's supported levels falls back to Auto with a
 * warning, as does an unknown default.
 *
 * @param {MentionSelection | null} selection
 * @param {{ defaultAgent?: string, defaultModelId?: string, defaultEffort?: string }} [defaults]
 * @returns {ResolvedSelection}
 */
function resolveSelection(selection, defaults = {}) {
  /** @type {string[]} */
  const warnings = [];
  const defaultAgent = String(defaults.defaultAgent || DEFAULT_MODEL).toLowerCase();
  let agent = selection?.agent || '';

  const defaultModelWord = String(defaults.defaultModelId || '').trim().toLowerCase();
  let modelWord = selection?.model || '';
  let modelFromDefault = false;
  if (!modelWord && defaultModelWord && defaultModelWord !== 'auto') {
    modelWord = defaultModelWord;
    modelFromDefault = true;
  }

  // Defaults resolve against the whole catalog; a mention alias only within
  // its named agent (or as a standalone alias).
  let known = !modelWord ? undefined
    : modelFromDefault ? catalog.resolveConfiguredModel(modelWord)
      : catalog.resolveModelWord(modelWord, agent || null);
  if (modelWord && !known && agent) {
    // A model named after the "wrong" agent, e.g. "@netlify codex fable".
    const elsewhere = catalog.resolveModelWord(modelWord, null);
    if (elsewhere && !modelFromDefault) {
      warnings.push(`Model ${elsewhere.label} runs on ${elsewhere.provider}, not ${agent}; using ${elsewhere.provider}.`);
      known = elsewhere;
      agent = elsewhere.provider;
    }
  }

  let modelId = '';
  let modelLabel = '';
  if (known) {
    if (modelFromDefault && agent && known.provider !== agent) {
      // default-model-id belongs to another agent; the mention's agent wins.
    } else {
      if (agent && known.provider !== agent) {
        warnings.push(`Model ${known.label} runs on ${known.provider}, not ${agent}; using ${known.provider}.`);
      }
      agent = known.provider;
      modelId = known.id;
      modelLabel = known.label;
    }
  } else if (modelWord && modelWord !== 'auto') {
    if (catalog.MODEL_ID_PATTERN.test(modelWord)) {
      warnings.push(`Model \`${modelWord}\` is not in the action's catalog; passing it through for Agent Runner to validate.`);
      modelId = modelWord;
      modelLabel = `\`${modelWord}\``;
    } else {
      warnings.push('Ignoring an invalid model value; using Auto.');
    }
  }

  agent = agent || defaultAgent;

  let effort = selection?.effort ? normalizeEffort(selection.effort) : null;
  if (effort === null || effort === undefined) {
    const fallback = normalizeEffort(defaults.defaultEffort);
    if (fallback === null) {
      warnings.push(`Ignoring unsupported default-effort; using Auto (supported: ${VALID_EFFORTS.join(', ')}, auto).`);
    }
    effort = fallback || '';
  }
  let effortLabel = effort;
  if (effort) {
    const knownForEffort = catalog.modelById(modelId);
    const supported = knownForEffort
      ? knownForEffort.efforts
      : modelId ? null : catalog.AUTO_MODEL_EFFORTS;
    const match = supported ? catalog.findEffort(supported, effort) : undefined;
    if (supported && !match) {
      const target = knownForEffort ? knownForEffort.label : `${agent} (Auto model)`;
      const levels = supported.map((level) => level.id).join(', ') || 'none; Auto only';
      warnings.push(`Effort "${effort}" is not supported by ${target} (supported: ${levels}); using Auto.`);
      effort = '';
      effortLabel = '';
    } else if (match) {
      effort = match.wire || match.id;
      effortLabel = match.id;
    }
  }

  return { agent, modelId, modelLabel, effort, effortLabel, warnings };
}

/**
 * @typedef {object} MentionCommand
 * @property {'run' | 'stop' | 'stop-misplaced' | 'recover'} command
 * @property {'normal' | 'ask'} mode
 * @property {{ agent: string | null, model: string | null, effort: string | null }} selection
 * @property {string} prompt Cleaned prompt (mention, selector words, and markers removed)
 * @property {{ model: boolean, effort: boolean }} explicit Whether model:/effort: tokens were used
 */

/**
 * Index just past the @netlify mention, its selector words, and an optional
 * ":" or "," separator on `line`, or -1 when the line has no mention. New
 * explicit tokens (mode:) are only honored before this point.
 * @param {string} line
 * @returns {number}
 */
function selectorPrefixEnd(line) {
  const selection = parseMentionLine(line);
  if (!selection) return -1;
  const rest = line.slice(selection.end);
  const separator = /^(?:[ \t]*(?:[:,]|\.(?=\s|$)))?/.exec(rest);
  return selection.end + (separator ? separator[0].length : 0);
}

/**
 * Is this comment exactly "@netlify stop" (trimmed, any case)? Anything more,
 * like "@netlify stop the cron job", is an ordinary run request.
 * @param {string} text
 * @returns {boolean}
 */
function isStopCommand(text) {
  return /^@netlify\s+stop$/i.test(String(text || '').trim());
}

/**
 * Parse a trigger into one command object. Parse the raw trigger text
 * (before get-context appends the source-URL line). Workflow-dispatch inputs
 * take precedence over mention words; callers apply them.
 * @param {string | null | undefined} text
 * @returns {MentionCommand}
 */
function parseCommand(text) {
  const raw = String(text || '');
  const selection = parseSelection(raw);
  const mentionLine = stripMarkdownCode(raw).split('\n').find((line) => TRIGGER_PATTERN.test(line)) || '';
  return {
    command: 'run',
    mode: selection && selection.mode === 'ask' ? 'ask' : 'normal',
    selection: {
      agent: selection ? selection.agent : null,
      model: selection ? selection.model : null,
      effort: selection ? selection.effort : null,
    },
    prompt: cleanPrompt(raw),
    explicit: {
      model: EXPLICIT_MODEL_PATTERN.test(mentionLine),
      effort: EXPLICIT_EFFORT_PATTERN.test(mentionLine),
    },
  };
}

/**
 * Remove the first @netlify mention and its selector words from `text`,
 * plus explicit model:/effort: tokens on that line.
 * @param {string} text
 * @returns {string}
 */
function stripSelection(text) {
  const lines = text.split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const selection = parseMentionLine(lines[index]);
    if (!selection) continue;
    const line = lines[index];
    const after = line.slice(selection.end).replace(/^[ \t]*(?:[:,]|\.(?=\s|$))?[ \t]*/, '');
    lines[index] = (line.slice(0, selection.start) + after)
      .replace(new RegExp(`[ \\t]*${EXPLICIT_MODEL_PATTERN.source}`, 'i'), '')
      .replace(new RegExp(`[ \\t]*${EXPLICIT_EFFORT_PATTERN.source}`, 'i'), '');
    break;
  }
  return lines.join('\n');
}

/**
 * Header segment describing a run's configuration, e.g. "claude · Fable 5 · high".
 * Uses the catalog label for known models and shows the user-facing effort
 * level (GLM 5.2's wire "xhigh" is shown as "max").
 * @param {{ agent?: string | null, model?: string | null, effort?: string | null }} config
 * @returns {string}
 */
function describeRunConfig({ agent, model, effort }) {
  const parts = [String(agent || 'codex')];
  const known = model ? catalog.modelById(model) : undefined;
  if (model) parts.push(known ? known.label : String(model));
  if (effort) {
    const level = known ? catalog.findEffort(known.efforts, String(effort)) : undefined;
    parts.push(level ? level.id : String(effort));
  }
  return parts.join(' · ').replace(/\|/g, '/');
}

// ---------------------------------------------------------------------------
// Scope guidance appended to agent prompts (scope-instructions input)
// ---------------------------------------------------------------------------

const SCOPE_BLOCK_HEADER = "Scope guidance from this repository's workflow:";
const DEFAULT_SCOPE_GUIDANCE = 'Only modify files needed for this task. If a build or deploy fails for reasons unrelated to your task, do not change build, deploy, or workspace configuration to work around it; finish the task and describe the failure in your result.';

/**
 * Build the block appended to the agent prompt. "default" (or unset) uses the
 * built-in guidance, an empty string or "none" disables it, and anything else
 * replaces the guidance text.
 * @param {string | null | undefined} value
 * @returns {string}
 */
function buildScopeBlock(value) {
  if (value === '' || (typeof value === 'string' && value.trim().toLowerCase() === 'none')) return '';
  const text = value === undefined || value === null || value.trim() === 'default'
    ? DEFAULT_SCOPE_GUIDANCE
    : value.trim();
  if (!text) return '';
  return `\n\n---\n${SCOPE_BLOCK_HEADER}\n${text}`;
}

/**
 * Remove an appended scope block so comments show only what the user wrote.
 * @param {string} text
 * @returns {string}
 */
function stripScopeBlock(text) {
  const match = new RegExp(`\\r?\\n---\\r?\\n${SCOPE_BLOCK_HEADER.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\s\\S]*$`).exec(text);
  return match ? text.slice(0, match.index).replace(/\s+$/, '') : text;
}

/**
 * Strip the @netlify mention, optional agent/model/effort selector words,
 * explicit model:/effort: tokens, and ◌ markers from prompt text.
 * @param {string | null | undefined} text
 * @returns {string}
 */
function cleanPrompt(text) {
  if (!text) return '';
  return stripSelection(stripScopeBlock(text))
    .replace(/◌/g, 'via')
    .trim();
}

/**
 * Escape HTML attribute values to prevent attribute injection when splicing
 * untrusted strings into raw `<a>` / `<img>` tags inside comment bodies.
 * @param {string | null | undefined} value
 * @returns {string}
 */
function escapeAttr(value) {
  return String(value || '').replace(/[&"<>]/g, c => {
    if (c === '&') return '&amp;';
    if (c === '"') return '&quot;';
    if (c === '<') return '&lt;';
    return '&gt;';
  });
}

/**
 * Return `value` only if it parses as a plain http(s) URL with no embedded
 * whitespace or quote characters, otherwise return empty string.
 * @param {string | null | undefined} value
 * @returns {string}
 */
function safeHttpUrl(value) {
  const s = String(value || '').trim();
  return /^https?:\/\/[^\s"'<>]+$/.test(s) ? s : '';
}

/**
 * Escape `[` so attacker-controlled prose interpolated into markdown can't
 * form a `[label](url)` link.
 * @param {string | null | undefined} value
 * @returns {string}
 */
function escapeMarkdownLinks(value) {
  return String(value || '').replace(/\[/g, '\\[');
}

/**
 * Pick a random [flavorText, emoji] pair.
 * @returns {[string, string]}
 */
function randomFlavor() {
  return FLAVOR_MESSAGES[Math.floor(Math.random() * FLAVOR_MESSAGES.length)];
}

/**
 * Build the "contains" expressions for a GitHub Actions `if:` condition.
 * @param {string} field - The GitHub expression field, e.g. `github.event.comment.body`
 * @returns {string[]} Array of `contains(field, '@netlify')` strings
 */
function ghContainsExpressions(field) {
  return TRIGGER_BASES.map(base => `contains(${field}, '@${base}')`);
}

/**
 * Format a prompt for display in a GitHub comment.
 * Bolds the first line and blockquotes all lines.
 * If the prompt exceeds 300 characters, truncates and links to the source.
 * @param {string | null | undefined} prompt
 * @param {string} [sourceUrl] - URL to the original issue/comment containing the full prompt
 * @returns {string}
 */
function formatPromptBlock(prompt, sourceUrl) {
  if (!prompt) return '';
  // Strip every HTML comment the user may have included so attacker-controlled
  // markers — even ones shaped like ours — can never be reflected into a
  // bot-authored comment body.
  prompt = stripAllHtmlComments(prompt);
  if (!prompt) return '';
  const MAX_LENGTH = 350;
  let display = prompt;
  let truncated = false;
  if (prompt.length > MAX_LENGTH) {
    // Cut at the last newline at or before the limit to avoid mid-line truncation
    const lastNewline = prompt.lastIndexOf('\n', MAX_LENGTH);
    const cutAt = lastNewline > 0 ? lastNewline : MAX_LENGTH;
    display = prompt.slice(0, cutAt).trimEnd() + '…';
    truncated = true;
  }
  const lines = display.split('\n');
  lines[0] = `**${lines[0]}**`;
  if (truncated && sourceUrl) {
    lines[lines.length - 1] += ` [See full prompt](${sourceUrl})`;
  }
  const quoted = lines.map(l => `> ${l}`).join('\n');
  return `**Prompt:**\n\n${quoted}\n\n`;
}

/**
 * Format a date string into "2:17pm on April 4th, 2026"
 * Uses TZ environment variable for timezone (defaults to America/Los_Angeles).
 * @param {string} dateStr - ISO date string
 * @returns {string}
 */
function formatRunDate(dateStr) {
  const d = new Date(dateStr);
  const tz = process.env.TZ || 'America/Los_Angeles';
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour: 'numeric', minute: '2-digit',
    month: 'long', day: 'numeric', year: 'numeric', hour12: true,
    timeZoneName: 'short'
  }).formatToParts(d);
  const get = (/** @type {string} */ type) => (parts.find(p => p.type === type) || {}).value || '';
  const hours = get('hour');
  const minutes = get('minute');
  const dayPeriod = get('dayPeriod').toLowerCase();
  const month = get('month');
  const date = parseInt(get('day'), 10);
  const year = get('year');
  const tzAbbr = get('timeZoneName');
  const suffixes = ['th', 'st', 'nd', 'rd'];
  const suffix = (date % 100 >= 11 && date % 100 <= 13) ? 'th' : (suffixes[date % 10] || 'th');
  return `${hours}:${minutes}${dayPeriod} ${tzAbbr} on ${month} ${date}${suffix}, ${year}`;
}

/**
 * Build a status comment body (in-progress state).
 * @param {InProgressCommentOptions} options
 * @returns {string}
 */
function buildInProgressComment({ agentRunUrl, prompt, model, modelLabel, effort, effortLabel, configWarnings, runnerId, ghActionUrl }) {
  const [flavor, emoji] = randomFlavor();
  const clean = cleanPrompt(prompt);
  const sourceUrlMatch = (prompt || '').match(/◌\s+(\S+)/);
  const sourceUrl = sourceUrlMatch ? sourceUrlMatch[1] : '';

  let body = agentRunUrl
    ? `### [Netlify Agent Run Status](${agentRunUrl})\n\n`
    : `### Netlify Agent Run Status\n\n`;

  body += `Netlify Agent Runners ${flavor} ${emoji}\n\n`;
  const config = [`**Agent:** \`${model}\``];
  if (modelLabel) config.push(`**Model:** ${modelLabel}`);
  if (effort) config.push(`**Effort:** \`${effortLabel || effort}\``);
  body += `${config.join(' · ')}\n\n`;
  for (const warning of String(configWarnings || '').split('\n').filter(Boolean)) {
    body += `> ⚠️ ${escapeMarkdownLinks(warning)}\n`;
  }
  if (configWarnings) body += '\n';
  if (clean) body += formatPromptBlock(clean, sourceUrl);

  /** @type {string[]} */
  const links = [];
  if (agentRunUrl) links.push(`[View the in progress agent run in Netlify](${agentRunUrl})`);
  if (ghActionUrl) links.push(`[GitHub Action logs](${ghActionUrl})`);
  if (links.length) body += links.join(' • ') + '\n';

  body += `\n*Started at ${formatRunDate(new Date().toISOString())}*\n`;

  if (runnerId) {
    body += renderRunnerIdMarker(runnerId);
  }
  body += `\n${STATUS_COMMENT_MARKER}`;

  return body;
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  isStopCommand,
  TRIGGER_BASES,
  TRIGGER_PATTERN,
  VALID_MODELS,
  DEFAULT_MODEL,
  MODEL_PATTERN,
  VALID_EFFORTS,
  EXPLICIT_EFFORT_PATTERN,
  EXPLICIT_MODEL_PATTERN,
  FLAVOR_MESSAGES,
  matchesTrigger,
  parseSelection,
  resolveSelection,
  extractModel,
  normalizeEffort,
  extractEffort,
  stripSelection,
  selectorPrefixEnd,
  parseCommand,
  describeRunConfig,
  SCOPE_BLOCK_HEADER,
  DEFAULT_SCOPE_GUIDANCE,
  buildScopeBlock,
  stripScopeBlock,
  cleanPrompt,
  randomFlavor,
  ghContainsExpressions,
  formatPromptBlock,
  formatRunDate,
  buildInProgressComment,
  escapeAttr,
  safeHttpUrl,
  escapeMarkdownLinks,
};
