import { describe, expect, it } from 'vitest';
import {
  createToolSearchIndex,
  searchTermVariants,
  searchTokens,
} from '../tool-search.js';

describe('searchTokens', () => {
  it('keeps Unicode letters and digits, splits names and folds diacritics', () => {
    expect(searchTokens('Lösche tasks.listTasks für Straße 2026'))
      .toEqual(['losche', 'tasks', 'list', 'tasks', 'strasse', '2026']);
    expect(searchTokens('Größe')).toEqual(['grosse']);
    expect(searchTokens('Задачи 東京')).toEqual(['задачи', '東京']);
  });

  it('drops German and English function words', () => {
    expect(searchTokens('Zeige mir bitte die Aufgaben von Alice'))
      .toEqual(['zeige', 'aufgaben', 'alice']);
    expect(searchTokens('show me all of the tasks')).toEqual(['tasks']);
  });
});

describe('searchTermVariants', () => {
  it('adds German and English Snowball stems to every token', () => {
    expect(searchTermVariants('Aufgaben löschen')).toEqual([
      ['aufgaben', 'aufgab'],
      ['loschen', 'losch'],
    ]);
    expect(searchTermVariants('deleted tasks')).toEqual([
      ['deleted', 'delet'],
      ['tasks', 'task'],
    ]);
  });
});

describe('createToolSearchIndex', () => {
  const index = createToolSearchIndex([
    {
      name: 'tasks_listTasks',
      description: 'Show visible tasks with status and due date filters.',
      synonyms: ['Aufgaben anzeigen', 'Aufgabenliste'],
    },
    {
      name: 'tasks_deleteTask',
      description: 'Delete a task permanently.',
      synonyms: ['Aufgabe löschen'],
    },
    {
      name: 'reports_weeklySummary',
      description: 'Summarize completed work for the current week.',
      synonyms: ['Wochenbericht'],
    },
  ]);

  it('matches German stems and synonyms across inflections', () => {
    expect(index.search('Lösche die Aufgabe', 8)[0]).toBe('tasks_deleteTask');
    expect(index.search('Wochenbericht', 8)).toEqual(['reports_weeklySummary']);
  });

  it('prefers rare terms over terms every tool shares', () => {
    expect(index.search('Aufgabe löschen', 8)).toEqual([
      'tasks_deleteTask',
      'tasks_listTasks',
    ]);
  });

  it('ranks an exact model name first and respects the limit', () => {
    expect(index.search('tasks.listTasks', 1)).toEqual(['tasks_listTasks']);
  });

  it('returns no hits for unrelated or function-word-only queries', () => {
    expect(index.search('Wetter in Berlin', 8)).toEqual([]);
    expect(index.search('the of und die', 8)).toEqual([]);
  });
});
