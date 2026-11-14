import {
  DEFAULT_ATTACHMENT_MAX_FILE_BYTES,
  DEFAULT_ATTACHMENT_MAX_FILES,
  DEFAULT_ATTACHMENT_MEDIA_TYPES,
  SNIFFABLE_MEDIA_TYPES,
  parseDataUrl,
  sniffMediaType,
} from '../../../contracts/attachments.js';
import { publicOrigins } from './context-helpers.js';
import type { ChatAttachmentsConfig } from './types.js';

/** Default cap on the request body of the chat handler: 1 MB. */
export const DEFAULT_MAX_BODY_BYTES = 1_000_000;
/** Default body cap once `attachments.enabled` is set: 50 MB. */
export const DEFAULT_ATTACHMENT_MAX_BODY_BYTES = 50_000_000;

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

/** `value` without its trailing slashes; a plain loop, linear in the length (no regular expression). */
function withoutTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value.charCodeAt(end - 1) === 0x2f) end -= 1;
  return value.slice(0, end);
}

function configuredOrigins(allowed: ReadonlyArray<string> = []): Set<string> {
  return new Set(allowed.map(withoutTrailingSlashes).filter((origin) => origin !== 'null'));
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

/**
 * Checks every file part of the history: 400 while attachments are disabled,
 * for a remote URL without `allowRemoteUrls`, more than `maxFiles` in one
 * message, or bytes that do not match the declared type; 415 for a type
 * outside `mediaTypes`; 413 for a decoded file over `maxFileBytes`.
 */
export function validateAttachments(
  messages: ReadonlyArray<unknown>,
  config: ChatAttachmentsConfig | undefined,
): Response | undefined {
  const enabled = config?.enabled === true;
  const maxFiles = config?.maxFiles ?? DEFAULT_ATTACHMENT_MAX_FILES;
  const maxFileBytes = config?.maxFileBytes ?? DEFAULT_ATTACHMENT_MAX_FILE_BYTES;
  const mediaTypes = new Set((config?.mediaTypes ?? DEFAULT_ATTACHMENT_MEDIA_TYPES).map((type) => type.toLowerCase()));
  const invalid = (message: string) => json(400, 'invalid_attachment', message);

  for (const message of messages) {
    const parts = (message as { parts?: unknown } | null)?.parts;
    if (!Array.isArray(parts)) continue;
    let files = 0;
    for (const part of parts) {
      if ((part as { type?: unknown } | null)?.type !== 'file') continue;
      if (!enabled) return json(400, 'attachments_disabled', 'This chat does not accept attachments.');
      files += 1;
      if (files > maxFiles) return json(400, 'too_many_attachments', `At most ${maxFiles} attachments per message.`);
      const { url, mediaType } = part as { url?: unknown; mediaType?: unknown };
      if (typeof url !== 'string' || url === '' || typeof mediaType !== 'string') {
        return invalid('An attachment has no data or no media type.');
      }
      const declared = mediaType.toLowerCase();
      if (!mediaTypes.has(declared)) {
        return json(415, 'unsupported_attachment_type', 'This attachment type is not accepted.');
      }
      if (!url.startsWith('data:')) {
        if (!config?.allowRemoteUrls) return json(400, 'remote_attachment_refused', 'Attachments must be sent as data URLs.');
        if (!/^https?:\/\//i.test(url)) return invalid('A remote attachment must be an http(s) URL.');
        continue;
      }
      const parsed = parseDataUrl(url);
      if (!parsed || (parsed.mediaType !== '' && parsed.mediaType !== declared)) {
        return invalid('An attachment is not a base64 data URL of its declared type.');
      }
      if (parsed.decodedBytes > maxFileBytes) {
        return json(413, 'attachment_too_large', 'An attachment is too large.');
      }
      if (SNIFFABLE_MEDIA_TYPES.includes(declared) && sniffMediaType(parsed.head) !== declared) {
        return invalid('An attachment\'s content does not match its declared type.');
      }
    }
  }
  return undefined;
}
