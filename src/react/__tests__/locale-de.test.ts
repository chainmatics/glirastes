import { describe, expect, it } from 'vitest';
import { DEFAULT_LOCALE } from '../provider/ai-chat-provider.js';
import { deChatLocale } from '../index.js';

describe('deChatLocale', () => {
  it('translates every text of the default locale', () => {
    expect(Object.keys(deChatLocale).sort()).toEqual(Object.keys(DEFAULT_LOCALE).sort());
    for (const [key, text] of Object.entries(deChatLocale)) {
      expect(text, key).not.toBe('');
    }
  });

  it('keeps the placeholders of the default texts', () => {
    const placeholders = (text: string) => (text.match(/\{\w+\}/g) ?? []).sort();
    for (const [key, text] of Object.entries(DEFAULT_LOCALE)) {
      expect(placeholders(deChatLocale[key as keyof typeof deChatLocale]), key).toEqual(placeholders(text));
    }
  });
});
