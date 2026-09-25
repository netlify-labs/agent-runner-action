// Agent Runner provider, model, and effort catalog.
//
// The SDK forwards agent/model/effort as open strings and publishes no
// catalog; consumers own it. This snapshot mirrors NAX's
// src/core/agents/configuration.js, which is synced from the Netlify UI model
// picker (netlify-react-ui AgentConfigModal/models.ts @ 0a61ba66, 2026-08-06).
// Model IDs not listed here can still be requested with `model:<id>`; they are
// passed through for the backend to validate.

/**
 * @typedef {object} CatalogModel
 * @property {string} id Wire model ID sent to Agent Runner.
 * @property {string} label Display label.
 * @property {string} provider Agent provider that owns the model.
 * @property {string[]} aliases Short names accepted after the agent word.
 * @property {boolean} standalone Aliases also work without an agent word.
 * @property {string[]} efforts Supported explicit effort levels.
 */

/** @type {string[]} */
const LOW_MEDIUM_HIGH = ['low', 'medium', 'high'];

/** @type {CatalogModel[]} */
const MODELS = [
  { id: 'claude-opus-5', label: 'Opus 5', provider: 'claude', aliases: ['opus', 'opus-5', 'opus5'], standalone: true, efforts: LOW_MEDIUM_HIGH },
  { id: 'claude-opus-4-8', label: 'Opus 4.8', provider: 'claude', aliases: ['opus-4.8', 'opus-4-8', 'opus4.8'], standalone: true, efforts: LOW_MEDIUM_HIGH },
  { id: 'claude-fable-5', label: 'Fable 5', provider: 'claude', aliases: ['fable', 'fable-5', 'fable5'], standalone: true, efforts: LOW_MEDIUM_HIGH },
  { id: 'claude-sonnet-5', label: 'Sonnet 5', provider: 'claude', aliases: ['sonnet', 'sonnet-5', 'sonnet5'], standalone: true, efforts: LOW_MEDIUM_HIGH },
  { id: 'claude-haiku-4-5', label: 'Haiku 4.5', provider: 'claude', aliases: ['haiku', 'haiku-4.5', 'haiku-4-5'], standalone: true, efforts: LOW_MEDIUM_HIGH },
  { id: 'gpt-5.6-sol', label: 'GPT 5.6 Sol', provider: 'codex', aliases: ['sol'], standalone: false, efforts: LOW_MEDIUM_HIGH },
  { id: 'gpt-5.6-terra', label: 'GPT 5.6 Terra', provider: 'codex', aliases: ['terra'], standalone: false, efforts: LOW_MEDIUM_HIGH },
  { id: 'gpt-5.6-luna', label: 'GPT 5.6 Luna', provider: 'codex', aliases: ['luna'], standalone: false, efforts: LOW_MEDIUM_HIGH },
  { id: 'gpt-5.4-mini', label: 'GPT 5.4 Mini', provider: 'codex', aliases: ['mini'], standalone: false, efforts: LOW_MEDIUM_HIGH },
  { id: 'gemini-3.1-pro-preview', label: 'Gemini 3.1 Pro', provider: 'gemini', aliases: ['pro', 'gemini-3.1-pro'], standalone: false, efforts: LOW_MEDIUM_HIGH },
  { id: 'gemini-3.6-flash', label: 'Gemini 3.6 Flash', provider: 'gemini', aliases: ['flash'], standalone: false, efforts: LOW_MEDIUM_HIGH },
  { id: 'gemini-3.5-flash-lite', label: 'Gemini 3.5 Flash Lite', provider: 'gemini', aliases: ['flash-lite', 'lite'], standalone: false, efforts: LOW_MEDIUM_HIGH },
];

/**
 * Efforts accepted when the model is Auto. The UI hides effort until a model
 * is pinned, but the backend accepts and records these for Auto runs.
 * @type {string[]}
 */
const AUTO_MODEL_EFFORTS = LOW_MEDIUM_HIGH;

/**
 * Words recognized as an effort slot. Levels outside a model's supported set
 * are still consumed so they never leak into the prompt, then dropped to Auto
 * with a warning.
 * @type {string[]}
 */
const EFFORT_WORDS = ['low', 'medium', 'high', 'xhigh', 'max'];

/**
 * Standalone aliases that may also be used as an @netlify-<name> suffix.
 * @type {string[]}
 */
const STANDALONE_SUFFIXES = ['fable', 'opus', 'sonnet', 'haiku'];

/**
 * Find a catalog model by exact wire ID.
 * @param {string | null | undefined} id
 * @returns {CatalogModel | undefined}
 */
function modelById(id) {
  const normalized = String(id || '').trim().toLowerCase();
  return MODELS.find((model) => model.id === normalized);
}

/**
 * Resolve a word to a catalog model. Exact IDs always match. Aliases match
 * within `agent` when one was named, otherwise only standalone aliases match.
 * @param {string} word
 * @param {string | null} agent
 * @returns {CatalogModel | undefined}
 */
function resolveModelWord(word, agent) {
  const normalized = String(word || '').trim().toLowerCase();
  if (!normalized) return undefined;
  const exact = modelById(normalized);
  if (exact) return exact;
  return MODELS.find((model) =>
    model.aliases.includes(normalized)
    && (agent ? model.provider === agent : model.standalone));
}

/**
 * Resolve a configured value (not prompt text) against every alias.
 * @param {string} word
 * @returns {CatalogModel | undefined}
 */
function resolveConfiguredModel(word) {
  const normalized = String(word || '').trim().toLowerCase();
  return modelById(normalized) || MODELS.find((model) => model.aliases.includes(normalized));
}

module.exports = {
  MODELS,
  AUTO_MODEL_EFFORTS,
  EFFORT_WORDS,
  STANDALONE_SUFFIXES,
  modelById,
  resolveModelWord,
  resolveConfiguredModel,
};
