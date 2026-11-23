/**
 * glirastes/server/node — bridges node:http-style servers (node:http,
 * Express, Fastify via reply.raw, NestJS on Express) to a Web-standard
 * handler such as `createAiChatHandler`. Runs in the consumer's process only.
 */
export { createNodeHandler } from "./handler.js";
export type { NodeHandlerOptions } from "./handler.js";
export { toWebRequest } from "./request.js";
export type { ToWebRequestOptions } from "./request.js";
export { sendWebResponse } from "./response.js";
export type { SendWebResponseOptions } from "./response.js";
export { RequestBodyTooLargeError } from "./body.js";
export type {
  NodeHandler,
  NodeRequest,
  NodeResponse,
  WebHandler,
} from "./types.js";
