import { describe, expect, it } from 'vitest';
import { deChatLocale } from '../../locale-de.js';
import { languageLocale, parseToolPresentation } from '../tool-presentation.js';

describe('the tool wording a chat turn sends', () => {
  it('becomes the labels of the tools by model name, with the language of the app', () => {
    expect(parseToolPresentation({
      locale: 'de-DE',
      tools: { orders_list: { label: 'Aufträge auflisten' }, orders_update: { label: 'Auftrag ändern' } },
    })).toEqual({
      locale: 'de-DE',
      labels: { orders_list: 'Aufträge auflisten', orders_update: 'Auftrag ändern' },
    });
  });

  it('drops entries that are not a short text and anything that is not the expected shape', () => {
    expect(parseToolPresentation({
      locale: 'de-DE',
      tools: { ok: { label: 'Gut' }, empty: { label: ' ' }, long: { label: 'x'.repeat(201) }, wrong: 'Text', missing: {} },
    })).toEqual({ locale: 'de-DE', labels: { ok: 'Gut' } });
    for (const data of [null, 'text', [], { tools: {} }, { locale: 7, tools: {} }, { locale: 'de-DE' }]) {
      expect(parseToolPresentation(data)).toBeNull();
    }
  });
});

describe('the chat texts of a language', () => {
  it('are German for a German app or page, whatever the region', () => {
    expect(languageLocale('de')).toBe(deChatLocale);
    expect(languageLocale('de-DE')).toBe(deChatLocale);
    expect(languageLocale('DE-at')).toBe(deChatLocale);
  });

  it('stay with the English defaults for every other or unknown language', () => {
    for (const language of ['en', 'en-US', 'fr-FR', 'den', '', undefined, null]) {
      expect(languageLocale(language)).toEqual({});
    }
  });
});
