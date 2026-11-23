/**
 * Texts in any number of languages, keyed by BCP-47 language tags (`de`,
 * `pl-PL`, `zh-Hant`). A plain string has no language: it is used for every
 * language, so code that writes one text keeps working where a map is allowed.
 *
 * One fallback order everywhere (tool labels, titles, descriptions, built-in
 * texts of server and browser): the requested tag, then the same language
 * with a shorter or another region (`pl-PL` → `pl` → `pl-XX`), then English
 * (`en`, `en-*`), then the first tag in code-unit order. Framework-neutral and
 * dependency-free: the generator, the runtime and the browser share it.
 */

/** A BCP-47 language tag as Glirastes accepts it: a 2–3 letter language and up to four subtags. */
export const LANGUAGE_TAG_PATTERN = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{1,8}){0,4}$/;

/** At most this many languages per text; more are rejected rather than cut. */
export const MAX_TEXT_LANGUAGES = 50;

export type LanguageTag = string;
/** One text for all languages, or one per language tag. */
export type LocalizedText = string | Readonly<Record<LanguageTag, string>>;

export function isLanguageTag(value: unknown): boolean {
  return typeof value === 'string' && value.length <= 35 && LANGUAGE_TAG_PATTERN.test(value);
}

/** The primary language subtag in lower case: `pl` for `pl-PL`. */
export function primaryLanguage(tag: string): string {
  return tag.split('-')[0]!.toLowerCase();
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * The key of `keys` that serves `requested` at the request level: the same
 * tag (case-insensitive), a shorter tag of it (`zh-Hant` for `zh-Hant-TW`),
 * else another tag of the same language, the shortest and then the first in
 * code-unit order. Undefined when no key shares the language.
 */
function requestLevelKey(keys: ReadonlyArray<string>, requested: string): string | undefined {
  const wanted = requested.toLowerCase().replace(/_/g, '-');
  const lower = new Map(keys.map((key) => [key.toLowerCase(), key] as const));
  const parts = wanted.split('-');
  for (let length = parts.length; length > 0; length -= 1) {
    const hit = lower.get(parts.slice(0, length).join('-'));
    if (hit !== undefined) return hit;
  }
  const language = parts[0]!;
  return keys
    .filter((key) => primaryLanguage(key) === language)
    .sort((left, right) => left.split('-').length - right.split('-').length || compareCodeUnits(left, right))[0];
}

/**
 * The key of `keys` to use for `requested`: request level (see above), then
 * English, then the first key in code-unit order. Undefined only for no keys.
 */
export function pickLanguage(keys: ReadonlyArray<string>, requested: string | undefined): string | undefined {
  if (keys.length === 0) return undefined;
  if (requested) {
    const own = requestLevelKey(keys, requested);
    if (own !== undefined) return own;
  }
  return requestLevelKey(keys, 'en') ?? [...keys].sort(compareCodeUnits)[0];
}

/**
 * The most preferred language tag of an `Accept-Language` header value
 * (`pl-PL,pl;q=0.9,en;q=0.8` → `pl-PL`); undefined for none, `*` or an
 * unreadable value. Only for a request locale the app chose to take from it.
 */
export function preferredLanguage(header: string | null | undefined): string | undefined {
  if (!header || header.length > 1_000) return undefined;
  let best: { tag: string; q: number } | undefined;
  for (const part of header.split(',').slice(0, 30)) {
    const [rawTag, ...parameters] = part.trim().split(';');
    const tag = rawTag?.trim() ?? '';
    if (!isLanguageTag(tag)) continue;
    const quality = parameters.map((parameter) => /^\s*q\s*=\s*([01](?:\.\d{0,3})?)\s*$/.exec(parameter)).find(Boolean);
    const q = quality ? Number(quality[1]) : 1;
    if (q > 0 && (best === undefined || q > best.q)) best = { tag, q };
  }
  return best?.tag;
}

/**
 * The request header the chat UI names its language in (`pl-PL`), with
 * every request of the React/Vercel transport and `<glirastes-chat>`. A
 * CORS-safelisted header: a cross-origin embed needs no extra allowed header.
 */
export const CHAT_LANGUAGE_HEADER = 'content-language';

/** The chat language of a `CHAT_LANGUAGE_HEADER` value: exactly one language tag, else undefined (a list, `*`). */
export function chatLanguageOf(value: string | null | undefined): string | undefined {
  const tag = value?.trim();
  return tag && isLanguageTag(tag) ? tag : undefined;
}

/** The text of `value` for `requested`; a plain string serves every language. */
export function resolveLocalizedText(value: LocalizedText | undefined, requested: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value === 'string') return value;
  const key = pickLanguage(Object.keys(value), requested);
  return key === undefined ? undefined : value[key];
}

/**
 * The value for `requested` from layers ordered highest first, each a value
 * without a language or one per tag. Per level of the fallback order the
 * highest layer that serves it wins: a language-free value serves the
 * request level, so a lower layer's own translation beats a higher layer's
 * English one only where the higher layer has neither the language nor a
 * language-free value. A layer may be `undefined`.
 */
export function resolveLayered<T>(
  layers: ReadonlyArray<TextLayer<T> | undefined>,
  requested: string | undefined,
): T | undefined {
  return resolveLayeredEntry(layers, requested)?.value;
}

/** One source of a text: a language-free value, values per language tag, or both. */
export interface TextLayer<T> {
  readonly any?: T;
  readonly byLanguage?: Readonly<Record<string, T>>;
}

/** What `resolveLayeredEntry` found: the value, the index of its layer and its tag (absent for a language-free value). */
export interface LayeredText<T> {
  value: T;
  layer: number;
  language?: string;
  /** `request` when the value serves the requested language (or is language-free), else `fallback`. */
  level: 'request' | 'fallback';
}

/** `resolveLayered` with the layer and the language tag the value came from. */
export function resolveLayeredEntry<T>(
  layers: ReadonlyArray<TextLayer<T> | undefined>,
  requested: string | undefined,
): LayeredText<T> | undefined {
  const present = layers
    .map((layer, index) => ({ layer, index }))
    .filter((item): item is { layer: TextLayer<T>; index: number } => (
      item.layer !== undefined && (item.layer.any !== undefined || Object.keys(item.layer.byLanguage ?? {}).length > 0)
    ));
  const at = (wanted: string, level: LayeredText<T>['level']): LayeredText<T> | undefined => {
    for (const { layer, index } of present) {
      const key = requestLevelKey(Object.keys(layer.byLanguage ?? {}), wanted);
      if (key !== undefined) return { value: layer.byLanguage![key]!, layer: index, language: key, level };
      if (layer.any !== undefined) return { value: layer.any, layer: index, level };
    }
    return undefined;
  };
  if (requested) {
    const own = at(requested, 'request');
    if (own !== undefined) return own;
  } else {
    const free = present.find(({ layer }) => layer.any !== undefined);
    if (free) return { value: free.layer.any!, layer: free.index, level: 'request' };
  }
  const english = at('en', 'fallback');
  if (english !== undefined) return english;
  for (const { layer, index } of present) {
    const key = pickLanguage(Object.keys(layer.byLanguage ?? {}), undefined);
    if (key !== undefined) return { value: layer.byLanguage![key]!, layer: index, language: key, level: 'fallback' };
  }
  return undefined;
}

/** A `LocalizedText` as a layer: a plain string is language-free. */
export function textLayer(value: LocalizedText | undefined): TextLayer<string> | undefined {
  if (value === undefined) return undefined;
  return typeof value === 'string' ? { any: value } : { byLanguage: value };
}

/**
 * Built-in texts per language with per-key fallback: for each key, the
 * first table that has it in the order of `pickLanguage`, the app's tables
 * before the shipped ones at every level. `overrides` (language-free) wins
 * for every language, as a flat override always did.
 */
export function resolveTextTable<T extends object>(input: {
  requested: string | undefined;
  /** Shipped texts per language; must hold a complete `en`. */
  builtIn: Readonly<Record<string, T>>;
  /** The app's texts per language, any subset of keys. */
  app?: Readonly<Record<string, Partial<T>>>;
  overrides?: Partial<T>;
}): T {
  const builtInLayer = { byLanguage: input.builtIn as Readonly<Record<string, Partial<T>>> };
  // A table under a key that is no language tag is never used (`__proto__`, `de_DE`).
  const appLayer = input.app
    ? { byLanguage: Object.fromEntries(Object.entries(input.app).filter(([tag]) => isLanguageTag(tag))) }
    : undefined;
  const english = input.builtIn.en;
  if (!english) throw new Error('resolveTextTable: the built-in texts need an en table');
  const keys = new Set<string>([
    ...Object.keys(english),
    ...Object.values(appLayer?.byLanguage ?? {}).flatMap((texts) => (texts && typeof texts === 'object' ? Object.keys(texts) : [])),
    ...Object.keys(input.overrides ?? {}),
  ]);
  const result: Record<string, unknown> = {};
  for (const key of keys as Set<keyof T & string>) {
    const own = (table: { byLanguage: Readonly<Record<string, Partial<T>>> } | undefined) => table
      ? {
        byLanguage: Object.fromEntries(Object.entries(table.byLanguage)
          .filter(([, texts]) => texts !== undefined && texts !== null && typeof texts === 'object' && texts[key] !== undefined)
          .map(([tag, texts]) => [tag, texts[key]])),
      }
      : undefined;
    const value = input.overrides?.[key] ?? resolveLayered<unknown>([own(appLayer), own(builtInLayer)], input.requested);
    if (value !== undefined) result[key] = value;
  }
  return result as T;
}
