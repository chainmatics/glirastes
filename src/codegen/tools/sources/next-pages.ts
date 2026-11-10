import { compareCodeUnits } from '../canonical.js';
import { toolFinding } from '../findings.js';
import type {
  JsonSchemaLike,
  ToolFinding,
  ToolProseHints,
  ToolSource,
  ToolSourceObservation,
} from '../types.js';
import { scanAppSources, type AppSourceScan } from './app-files.js';
import { enumeratePages, type PageEntry, type PageTree, type PageTreeOptions } from './page-tree.js';
import {
  hasNavigationBridge,
  incompleteUiSource,
  mentionsNavigationBridge,
  NAVIGATE_ACTION_BINDING,
  NAVIGATE_DEFINITION_ID,
  NAVIGATE_STABLE_KEY,
  uiObservation,
} from './ui-tools.js';

export interface NextPagesSourceOptions extends PageTreeOptions {
  /** Where the navigation bridge is searched; `src` when the app has one, else the app root. */
  srcDir?: string;
}

const MAX_LISTED_DESTINATIONS = 40;

/** `destination` is one of the page paths; `params` fills their dynamic segments. */
export function navigationInputSchema(pages: ReadonlyArray<PageEntry>): JsonSchemaLike {
  const params = [...new Set(pages.flatMap((page) => page.params))].sort(compareCodeUnits);
  return {
    type: 'object',
    properties: {
      destination: { type: 'string', enum: pages.map((page) => page.path) },
      ...(params.length > 0
        ? {
          params: {
            type: 'object',
            properties: Object.fromEntries(params.map((name) => [name, { type: 'string', minLength: 1 }])),
            additionalProperties: false,
          },
        }
        : {}),
    },
    required: ['destination'],
    additionalProperties: false,
  };
}

function navigationProse(locale: string, pages: ReadonlyArray<PageEntry>): ToolProseHints {
  const german = locale.toLowerCase().startsWith('de');
  const listed = pages.slice(0, MAX_LISTED_DESTINATIONS).map((page) => (page.params.length > 0
    ? `${page.path} (${german ? 'braucht' : 'needs'} ${page.params.map((name) => `params.${name}`).join(', ')})`
    : page.path));
  const rest = pages.length - listed.length;
  const more = rest > 0 ? (german ? ` und ${rest} weitere` : ` and ${rest} more`) : '';
  return german
    ? {
      contractDescription: `Öffnet eine Seite dieser App im Browser des Nutzers. Ziele: ${listed.join(', ')}${more}.`,
      presentation: { locale, singular: 'Seite öffnen', plural: 'Seiten öffnen', approval: 'Seite öffnen' },
    }
    : {
      contractDescription: `Open a page of this app in the user's browser. Destinations: ${listed.join(', ')}${more}.`,
      presentation: { locale, singular: 'Open page', plural: 'Open pages', approval: 'Open a page' },
    };
}

export function navigationBridgeMissing(stableKey: string): ToolFinding {
  return toolFinding('navigation-bridge-missing', 'needs_attention', stableKey,
    'No useGlirastesNavigationBridge or registerNavigationBridge call was found, so the browser cannot run this tool.');
}

export function scanForNavigationBridge(root: string, srcDir: string | undefined): Promise<AppSourceScan> {
  return scanAppSources(root, { ...(srcDir ? { srcDir } : {}), matches: mentionsNavigationBridge });
}

/** The one `ui.navigate` tool over a page list, whichever source enumerated it. */
export async function observeNavigation(
  kind: string,
  tree: PageTree,
  root: string,
  locale: string,
  srcDir: string | undefined,
): Promise<ToolSourceObservation> {
  if (!tree.complete) return incompleteUiSource(kind, tree.reason);
  if (tree.pages.length === 0) {
    return { observations: [], findings: tree.findings, complete: true, excluded: tree.excluded };
  }
  const sources = await scanForNavigationBridge(root, srcDir);
  if (!sources.complete) return incompleteUiSource(kind, sources.reason);
  const tool = uiObservation({
    stableKey: NAVIGATE_STABLE_KEY,
    definitionId: NAVIGATE_DEFINITION_ID,
    actionBindingRef: NAVIGATE_ACTION_BINDING,
    input: navigationInputSchema(tree.pages),
    uiAction: { kind: 'navigate' },
    params: {
      path: [...new Set(tree.pages.flatMap((page) => page.params))].sort(compareCodeUnits),
      query: [],
      body: [],
    },
    facts: { destinations: tree.pages.map(({ path, params }) => ({ path, params })) },
    findings: hasNavigationBridge(sources.files) ? [] : [navigationBridgeMissing(NAVIGATE_STABLE_KEY)],
    prose: navigationProse(locale, tree.pages),
  });
  return { observations: [tool], findings: tree.findings, complete: true, excluded: tree.excluded };
}

/**
 * The `next-pages` source: one `ui.navigate` tool whose destinations are the
 * pages of the Next.js app router tree (spec 4.4 "Navigation und Filter").
 */
export function createNextPagesSource(options: NextPagesSourceOptions = {}): ToolSource {
  return {
    kind: 'next-pages',
    observe: async (ctx) => observeNavigation('next-pages',
      await enumeratePages(ctx.root, options, ctx.policy.exclude ?? []), ctx.root, ctx.config.locale, options.srcDir),
  };
}
