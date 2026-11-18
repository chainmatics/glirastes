import { describe, expect, it } from 'vitest';
import { mergeDeclaredTexts, readDeclaredTexts } from './declared-texts.js';
import { SemanticsEntrySchema, semanticsSearch, semanticsTitle } from './semantics.js';

const entry = (value: unknown) => SemanticsEntrySchema.parse(value);

describe('texts an endpoint declares', () => {
  it('reads one text or one per language tag and ignores anything else by its field', () => {
    expect(readDeclaredTexts({
      title: { en: 'Delete playlist', pl: 'Usuń playlistę' },
      description: 'Deletes a playlist.',
      synonyms: { pl: ['playlisty'] },
      examples: { de: ['Lösch die Playlist'] },
    })).toEqual({
      hints: {
        title: { en: 'Delete playlist', pl: 'Usuń playlistę' },
        declaredDescription: 'Deletes a playlist.',
        synonyms: { pl: ['playlisty'] },
        examples: { de: ['Lösch die Playlist'] },
      },
      invalid: [],
    });
    expect(readDeclaredTexts({
      title: { de_DE: 'x' },
      description: { en: '' },
      synonyms: ['no language'],
      examples: { en: [`sk-or-v1-${'a'.repeat(64)}`] },
    })).toEqual({ hints: {}, invalid: ['title', 'description', 'synonyms', 'examples'] });
  });

  it('merges search texts per language and keeps the contract title as its own lower source', () => {
    const contract = { contractTitle: 'Show task', synonyms: { pl: ['zadanie'] } };
    expect(mergeDeclaredTexts(contract, { title: { de: 'Aufgabe anzeigen' }, synonyms: { de: ['Aufgabe'] } })).toEqual({
      contractTitle: 'Show task',
      title: { de: 'Aufgabe anzeigen' },
      synonyms: { pl: ['zadanie'], de: ['Aufgabe'] },
    });
    expect(mergeDeclaredTexts(contract, undefined)).toBe(contract);
  });
});

describe('titles and search texts per language', () => {
  it('lets a language-free code title beat an agent title in every language', () => {
    const agent = entry({ name: 'tasks.get', title: { en: 'Agent title' }, origin: { title: 'agent' } });
    expect(semanticsTitle(agent, 'Show task', ['en', 'de'])).toEqual({ en: 'Show task', de: 'Show task' });
    // Also in a language only the agent named.
    const polish = entry({ name: 'tasks.get', title: { pl: 'Agent title' }, origin: { title: 'agent' } });
    expect(semanticsTitle(polish, 'Show task', ['en'])).toEqual({ en: 'Show task', pl: 'Show task' });
    const human = entry({ name: 'tasks.get', title: { en: 'Reviewed title' } });
    expect(semanticsTitle(human, 'Show task', ['en', 'de'])).toEqual({ en: 'Reviewed title', de: 'Show task' });
    // The operation's German title above a language-free contract title, which keeps English and Polish.
    expect(semanticsTitle(undefined, { de: 'Aufgabe anzeigen' }, ['en', 'de', 'pl'], 'Show task'))
      .toEqual({ de: 'Aufgabe anzeigen', en: 'Show task', pl: 'Show task' });
  });

  it('indexes the synonyms of every language, the maintained entry first per language', () => {
    const human = entry({ name: 'tasks.list', synonyms: { de: ['Aufgaben'], pl: ['zadania'] } });
    expect(semanticsSearch(human, { synonyms: { de: ['To-dos'], en: ['to-dos'] } }).synonyms).toEqual(['Aufgaben', 'to-dos', 'zadania']);
    const agent = entry({ name: 'tasks.list', synonyms: { de: ['Aufgaben'] }, origin: { synonyms: 'agent' } });
    expect(semanticsSearch(agent, { synonyms: { de: ['To-dos'] } }).synonyms).toEqual(['To-dos']);
  });
});
