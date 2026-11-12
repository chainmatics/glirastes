import { describe, expect, it } from 'vitest';
import {
  createDefaultIntentRouter,
  previousTurnScope,
  routableToolsFromManifest,
  type RoutableTool,
} from '../default-intent-routing.js';
import {
  fixtureModelName,
  ROUTING_FIXTURE_SYNONYMS,
  ROUTING_FIXTURE_TOOLS,
} from './fixtures/routing-app-tools.js';

const tools: RoutableTool[] = routableToolsFromManifest(
  ROUTING_FIXTURE_TOOLS,
  ROUTING_FIXTURE_SYNONYMS,
);
const router = createDefaultIntentRouter(tools);
const MAX_START_SET = 15;

function startSet(text: string, scope = { toolNames: [] as string[], userTexts: [] as string[] }) {
  return router.route({ text, previous: scope }).toolNames;
}

describe('default intent routing over a generated ~100-tool app', () => {
  it('builds the fixture the bench claims', () => {
    expect(tools.length).toBeGreaterThanOrEqual(100);
    expect(new Set(ROUTING_FIXTURE_TOOLS.map((tool) => tool.module)).size).toBeGreaterThanOrEqual(10);
  });

  it.each([
    ['Zeig mir meine offenen Aufgaben', 'tasks_list'],
    ['Lege eine neue Aufgabe an: Bericht schreiben bis Freitag', 'tasks_create'],
    ['Erinnere mich morgen an die Steuererklärung', 'tasksReminder_create'],
    ['Filtere die Aufgaben nach hoher Priorität', 'ui_tasks_filters_apply'],
    ['Füge Anna dem Team Marketing hinzu', 'teamsMembers_add'],
    ['Importiere die Feiertage für Bayern', 'holidayCalendars_import'],
    ['Welche Vorlagen haben wir?', 'templates_list'],
    ['Create a task to call the customer', 'tasks_create'],
    ['Show me all teams', 'teams_list'],
    ['Mark the report task as done', 'tasks_setStatus'],
    ['Go to the settings', 'ui_navigate'],
    ['Wie sieht mein Dashboard aus?', 'dashboard_get'],
  ])('%s → small start set with %s', (text, expected) => {
    const names = startSet(text);
    expect(names).toContain(expected);
    expect(names.length).toBeLessThanOrEqual(MAX_START_SET);
  });

  it('keeps a weak, domain-free message small instead of offering everything', () => {
    const names = startSet('Hallo, wie geht es dir?');
    expect(names).toContain('ui_navigate');
    expect(names.length).toBeLessThanOrEqual(3);
  });

  it.each([
    'bitte den Filter den wir eben hatten anwenden',
    'okay aber bitte wieder auf den Filter den wir eben hatten',
    'und nochmal genauso',
  ])('follow-up "%s" keeps the tool the previous turn used', (text) => {
    const names = startSet(text, {
      toolNames: ['ui_tasks_filters_apply'],
      userTexts: ['Zeig mir nur die offenen Aufgaben mit hoher Priorität'],
    });
    expect(names).toContain('ui_tasks_filters_apply');
    expect(names.length).toBeLessThanOrEqual(MAX_START_SET);
  });

  it('routes a domain-free follow-up by the previous request', () => {
    const names = startSet('und jetzt bitte nochmal', {
      toolNames: [],
      userTexts: ['Füge Anna dem Team Marketing hinzu'],
    });
    expect(names).toContain('teamsMembers_add');
  });

  it('reports the start-set sizes against the unrouted baseline', () => {
    const requests = [
      'Zeig mir meine offenen Aufgaben',
      'Lege eine neue Aufgabe an',
      'Füge Anna dem Team Marketing hinzu',
      'Show me all teams',
      'Importiere die Feiertage für Bayern',
    ];
    const sizes = requests.map((text) => startSet(text).length);
    const average = sizes.reduce((sum, size) => sum + size, 0) / sizes.length;
    // Without routing every tool is active on every turn.
    expect(average).toBeLessThan(tools.length / 6);
  });
});

describe('previousTurnScope', () => {
  it('reads the tools of the last assistant turn and the earlier user texts', () => {
    const scope = previousTurnScope([
      { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'Zeig offene Aufgaben' }] },
      {
        id: 'a1',
        role: 'assistant',
        parts: [
          { type: 'tool-find_tools', toolCallId: 'c0', state: 'output-available' },
          { type: 'tool-ui_tasks_filters_apply', toolCallId: 'c1', state: 'output-available' },
          { type: 'dynamic-tool', toolName: 'tasks_list', toolCallId: 'c2', state: 'output-available' },
          { type: 'text', text: 'Filter gesetzt.' },
        ],
      },
      { id: 'u2', role: 'user', parts: [{ type: 'text', text: 'wieder wie eben' }] },
    ]);
    expect(scope.toolNames).toEqual(['ui_tasks_filters_apply', 'tasks_list']);
    expect(scope.userTexts).toEqual(['Zeig offene Aufgaben']);
  });

  it('includes tools of the current turn on an approval continuation', () => {
    const scope = previousTurnScope([
      { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'Lösche das Projekt' }] },
      {
        id: 'a1',
        role: 'assistant',
        parts: [{ type: 'tool-projects_delete', toolCallId: 'c1', state: 'approval-responded', approval: { id: 'x', approved: true } }],
      },
    ]);
    expect(scope.toolNames).toEqual(['projects_delete']);
  });

  it('is empty for a first message', () => {
    expect(previousTurnScope([
      { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'Hallo' }] },
    ])).toEqual({ toolNames: [], userTexts: [] });
  });
});
