import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  approvalNameLookupKey,
  BROWSER_RECOGNISED_ID_KEYS,
  entityIdKey,
  fallbackTextOf,
  idArgumentStem,
  identityFieldsOf,
  idParameterStem,
  isIdArgumentKey,
  isIdLikeKey,
  isOpaqueIdText,
  isReferenceKey,
  isTechnicalIdKey,
  looksLikeTechnicalId,
  NAME_KEYS,
  OWN_ID_KEYS,
  ownLabelOf,
  searchIdFieldCandidates,
  siblingLabelOf,
} from './entity-identity.js';

const SRC = fileURLToPath(new URL('..', import.meta.url));

describe('entity-identity profiles', () => {
  it('keeps the per-consumer field lists explicit (a change here changes behaviour)', () => {
    expect(OWN_ID_KEYS).toEqual({
      result: ['id', 'uuid', 'key', 'slug', 'code'],
      browser: ['id', '_id', 'uuid'],
    });
    expect(NAME_KEYS).toEqual({
      result: ['name', 'title', 'label', 'displayName'],
      browser: ['title', 'name', 'displayName', 'label'],
      search: ['title', 'name', 'displayName', 'label', 'subject', 'email'],
    });
    expect(BROWSER_RECOGNISED_ID_KEYS).toEqual(['id', '_id', 'uuid', 'key', 'slug', 'code']);
    expect(searchIdFieldCandidates('task')).toEqual(['id', 'uuid', 'taskId']);
  });

  it('tells the three id-key rules apart (own id-like, reference, argument, hideIds)', () => {
    expect(isIdLikeKey('playlist_id')).toBe(true);
    expect(isIdLikeKey('trackIds')).toBe(false);
    expect(isReferenceKey('trackIds')).toBe(true);
    expect(isReferenceKey('VALID')).toBe(false);
    expect(isIdArgumentKey('IDs')).toBe(true);
    expect(idArgumentStem('track_ids')).toEqual({ stem: 'track', plural: 's' });
    expect(isTechnicalIdKey('userID')).toBe(false);
    expect(isTechnicalIdKey('user_ids')).toBe(true);
    expect(idParameterStem('params.task_id')).toBe('task');
    expect(idParameterStem('taskID')).toBeUndefined();
  });

  it('classifies values the way each consumer did', () => {
    expect(entityIdKey(' AbC ')).toBe('abc');
    expect(entityIdKey(3)).toBe('3');
    expect(approvalNameLookupKey(3)).toBeUndefined();
    expect(approvalNameLookupKey(' AbC ')).toBe(' abc ');
    expect(looksLikeTechnicalId('abc12345')).toBe(true);
    expect(looksLikeTechnicalId('42')).toBe(false);
    expect(isOpaqueIdText('a'.repeat(16))).toBe(true);
  });

  it('derives identity fields, labels and fallbacks from one place', () => {
    expect(identityFieldsOf({ playlist_id: 3, displayName: 'Rock', owner_id: 1, n: 2 }))
      .toEqual([['playlist_id', 3], ['displayName', 'Rock'], ['owner_id', 1]]);
    expect(ownLabelOf({ name: 'N', ticketIdentifier: 'T-1' })).toBe('T-1');
    expect(siblingLabelOf({ ownerId: 'x', ownerDisplayName: 'Ann' }, 'ownerId')).toBe('Ann');
    expect(fallbackTextOf({ versionNumber: 3 })).toBe('Version number 3');
  });
});

/**
 * Guard: a new identity guess outside `entity-identity.ts`. The patterns are
 * the tell-tale forms of a guess — a well-known identity field name as a
 * literal, an id-suffix alternation in a regex, a UUID regex, a name-key list.
 * A real use that is not a record-identity guess goes into ALLOWED with why.
 */
const GUESS_PATTERNS: ReadonlyArray<[string, RegExp]> = [
  ['identity field-name literal', /['"](?:displayName|_id|versionNumber)['"]/],
  ['id-suffix alternation', /(?:\(\?:|\|)(?:Id|ID|_id)(?:\||\))/],
  ['UUID regex', /\[0-9a-f\]\{8\}/],
  ['name-key list', /['"]title['"],\s*['"]name['"]|['"]name['"],\s*['"]title['"]/],
  ['identifier suffix', /identifier\$/],
];

const ALLOWED: ReadonlyArray<{ file: string; pattern: string; why: string }> = [
  { file: 'contracts/entity-identity.ts', pattern: '*', why: 'the one module' },
  { file: 'sync/control-plane-client.ts', pattern: 'UUID regex', why: 'format of a setup run id, not a record' },
  { file: 'react/bridges/rest-session-bridge.ts', pattern: 'name-key list', why: 'rows of the app chat-session store, not tool-result records' },
];

function sourceFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '__tests__' || entry.name === '__vectors__' || entry.name === 'node_modules') continue;
      files.push(...sourceFiles(path));
    } else if (/\.tsx?$/.test(entry.name) && !/\.(?:test|spec)\.tsx?$/.test(entry.name) && !entry.name.endsWith('.d.ts')) {
      files.push(path);
    }
  }
  return files;
}

describe('one identity heuristic', () => {
  it('has no identity guess outside src/contracts/entity-identity.ts', () => {
    const found: string[] = [];
    for (const path of sourceFiles(SRC)) {
      const file = relative(SRC, path).split('\\').join('/');
      const lines = readFileSync(path, 'utf8').split('\n');
      for (const [name, pattern] of GUESS_PATTERNS) {
        if (ALLOWED.some((entry) => entry.file === file && (entry.pattern === '*' || entry.pattern === name))) continue;
        lines.forEach((line, index) => {
          if (pattern.test(line)) found.push(`${file}:${index + 1} ${name}: ${line.trim()}`);
        });
      }
    }
    expect(found).toEqual([]);
  });
});
