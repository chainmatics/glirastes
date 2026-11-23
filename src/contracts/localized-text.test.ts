import { describe, expect, it } from 'vitest';
import {
  isLanguageTag,
  pickLanguage,
  preferredLanguage,
  resolveLayered,
  resolveLocalizedText,
  resolveTextTable,
} from './localized-text.js';

describe('pickLanguage', () => {
  it('takes the requested tag, then a shorter tag, then another region of the language', () => {
    expect(pickLanguage(['de', 'pl', 'en'], 'pl-PL')).toBe('pl');
    expect(pickLanguage(['pl-PL', 'pl', 'en'], 'pl-PL')).toBe('pl-PL');
    expect(pickLanguage(['de-AT', 'en'], 'de-DE')).toBe('de-AT');
    expect(pickLanguage(['zh-Hant', 'zh', 'en'], 'zh-Hant-TW')).toBe('zh-Hant');
    expect(pickLanguage(['PL', 'en'], 'pl-pl')).toBe('PL');
  });

  it('falls back to English, then to the first tag in code-unit order', () => {
    expect(pickLanguage(['de', 'en-GB'], 'pl')).toBe('en-GB');
    expect(pickLanguage(['fr', 'de'], 'pl')).toBe('de');
    expect(pickLanguage([], 'pl')).toBeUndefined();
    expect(pickLanguage(['fr', 'en'], undefined)).toBe('en');
  });
});

describe('resolveLocalizedText', () => {
  it('uses a plain string for every language', () => {
    expect(resolveLocalizedText('Playlists', 'pl')).toBe('Playlists');
    expect(resolveLocalizedText({ de: 'Anzeigen', en: 'Show' }, 'pl-PL')).toBe('Show');
    expect(resolveLocalizedText({ de: 'Anzeigen' }, 'pl-PL')).toBe('Anzeigen');
    expect(resolveLocalizedText(undefined, 'pl')).toBeUndefined();
  });
});

describe('resolveLayered', () => {
  const semantics = { byLanguage: { de: 'Playlists anzeigen', pl: 'Pokaż playlisty' } };
  const endpoint = { byLanguage: { en: 'Show playlists', de: 'Playlist zeigen' } };

  it('lets the higher layer win per language and the lower one fill the gaps', () => {
    expect(resolveLayered([semantics, endpoint], 'de')).toBe('Playlists anzeigen');
    expect(resolveLayered([semantics, endpoint], 'pl-PL')).toBe('Pokaż playlisty');
    expect(resolveLayered([semantics, endpoint], 'en-US')).toBe('Show playlists');
    expect(resolveLayered([semantics, endpoint], 'fr')).toBe('Show playlists');
  });

  it('treats a language-free value as a translation for every language', () => {
    expect(resolveLayered([{ byLanguage: { de: 'Anzeigen' } }, { any: 'Show' }], 'pl')).toBe('Show');
    expect(resolveLayered([{ any: 'Show' }, { byLanguage: { pl: 'Pokaż' } }], 'pl')).toBe('Show');
  });

  it('takes the first available language when nothing serves the request or English', () => {
    expect(resolveLayered([undefined, { byLanguage: { fr: 'Afficher', de: 'Anzeigen' } }], 'pl')).toBe('Anzeigen');
    expect(resolveLayered([], 'pl')).toBeUndefined();
  });
});

describe('resolveTextTable', () => {
  const builtIn = { en: { yes: 'Yes', no: 'No' }, de: { yes: 'Ja', no: 'Nein' } };

  it('falls back per key: app language, built-in language, app English, built-in English', () => {
    expect(resolveTextTable({ requested: 'pl-PL', builtIn, app: { pl: { yes: 'Tak' } } })).toEqual({ yes: 'Tak', no: 'No' });
    expect(resolveTextTable({ requested: 'de-AT', builtIn, app: { pl: { yes: 'Tak' } } })).toEqual({ yes: 'Ja', no: 'Nein' });
    expect(resolveTextTable({ requested: 'de', builtIn, app: { de: { no: 'Nö' } } })).toEqual({ yes: 'Ja', no: 'Nö' });
    expect(resolveTextTable({ requested: 'fr', builtIn, app: { en: { no: 'Nope' } } })).toEqual({ yes: 'Yes', no: 'Nope' });
  });

  it('applies language-free overrides to every language', () => {
    expect(resolveTextTable({ requested: 'de', builtIn, overrides: { yes: 'OK' } })).toEqual({ yes: 'OK', no: 'Nein' });
  });
});

describe('isLanguageTag', () => {
  it('accepts BCP-47 tags and refuses everything else', () => {
    for (const tag of ['de', 'pl-PL', 'zh-Hant-TW', 'es-419', 'fil']) expect(isLanguageTag(tag)).toBe(true);
    for (const tag of ['', 'x', 'de_DE', 'de-', '__proto__', 'toolong-language-tag-with-many-parts']) expect(isLanguageTag(tag)).toBe(false);
  });
});

describe('preferredLanguage', () => {
  it('reads the most preferred tag of an Accept-Language value', () => {
    expect(preferredLanguage('pl-PL,pl;q=0.9,en;q=0.8')).toBe('pl-PL');
    expect(preferredLanguage('en;q=0.5, de;q=0.9')).toBe('de');
    expect(preferredLanguage('*')).toBeUndefined();
    expect(preferredLanguage('de;q=0')).toBeUndefined();
    expect(preferredLanguage(null)).toBeUndefined();
  });
});
