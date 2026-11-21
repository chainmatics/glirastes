/**
 * Default cap on the request body of the chat handler: 1 MB. A leaf module
 * (no imports), so glirastes/server/node shares the value without loading
 * the server core.
 */
export const DEFAULT_MAX_BODY_BYTES = 1_000_000;
