import type { GlirastesChatElementConfig } from 'glirastes/embed';

/** The UI languages of the app; `?lang=pl` (or `de`) switches the page, English otherwise. */
export const LANGUAGES = ['en', 'de', 'pl'] as const;

export function pageLanguage(): string {
  const wanted = new URLSearchParams(window.location.search).get('lang');
  return wanted && (LANGUAGES as readonly string[]).includes(wanted) ? wanted : 'en';
}

/**
 * The chat element's configuration: every request names the page's language
 * (the runtime words tool labels and its own texts in it), and the chat has
 * Polish texts of its own, deliberately partial: every other key falls back
 * to English. German and English are built in.
 */
export const chatConfig: GlirastesChatElementConfig = {
  headers: () => ({ 'x-app-language': document.documentElement.lang || 'en' }),
  locales: {
    en: { placeholder: 'Ask about your tasks' },
    de: { placeholder: 'Frag nach deinen Aufgaben' },
    pl: {
      placeholder: 'Zapytaj o swoje zadania',
      sendButton: 'Wyślij',
      approveButton: 'Wykonaj',
      rejectButton: 'Anuluj',
      approvalCollidingIdWarning: 'Ten identyfikator pojawił się przy różnych rodzajach rekordów: {candidates}. Sprawdź, o który chodzi, zanim zatwierdzisz.',
      activityWorkingLabel: 'Pracuję',
      activityDoneLabel: 'Wykonano kroki: {count}',
    },
  },
};
