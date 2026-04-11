/**
 * @typedef {Object} ModelMessage
 * @property {'user'|'assistant'|'system'} role
 * @property {string} content
 */

/**
 * @typedef {Object} ContextPackRule
 * @property {string} id
 * @property {string} rule_type
 * @property {string} title
 * @property {string} content
 * @property {string} priority
 * @property {string} [tags]
 * @property {number} is_active
 */

/**
 * @typedef {Object} ContextPackMemory
 * @property {string} id
 * @property {string} scope
 * @property {string|null} thread_id
 * @property {string} memory_type
 * @property {string} title
 * @property {string} content
 * @property {string} priority
 * @property {string} [tags]
 */

/**
 * @typedef {Object} ContextPackSummary
 * @property {string} id
 * @property {string} thread_id
 * @property {string} summary_text
 * @property {'rolling'|'milestone'|'decision_log'} summary_type
 * @property {string|null} covered_until_message_id
 */

/**
 * @typedef {Object} ContextPackTurn
 * @property {string} id
 * @property {string} user_text
 * @property {string|null} [user_attachments_json]
 * @property {string|null} assistant_text
 * @property {string} user_message_at
 */

/**
 * @typedef {Object} ContextPackThreadMessage
 * @property {string} id
 * @property {string} role
 * @property {string} content
 * @property {string} created_at
 */

/**
 * @typedef {Object} ContextPack
 * @property {string} threadId
 * @property {string} dialogTitle
 * @property {string} themeTitle
 * @property {ContextPackRule[]} rules
 * @property {ContextPackMemory[]} memoryItems
 * @property {ContextPackSummary[]} summaries
 * @property {ContextPackTurn[]} turns
 * @property {ContextPackThreadMessage[]} threadMessages
 * @property {string} userQuery
 */

/**
 * @typedef {Object} RetrievedChunk
 * @property {string} id
 * @property {string} source
 * @property {string} text
 * @property {number} score
 */

/**
 * @typedef {Object} AccessCatalogEntry
 * @property {string} [id]
 * @property {string} name
 * @property {string} [description]
 * @property {string} [endpointUrl]
 */

/**
 * @typedef {Object} BuildModelContextInput
 * @property {string} threadId
 * @property {string} userPrompt
 * @property {ContextPack} contextPack
 * @property {Record<string, unknown>} [modelFlags]
 * @property {AccessCatalogEntry[]} [accessServicesCatalog]
 * @property {string} [memoryTreeSupplement] — plain text from Memory tree router (markers added here)
 */

/**
 * @typedef {Object} BuiltModelContext
 * @property {string} systemCore
 * @property {string} activeRulesDigest
 * @property {string} relevantMemoryBlock
 * @property {string} accessCatalogBlock
 * @property {RetrievedChunk[]} retrievedChunks
 * @property {ModelMessage[]} recentMessages
 * @property {ModelMessage[]} finalMessagesForModel
 * @property {string} combinedSystemInstruction
 * @property {Object} debug
 */

export {};
