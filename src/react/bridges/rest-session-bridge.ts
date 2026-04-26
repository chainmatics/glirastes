import type {
  ChatMessage,
  SessionConfig,
  SessionSummary,
  WireChatMessage,
} from '../types.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type HeadersResolver =
  | Record<string, string>
  | (() => Record<string, string> | Promise<Record<string, string>>);

export interface RestSessionBridgeOptions {
  /**
   * Base URL of the sessions collection. Must NOT end with a trailing
   * slash. Examples: `/api/chat/sessions`, `https://api.example.com/chat/sessions`.
   */
  baseUrl: string;
  /**
   * Query-string parameters appended to the `list()` GET request. Use
   * this to filter server-side — for example, hide archived sessions
   * from a soft-delete backend:
   *
   * ```ts
   * listQuery: () => ({ status: 'active' })
   * ```
   *
   * The function is called on every `list()` invocation, so values
   * that depend on runtime state (auth, filters) are re-evaluated.
   */
  listQuery?: () => Record<string, string>;
  /**
   * Static headers or a function that returns headers per request. Useful
   * for injecting `Authorization`.
   */
  headers?: HeadersResolver;
  /** `fetch` credentials mode. Default: `'same-origin'`. */
  credentials?: RequestCredentials;
  /**
   * Inject a custom `fetch` — defaults to `globalThis.fetch`. Pass a
   * preconfigured axios-like wrapper via `request` instead if you need
   * interceptors.
   */
  fetchFn?: typeof fetch;
  /**
   * Full request override. If provided, this function is called for
   * every request and the bridge will not touch `fetchFn`/`headers`.
   * Useful when you already have an axios instance with interceptors.
   *
   * Must return the parsed JSON body (or `undefined` for 204s).
   */
  request?: (init: {
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
    url: string;
    body?: unknown;
  }) => Promise<unknown>;

  /**
   * Body used for `create(opts)` POST requests. Default: `{ title }` when
   * a title was supplied, otherwise `{}`. Override when your backend
   * requires extra fields (e.g. `{ execution_types: ['chat'] }`).
   */
  createBody?: (opts: { title?: string }) => unknown;
  /**
   * How to delete a session. Default: `{ method: 'DELETE' }`. Override
   * when your backend uses soft deletes — e.g. archive via
   * `{ method: 'PATCH', body: { status: 'archived' } }`.
   */
  removeRequest?: (id: string) => {
    method: 'DELETE' | 'PATCH' | 'POST';
    body?: unknown;
  };
  /**
   * Path of the messages sub-collection, relative to a session. Default:
   * `/messages`.
   */
  messagesPath?: string;

  /**
   * Map a backend session row onto `SessionSummary`. The default handles
   * both `camelCase` and `snake_case` variants of the common fields
   * (`id`, `title` / `name`, `createdAt` / `created_at`, etc.).
   */
  mapSession?: (row: unknown) => SessionSummary;
  /**
   * Map a backend message row onto the SDK's `ChatMessage` shape. The
   * default reads `{ id, role, content, created_at }` (or `createdAt`),
   * which covers most REST chat backends. Returning a `WireChatMessage`
   * is also fine — the provider coerces it.
   */
  mapMessage?: (row: unknown) => ChatMessage | WireChatMessage | null;
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function pickString(row: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const v = row[key];
    if (typeof v === 'string') return v;
  }
  return undefined;
}

function pickDate(
  row: Record<string, unknown>,
  ...keys: string[]
): string | number | undefined {
  for (const key of keys) {
    const v = row[key];
    if (typeof v === 'string' || typeof v === 'number') return v;
  }
  return undefined;
}

function pickNumber(row: Record<string, unknown>, ...keys: string[]): number | undefined {
  for (const key of keys) {
    const v = row[key];
    if (typeof v === 'number') return v;
  }
  return undefined;
}

function defaultMapSession(row: unknown): SessionSummary {
  if (!isRecord(row)) {
    return { id: '', title: 'Untitled' };
  }
  const id = pickString(row, 'id', 'sessionId', 'session_id') ?? '';
  const title = pickString(row, 'title', 'name') ?? 'New chat';
  const createdAt = pickDate(row, 'createdAt', 'created_at');
  const updatedAt = pickDate(row, 'updatedAt', 'updated_at');
  const messageCount = pickNumber(row, 'messageCount', 'message_count');
  const status = pickString(row, 'status');
  return {
    id,
    title,
    createdAt,
    updatedAt,
    messageCount,
    status: status === 'active' || status === 'archived' ? status : status,
  };
}

function defaultMapMessage(row: unknown): WireChatMessage | null {
  if (!isRecord(row)) return null;
  const id = pickString(row, 'id') ?? '';
  const role = (pickString(row, 'role') ?? 'user') as WireChatMessage['role'];
  const content = pickString(row, 'content', 'text') ?? null;
  const createdAtRaw = row.createdAt ?? row.created_at;
  return {
    id,
    role,
    content,
    createdAt:
      typeof createdAtRaw === 'string' ||
      typeof createdAtRaw === 'number' ||
      createdAtRaw instanceof Date
        ? createdAtRaw
        : undefined,
  };
}

async function resolveHeaders(
  headers: HeadersResolver | undefined,
): Promise<Record<string, string>> {
  if (!headers) return {};
  if (typeof headers === 'function') return await headers();
  return headers;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Build a `SessionConfig` from a standard REST chat backend.
 *
 * The factory wires the five session hooks (`list`, `load`, `create`,
 * `remove`, `rename`) to a conventional REST layout:
 *
 * | Hook     | Request                                    |
 * |----------|--------------------------------------------|
 * | `list`   | `GET    {baseUrl}`                         |
 * | `load`   | `GET    {baseUrl}/{id}{messagesPath}`      |
 * | `create` | `POST   {baseUrl}` with `createBody(opts)` |
 * | `remove` | `DELETE {baseUrl}/{id}` (or PATCH via `removeRequest`) |
 * | `rename` | `PATCH  {baseUrl}/{id}` with `{ title }`   |
 *
 * All field-name mapping is done through `mapSession` / `mapMessage`,
 * which have defaults that tolerate both `snake_case` and `camelCase`.
 * For anything exotic (different status codes, non-JSON bodies, etc.),
 * pass `request` and take over the transport entirely.
 *
 * @example
 * ```ts
 * // Chaingrow — uses archive-instead-of-delete and a non-standard create body
 * export const chainGrowSessions = createRestSessionBridge({
 *   baseUrl: `${API_URL}/chat/sessions`,
 *   headers: () => ({ Authorization: `Bearer ${authStore.getState().token}` }),
 *   createBody: () => ({ execution_types: ['chat'] }),
 *   removeRequest: () => ({ method: 'PATCH', body: { status: 'archived' } }),
 * });
 * ```
 */
export function createRestSessionBridge(
  options: RestSessionBridgeOptions,
): SessionConfig {
  const {
    baseUrl,
    headers,
    credentials = 'same-origin',
    fetchFn,
    request: customRequest,
    createBody = ({ title }) => (title ? { title } : {}),
    removeRequest = () => ({
      method: 'DELETE' as const,
      body: undefined as unknown,
    }),
    messagesPath = '/messages',
    mapSession = defaultMapSession,
    mapMessage = defaultMapMessage,
    listQuery,
  } = options;

  const doFetch: typeof fetch =
    fetchFn ??
    ((typeof globalThis !== 'undefined' && globalThis.fetch) as typeof fetch);

  const request = customRequest
    ? customRequest
    : async ({
        method,
        url,
        body,
      }: {
        method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
        url: string;
        body?: unknown;
      }): Promise<unknown> => {
        if (!doFetch) {
          throw new Error(
            '[createRestSessionBridge] No `fetch` available. Pass `fetchFn` or `request`.',
          );
        }
        const mergedHeaders: Record<string, string> = {
          Accept: 'application/json',
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
          ...(await resolveHeaders(headers)),
        };
        const res = await doFetch(url, {
          method,
          credentials,
          headers: mergedHeaders,
          ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        });
        if (!res.ok) {
          throw new Error(
            `[createRestSessionBridge] ${method} ${url} → HTTP ${res.status}`,
          );
        }
        if (res.status === 204) return undefined;
        const text = await res.text();
        if (!text) return undefined;
        try {
          return JSON.parse(text);
        } catch {
          return text;
        }
      };

  const buildListUrl = (): string => {
    if (!listQuery) return baseUrl;
    const params = listQuery();
    const entries = Object.entries(params).filter(([, v]) => v !== undefined);
    if (entries.length === 0) return baseUrl;
    const qs = entries
      .map(
        ([k, v]) =>
          `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`,
      )
      .join('&');
    const sep = baseUrl.includes('?') ? '&' : '?';
    return `${baseUrl}${sep}${qs}`;
  };

  return {
    list: async () => {
      const rows = await request({ method: 'GET', url: buildListUrl() });
      if (!Array.isArray(rows)) return [];
      return rows.map(mapSession);
    },

    load: async (id) => {
      const rows = await request({
        method: 'GET',
        url: `${baseUrl}/${encodeURIComponent(id)}${messagesPath}`,
      });
      // Some APIs wrap messages in `{ messages: [...] }`; unwrap if needed.
      const list: unknown[] = Array.isArray(rows)
        ? rows
        : isRecord(rows) && Array.isArray(rows.messages)
          ? (rows.messages as unknown[])
          : [];
      return list
        .map(mapMessage)
        .filter((m): m is ChatMessage | WireChatMessage => m !== null);
    },

    create: async (opts = {}) => {
      const created = await request({
        method: 'POST',
        url: baseUrl,
        body: createBody(opts),
      });
      return mapSession(created);
    },

    remove: async (id) => {
      const { method, body } = removeRequest(id);
      await request({
        method,
        url: `${baseUrl}/${encodeURIComponent(id)}`,
        body,
      });
    },

    rename: async (id, title) => {
      await request({
        method: 'PATCH',
        url: `${baseUrl}/${encodeURIComponent(id)}`,
        body: { title },
      });
    },
  };
}
