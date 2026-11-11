import { publicOrigins } from './context-helpers.js';

/** Default cap on the request body of the chat handler: 1 MB. */
export const DEFAULT_MAX_BODY_BYTES = 1_000_000;

export interface RequestGuardOptions {
  /** Origins besides the request's own that may post from a browser. */
  allowedOrigins?: ReadonlyArray<string>;
  /** `false` turns the browser cross-origin check off. Default: on. */
  crossOriginProtection?: boolean;
}

const json = (status: number, error: string, message: string): Response => new Response(
  JSON.stringify({ error, message }),
  { status, headers: { 'Content-Type': 'application/json' } },
);

/**
 * Refuses a request a browser sent for another site, and a body that is not
 * JSON.
 *
 * The chat route authenticates with the user's cookie, and a page on another
 * site (also another subdomain of the same site) can make the browser post to
 * it with that cookie. A `text/plain` form post needs no CORS preflight, so
 * the content type must be JSON, which a cross-origin page cannot send
 * without a preflight; and a browser cross-origin request is refused:
 *
 * - `Origin: null` (a sandboxed or opaque origin) is always refused.
 * - `Sec-Fetch-Site`, when present, must be `same-origin` (or `none`, a
 *   navigation by the user); `same-site` and `cross-site` pass only with an
 *   `Origin` listed in `allowedOrigins`.
 * - Otherwise `Origin`, when present, must be the request's own origin (the
 *   request URL's, the Host header's, or the first forwarded host and
 *   protocol, see `publicOrigins`) or one of `allowedOrigins`.
 * - A request with neither header is not from a browser (server to server).
 */
export function checkRequestHeaders(req: Request, options: RequestGuardOptions = {}): Response | undefined {
  if (options.crossOriginProtection !== false) {
    const site = req.headers.get('sec-fetch-site');
    const origin = req.headers.get('origin');
    const refused = () => json(403, 'cross_origin_request_refused', 'Cross-origin requests are not allowed.');
    if (origin === 'null') return refused();
    if (site !== null) {
      // The browser's own verdict. Another site or subdomain passes only with
      // an Origin the app listed itself; the request's own origin does not
      // count here, because the browser says the request is not from it.
      if (site !== 'same-origin' && site !== 'none') {
        if (origin === null || !configuredOrigins(options.allowedOrigins).has(origin)) return refused();
      }
    } else if (origin !== null && !ownOrigins(req, options.allowedOrigins).has(origin)) {
      return refused();
    }
  }
  const mediaType = (req.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
  if (mediaType !== 'application/json') {
    return json(415, 'unsupported_media_type', 'The request body must be application/json.');
  }
  return undefined;
}

function configuredOrigins(allowed: ReadonlyArray<string> = []): Set<string> {
  return new Set(allowed.map((origin) => origin.replace(/\/+$/, '')).filter((origin) => origin !== 'null'));
}

function ownOrigins(req: Request, allowed: ReadonlyArray<string> = []): Set<string> {
  const origins = configuredOrigins(allowed);
  for (const origin of publicOrigins(req)) origins.add(origin);
  return origins;
}

const tooLarge = (): Response => json(413, 'payload_too_large', 'The request body is too large.');

/**
 * Reads the JSON body, or answers 413 once it exceeds `maxBytes` and 400
 * (`invalid_json`) when it does not parse. The declared
 * `Content-Length` is checked before the body is read, and the bytes actually
 * read are counted, because the header may be absent (chunked) or wrong.
 */
export async function readJsonBody(
  req: Request,
  maxBytes: number = DEFAULT_MAX_BODY_BYTES,
): Promise<{ ok: true; value: unknown } | { ok: false; response: Response }> {
  const declared = Number(req.headers.get('content-length'));
  if (req.headers.get('content-length') !== null && Number.isFinite(declared) && declared > maxBytes) {
    return { ok: false, response: tooLarge() };
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  if (req.body) {
    const reader = req.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        return { ok: false, response: tooLarge() };
      }
      chunks.push(value);
    }
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return { ok: true, value: JSON.parse(new TextDecoder().decode(bytes)) };
  } catch {
    // A client error, not a server failure: no 500 and no onError.
    return { ok: false, response: json(400, 'invalid_json', 'The request body is not valid JSON.') };
  }
}
