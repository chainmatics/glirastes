/**
 * Turn-scoped result handles: names shared by the chat handler, the server
 * core and the chat UI. Dependency-free so the React bundle can import it.
 * Nothing here is part of the Platform wire contract.
 */

/** The built-in tool that reads more of a large tool result within the running turn. */
export const READ_RESULT_TOOL_NAME = 'read_result' as const;

/** Prefix of the id of a result produced by a read tool (calling it again is safe). */
export const READ_RESULT_ID_PREFIX = 'ro_' as const;
/** Prefix of the id of a result produced by any other tool (it may have written). */
export const WRITE_RESULT_ID_PREFIX = 'rw_' as const;
