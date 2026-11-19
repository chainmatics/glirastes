import { describe, expect, it } from 'vitest';
import { mergeToolSearchSemantics, toolLabelsFor } from './tool-texts.js';

describe('mergeToolSearchSemantics', () => {
  it('adds the own synonyms and examples to the generated ones per tool, own first, each once', () => {
    const generated = { tasks_list: { synonyms: ['to-dos', 'Aufgaben'], examples: ['list my tasks'] }, tags_list: { synonyms: ['labels'] } };
    const own = { tasks_list: { synonyms: ['zadania', 'to-dos'] }, notes_list: { examples: ['show notes'] } };
    expect(mergeToolSearchSemantics(generated, own)).toEqual({
      tasks_list: { synonyms: ['zadania', 'to-dos', 'Aufgaben'], examples: ['list my tasks'] },
      tags_list: { synonyms: ['labels'] },
      notes_list: { examples: ['show notes'] },
    });
  });

  it('keeps the limits of find_tools', () => {
    const many = (prefix: string, count: number) => Array.from({ length: count }, (_, index) => `${prefix}${index}`);
    const merged = mergeToolSearchSemantics({ a: { synonyms: many('g', 20), examples: many('e', 10) } }, { a: { synonyms: many('o', 5), examples: ['own'] } });
    expect(merged.a?.synonyms).toHaveLength(20);
    expect(merged.a?.synonyms?.slice(0, 5)).toEqual(many('o', 5));
    expect(merged.a?.examples).toHaveLength(10);
    expect(merged.a?.examples?.[0]).toBe('own');
  });
});

describe('toolLabelsFor', () => {
  const labels = (text: string) => ({ singular: text, plural: text, approval: text });
  it('picks the language, another region of it, English, then the first one', () => {
    const texts = { labels: { 'pt-BR': labels('Excluir'), en: labels('Delete'), de: labels('Löschen') } };
    expect(toolLabelsFor(texts, 'pt-PT')?.labels.approval).toBe('Excluir');
    expect(toolLabelsFor(texts, 'pl')?.language).toBe('en');
    expect(toolLabelsFor({ labels: { de: labels('Löschen') } }, 'pl')?.language).toBe('de');
    expect(toolLabelsFor(undefined, 'pl')).toBeUndefined();
  });
});
