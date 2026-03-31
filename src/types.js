// Shared JSDoc type definitions for the Netlify Agents action.
// These are purely for editor IntelliSense and `tsc --checkJs` — no runtime cost.

/**
 * A GitHub issue/PR comment returned by the API.
 * @typedef {object} IssueComment
 * @property {number} id
 * @property {string} body
 * @property {string} html_url
 */

/**
 * A GitHub reaction returned by the API.
 * @typedef {object} Reaction
 * @property {number} id
 * @property {string} content
 */

/**
 * A timeline event from the issues timeline API.
 * @typedef {object} TimelineEvent
 * @property {string} event
 * @property {{login?: string}} [actor]
 * @property {{issue?: {number?: number, title?: string, body?: string, pull_request?: {url?: string}}}} [source]
 */

/**
 * Subset of the Octokit REST client used by this action.
 * @typedef {object} GitHubClient
 * @property {object} rest
 * @property {object} rest.issues
 * @property {(params: {owner: string, repo: string, issue_number: number, body: string}) => Promise<{data: IssueComment}>} rest.issues.createComment
 * @property {(params: {owner: string, repo: string, comment_id: number}) => Promise<{data: {body: string}}>} rest.issues.getComment
 * @property {(params: {owner: string, repo: string, comment_id: number, body: string}) => Promise<{data: IssueComment}>} rest.issues.updateComment
 * @property {(params: {owner: string, repo: string, issue_number: number, labels: string[]}) => Promise<{data: {id: number, name: string}[]}>} rest.issues.addLabels
 * @property {(params: {owner: string, repo: string, name: string, color: string, description: string}) => Promise<{data: {id: number, name: string}}>} rest.issues.createLabel
 * @property {(params: {owner: string, repo: string, issue_number: number, per_page: number, headers?: Record<string, string>}) => Promise<{data: TimelineEvent[]}>} rest.issues.listEventsForTimeline
 * @property {object} rest.pulls
 * @property {(params: {owner: string, repo: string, pull_number: number}) => Promise<{data: {head: {ref: string, sha: string}, base: {ref: string}, body?: string}}>} rest.pulls.get
 * @property {object} rest.repos
 * @property {(params: {owner: string, repo: string, username: string}) => Promise<{data: {permission: string}}>} rest.repos.getCollaboratorPermissionLevel
 * @property {object} rest.reactions
 * @property {(params: {owner: string, repo: string, comment_id: number, content: string}) => Promise<{data: Reaction}>} rest.reactions.createForIssueComment
 * @property {(params: {owner: string, repo: string, issue_number: number, content: string}) => Promise<{data: Reaction}>} rest.reactions.createForIssue
 */

/**
 * Shape of `context.payload` for the GitHub event types this action handles.
 * @typedef {object} EventPayload
 * @property {{login: string}} [sender]
 * @property {{full_name: string}} [repository]
 * @property {{trigger_text?: string, actor?: string, model?: string}} [inputs]
 * @property {{number: number, body?: string, title?: string, html_url?: string, author_association?: string, pull_request?: {url?: string}}} [issue]
 * @property {{id: number, body?: string, html_url?: string, author_association?: string, user?: {login: string}}} [comment]
 * @property {{number: number, body?: string, html_url?: string, author_association?: string, head: {ref: string, sha: string, repo?: {full_name: string}}, base: {ref: string}}} [pull_request]
 * @property {{body?: string, html_url?: string, author_association?: string, user?: {login: string}}} [review]
 */

/**
 * Subset of the GitHub Actions context object.
 * @typedef {object} ActionContext
 * @property {string} eventName
 * @property {EventPayload} payload
 * @property {{owner: string, repo: string}} repo
 * @property {string} actor
 */

/**
 * Subset of the GitHub Actions core toolkit.
 * @typedef {object} ActionCore
 * @property {(name: string, value: string | number | boolean) => void} setOutput
 * @property {(message: string) => void} setFailed
 */

/**
 * Common parameter bag passed to all action script entry points.
 * @typedef {object} ActionParams
 * @property {GitHubClient} github
 * @property {ActionContext} context
 * @property {ActionCore} core
 */

/**
 * Parameters for buildInProgressComment.
 * @typedef {object} InProgressCommentOptions
 * @property {string} [agentRunUrl]
 * @property {string} prompt
 * @property {string} model
 * @property {string} [runnerId]
 */

/**
 * A single Netlify Agent session from the API.
 * @typedef {object} AgentSession
 * @property {string} id
 * @property {string} [prompt]
 * @property {string} [title]
 * @property {string} [result]
 * @property {string} [state]
 * @property {string} [deploy_url]
 * @property {string} [deploy_id]
 * @property {{agent?: string}} [agent_config]
 */

/**
 * Map of session IDs to supplementary data carried across runs.
 * @typedef {Record<string, {screenshot?: string, gh_action_url?: string}>} SessionDataMap
 */

module.exports = {};
