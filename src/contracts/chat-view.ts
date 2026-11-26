/**
 * Chat Views: the framework-neutral contract of generative UI in chat. The
 * model emits a `ChatViewSpec`, the server validates and resolves it against
 * the component manifest, the browser renders a `ResolvedChatView`.
 * Dependency-free apart from Zod so the React bundle can import it.
 */
import { z } from 'zod';

/** The built-in tool through which the model renders a chat view. */
export const RENDER_VIEW_TOOL_NAME = 'render_view' as const;

export const CHAT_VIEW_LIMITS = {
  maxElements: 60,
  maxDepth: 6,
  maxSpecBytes: 8192,
  maxLiteralChars: 200,
  maxTableRows: 50,
  maxTableColumns: 8,
  maxNarrowTableColumns: 3,
  maxProjectionBytes: 65536,
  maxSourceMemoEntries: 10,
} as const;

const elementIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,40}$/);

export const chatValueRefSchema = z.object({ $ref: z.string(), path: z.string() });
export type ChatValueRef = z.infer<typeof chatValueRefSchema>;

export const chatItemRefSchema = z.object({ $item: z.string() });
export type ChatItemRef = z.infer<typeof chatItemRefSchema>;

export const chatOperatorSchema = z.union([
  z.object({ $count: chatValueRefSchema }),
  z.object({ $sum: chatValueRefSchema }),
]);
export type ChatOperator = z.infer<typeof chatOperatorSchema>;

export const chatSaidSchema = z.object({
  $said: z.string().max(CHAT_VIEW_LIMITS.maxLiteralChars),
  basis: chatValueRefSchema,
});
export type ChatSaid = z.infer<typeof chatSaidSchema>;

/** Model input of the `render_view` tool. */
export const chatViewSpecSchema = z.object({
  root: elementIdSchema,
  elements: z.record(
    elementIdSchema,
    z.object({
      type: z.string(),
      props: z.record(z.string(), z.unknown()),
      children: z.array(elementIdSchema).optional(),
    }),
  ),
  caption: z.string().max(CHAT_VIEW_LIMITS.maxLiteralChars).optional(),
});
export type ChatViewSpec = z.infer<typeof chatViewSpecSchema>;

const jsonSchemaObjectSchema = z.record(z.string(), z.unknown());

export const chatComponentManifestEntrySchema = z.object({
  id: z.string(),
  schemaVersion: z.number().int().min(1),
  description: z.string(),
  whenToUse: z.string().optional(),
  props: jsonSchemaObjectSchema,
  bindable: z.array(z.string()),
  refOnly: z.array(z.string()),
  children: z.union([z.literal('none'), z.literal('any'), z.array(z.string())]),
  itemScope: z.object({ rowsProp: z.string(), cellsProp: z.string() }).optional(),
  text: z.object({
    label: z.string().optional(),
    value: z.string().optional(),
    rows: z.string().optional(),
    columns: z.string().optional(),
  }),
});
export type ChatComponentManifestEntry = z.infer<typeof chatComponentManifestEntrySchema>;

export const chatComponentManifestSchema = z.object({
  v: z.literal(1),
  components: z.array(chatComponentManifestEntrySchema),
});
export type ChatComponentManifest = z.infer<typeof chatComponentManifestSchema>;

/** Browser contract: a validated, fully resolved view. */
export const resolvedChatViewSchema = z.object({
  v: z.literal(1),
  root: z.string(),
  caption: z.string().optional(),
  elements: z.record(
    z.string(),
    z.object({
      type: z.string(),
      schemaVersion: z.number().int().min(1),
      props: z.record(z.string(), z.unknown()),
      children: z.array(z.string()).optional(),
      rows: z.array(z.record(z.string(), z.unknown())).optional(),
      said: z.literal(true).optional(),
    }),
  ),
});
export type ResolvedChatView = z.infer<typeof resolvedChatViewSchema>;

/** What the client tells the server it can render (request body). */
export const chatViewCapabilitiesSchema = z.object({
  components: z
    .array(z.object({ id: z.string(), schemaVersion: z.number().int().min(1) }))
    .optional(),
  surface: z.enum(['narrow', 'workspace']).optional(),
});
export type ChatViewCapabilities = z.infer<typeof chatViewCapabilitiesSchema>;

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

/** Pure sha-256 (hex) so the contract stays free of Node built-ins. */
function sha256Hex(text: string): string {
  const data = new TextEncoder().encode(text);
  const padded = new Uint8Array((((data.length + 9 + 63) >> 6) << 6));
  padded.set(data);
  padded[data.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 8, Math.floor((data.length * 8) / 0x100000000));
  view.setUint32(padded.length - 4, (data.length * 8) >>> 0);
  const h = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  const w = new Uint32Array(64);
  const rotr = (x: number, n: number) => (x >>> n) | (x << (32 - n));
  for (let offset = 0; offset < padded.length; offset += 64) {
    for (let i = 0; i < 16; i += 1) w[i] = view.getUint32(offset + i * 4);
    for (let i = 16; i < 64; i += 1) {
      const s0 = rotr(w[i - 15]!, 7) ^ rotr(w[i - 15]!, 18) ^ (w[i - 15]! >>> 3);
      const s1 = rotr(w[i - 2]!, 17) ^ rotr(w[i - 2]!, 19) ^ (w[i - 2]! >>> 10);
      w[i] = (w[i - 16]! + s0 + w[i - 7]! + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, hh] = h as unknown as number[] as [
      number, number, number, number, number, number, number, number,
    ];
    for (let i = 0; i < 64; i += 1) {
      const t1 =
        (hh + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + K[i]! + w[i]!) >>> 0;
      const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) >>> 0;
      hh = g;
      g = f;
      f = e;
      e = (d + t1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) >>> 0;
    }
    const next = [a, b, c, d, e, f, g, hh];
    for (let i = 0; i < 8; i += 1) h[i] = (h[i]! + next[i]!) >>> 0;
  }
  return Array.from(h, (n) => n.toString(16).padStart(8, '0')).join('');
}

/** sha-256 hex of the manifest's canonical (sorted-keys) JSON. */
export function chatComponentManifestDigest(manifest: ChatComponentManifest): string {
  return sha256Hex(canonicalJson(manifest));
}
