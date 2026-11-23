/** Letters without a Unicode decomposition, so NFKD leaves them (`ł`, `ø`, `æ`); upper-case forms lower-case first. */
const UNDECOMPOSED: Readonly<Record<string, string>> = {
  ł: 'l', ø: 'o', đ: 'd', ð: 'd', ħ: 'h', ı: 'i', æ: 'ae', œ: 'oe', þ: 'th',
};
const UNDECOMPOSED_PATTERN = /[łøđðħıæœþ]/g;

/**
 * Text as compared in completion search: decomposed, without combining
 * marks, lower-case, trimmed, with the letters NFKD keeps folded to their
 * base (`Właściciel` → `wlasciciel`, `Øre` → `ore`). Plain ASCII and German
 * fold as before (`ß` stays; German transliteration is separate).
 */
export function foldText(value: string): string {
  return value.normalize('NFKD').replace(/\p{M}+/gu, '').toLowerCase()
    .replace(UNDECOMPOSED_PATTERN, (letter) => UNDECOMPOSED[letter]!)
    .trim();
}
