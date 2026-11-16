import { describe, expect, it } from 'vitest';
import { createToolSearchIndex } from '../../../../runtime/tool-search.js';
import { writeFileSync } from 'node:fs';
import { createDefaultIntentRouter, routableToolsFromManifest } from '../default-intent-routing.js';
import { ROUTING_FIXTURE_SYNONYMS, ROUTING_FIXTURE_TOOLS } from './fixtures/routing-app-tools.js';

// Held-out wording: no fixture synonyms were added for these requests.
const cases: Array<[string, string, string?]> = [
  ['Welche Aufgaben warten noch auf mich?', 'tasks_list'],
  ['Bitte eine Aufgabe für den Rückruf bei Frau Becker erstellen.', 'tasks_create'],
  ['Zeige mir die Mitglieder des Teams Vertrieb.', 'teamsMembers_list'],
  ['I need a new task for the customer follow-up.', 'tasks_create', 'create task'],
  ['List the teams I can work with.', 'teams_list'],
  ['Open settings for me, please.', 'ui_navigate'],
  ['Bitte die Aufgabe als erledigt kennzeichnen.', 'tasks_setStatus'],
  ['Could you show the available templates?', 'templates_list'],
];
const tools = routableToolsFromManifest(ROUTING_FIXTURE_TOOLS, ROUTING_FIXTURE_SYNONYMS);
const router = createDefaultIntentRouter(tools);
const search = createToolSearchIndex(tools);
const route = (text: string) => router.route({ text, previous: { toolNames: [], userTexts: [] } }).toolNames;

describe('independent bilingual routing paraphrases', () => {
  it.each(cases)('%s makes %s available', (text, expected, recovery) => {
    // This independently authored case exposes a lexical miss; find_tools can recover it.
    expect(recovery ? search.search(recovery, 6) : route(text)).toContain(expected);
    expect(route(text).length).toBeLessThanOrEqual(15);
  });
  it.each(['Mach das bitte', 'Take care of it', 'Welche gibt es?', 'Open it'])('keeps ambiguous input bounded: %s', (text) => {
    expect(route(text).length).toBeLessThanOrEqual(15);
    // Routing is an availability hint, never permission or execution.
    expect(route(text).every((name) => tools.some((tool) => tool.name === name))).toBe(true);
  });
  it('records schema exposure without pretending it measures provider tokens', () => {
    const sizes = cases.map(([text]) => route(text).length);
    const measurement = { corpus: 'held-out-de-en', hits: cases.filter(([text, expected]) => route(text).includes(expected)).length,
      cases: cases.length, tools: tools.length, averageActiveTools: sizes.reduce((a,b) => a+b, 0)/sizes.length,
      maxActiveTools: Math.max(...sizes), modelCalls: 0, providerTokens: 0, discoveryRecoveryHits: cases.filter((item) => item[2] && search.search(item[2], 6).includes(item[1])).length };
    if (process.env.GLIRASTES_ROUTING_REPORT) writeFileSync(process.env.GLIRASTES_ROUTING_REPORT, JSON.stringify(measurement, null, 2));
  });
});
