import { useEffect, useState } from 'react';
import { deChatLocale } from '../locale-de.js';
import type { ChatLocale } from '../types.js';

/** What a chat turn tells the UI about its tools: a label per model name and the language of the app. */
export interface ToolPresentation {
  locale: string;
  labels: Record<string, string>;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Reads the `data-tool-presentation` part of a chat turn. It is data from the
 * app's own server, but the UI still takes only short texts from it.
 */
export function parseToolPresentation(data: unknown): ToolPresentation | null {
  if (!isRecord(data) || typeof data.locale !== 'string' || !isRecord(data.tools)) return null;
  const labels: Record<string, string> = {};
  for (const [name, entry] of Object.entries(data.tools)) {
    const label = isRecord(entry) && typeof entry.label === 'string' ? entry.label.trim() : '';
    if (label !== '' && label.length <= 200) labels[name] = label;
  }
  return { locale: data.locale, labels };
}

/**
 * The built-in chat texts for a language tag (`de`, `de-AT`); empty for a
 * language without built-in texts, which keeps the English defaults.
 */
export function languageLocale(language: string | null | undefined): Partial<ChatLocale> {
  return isGerman(language) ? deChatLocale : {};
}

/** Whether a language tag is German (`de`, `de-AT`). */
export function isGerman(language: string | null | undefined): boolean {
  return /^de(?:-|$)/i.test(language ?? '');
}

/**
 * The `lang` of the page, read after mount so the server render and the first
 * client render agree; null until then and for a page without one.
 */
export function usePageLanguage(): string | null {
  const [language, setLanguage] = useState<string | null>(null);
  useEffect(() => {
    setLanguage(document.documentElement.lang || null);
  }, []);
  return language;
}
