import type { IncomingMessage, ServerResponse } from "node:http";

/** A Web-standard handler, e.g. the one `createAiChatHandler` returns. */
export type WebHandler = (request: Request) => Response | Promise<Response>;

/** A `node:http` request, optionally after a framework body parser ran. */
export type NodeRequest = IncomingMessage & {
  /** Set by a body parser that already consumed the stream (Express, Nest, Fastify via Object.assign). */
  body?: unknown;
  /** Exact request bytes, e.g. NestFactory.create(App, { rawBody: true }). */
  rawBody?: unknown;
  /** Express: the URL before router mounting stripped it. */
  originalUrl?: string;
};

/** A `node:http` response. */
export type NodeResponse = ServerResponse;

/** A `(req, res)` handler for node:http-style servers. It never rejects. */
export type NodeHandler = (req: NodeRequest, res: NodeResponse) => Promise<void>;
