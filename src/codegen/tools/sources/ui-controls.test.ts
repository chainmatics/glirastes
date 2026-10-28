import { afterEach, describe, expect, it } from 'vitest';
import { ToolPolicyFileSchema } from '../../../contracts/tool-policy.js';
import { createAppFixture, removeAppFixtures } from '../__tests__/app-fixture.js';
import { loadToolsConfig } from '../config.js';
import { EMPTY_CONVENTIONS } from '../resolutions.js';
import { createSchemaProbe } from '../schema-probe.js';
import type { ToolSourceContext } from '../types.js';
import { createReactActionSource } from './react-actions.js';

afterEach(removeAppFixtures);

const TSCONFIG = JSON.stringify({ compilerOptions: { strict: true, jsx: 'preserve' } });
const SIZE_LIB = "export const UI_SIZES = ['small', 'medium', 'large', 'extraLarge'] as const;\n"
  + 'export type UiSize = (typeof UI_SIZES)[number];\n';
/** The provider of get-it-done: state in localStorage, setter in a context. */
const SIZE_PROVIDER = (extra = '', imports = '') => "'use client';\n"
  + "import { createContext, useContext } from 'react';\n"
  + "import { UI_SIZES, type UiSize } from '@/lib/ui-size';\n" + imports
  + "const UiSizeContext = createContext<{ size: UiSize; setSize(size: UiSize): void }>({ size: 'medium', setSize: () => {} });\n"
  + "function setSize(size: UiSize) { localStorage.setItem('ui-size', size); }\n"
  + 'export function UiSizeProvider({ children }: { children: React.ReactNode }) {\n'
  + extra
  + "  return <UiSizeContext.Provider value={{ size: 'medium', setSize }}>{children}</UiSizeContext.Provider>;\n}\n"
  + 'export const useUiSize = () => useContext(UiSizeContext);\n';
const SETTINGS = "'use client';\n"
  + "import { useUiSize } from '@/components/layout/ui-size-provider';\n"
  + "import { UI_SIZES } from '@/lib/ui-size';\n"
  + 'export function AppearanceSettings() {\n'
  + '  const { size, setSize } = useUiSize();\n'
  + '  return <div>{UI_SIZES.map((value) => <button key={value} aria-pressed={size === value} onClick={() => setSize(value)}>{value}</button>)}</div>;\n'
  + '}\n';
const THEME_PROVIDER = "'use client';\n"
  + "import { ThemeProvider as NextThemeProvider } from 'next-themes';\n"
  + 'export function ThemeProvider({ children }: { children: React.ReactNode }) {\n'
  + '  return <NextThemeProvider attribute="class" defaultTheme="system" enableSystem>{children}</NextThemeProvider>;\n}\n';
const THEME_SETTINGS = (extra = '') => "'use client';\n"
  + "import { useTheme } from 'next-themes';\n" + extra
  + 'export function ThemeButtons() {\n'
  + '  const { setTheme } = useTheme();\n'
  + "  return <button onClick={() => setTheme('dark')}>dark</button>;\n}\n";

function context(root: string, policy: Record<string, unknown> = {}): ToolSourceContext {
  return {
    root,
    config: loadToolsConfig(root),
    resolutions: { conventions: EMPTY_CONVENTIONS, entries: new Map() },
    policy: ToolPolicyFileSchema.parse({ schemaVersion: 1, ...policy }),
    previousContracts: new Map(),
    probe: createSchemaProbe(),
  };
}

async function observe(files: Record<string, string>, policy?: Record<string, unknown>) {
  const app = await createAppFixture({
    'tsconfig.json': JSON.stringify({
      compilerOptions: { strict: true, jsx: 'preserve', baseUrl: '.', paths: { '@/*': ['./src/*'] } },
    }),
    ...files,
  });
  return createReactActionSource().observe(context(app.root, policy));
}

const unbound = (observed: Awaited<ReturnType<typeof observe>>) => observed.findings
  .filter((finding) => finding.code === 'ui-control-unbound');

describe('ui controls without a client action', { timeout: 120_000 }, () => {
  it('reports a context setter with a closed domain and proposes the registration in its provider', async () => {
    const observed = await observe({
      'src/lib/ui-size.ts': SIZE_LIB,
      'src/components/layout/ui-size-provider.tsx': SIZE_PROVIDER(),
      'src/components/settings/appearance-settings.tsx': SETTINGS,
    });
    expect(observed.complete).toBe(true);
    expect(observed.observations).toEqual([]);
    expect(unbound(observed)).toEqual([expect.objectContaining({
      code: 'ui-control-unbound',
      severity: 'warning',
      subjectRef: 'src/components/layout/ui-size-provider.tsx#setSize',
      expected: {
        actionId: 'ui-size.set',
        file: 'src/components/layout/ui-size-provider.tsx',
        setter: 'setSize',
        state: 'size',
        values: ['extraLarge', 'large', 'medium', 'small'],
        usedIn: ['src/components/settings/appearance-settings.tsx'],
        registration: "useAiClientAction('ui-size.set', ({ size }) => setSize(size), "
          + "z.object({ size: z.enum(['extraLarge', 'large', 'medium', 'small']) }));",
      },
    })]);
  });

  it('reports the next-themes setter with the themes its ThemeProvider offers', async () => {
    const observed = await observe({
      'src/components/layout/theme-provider.tsx': THEME_PROVIDER,
      'src/components/settings/theme-buttons.tsx': THEME_SETTINGS(),
    });
    expect(unbound(observed)).toEqual([expect.objectContaining({
      subjectRef: 'src/components/layout/theme-provider.tsx#setTheme',
      expected: expect.objectContaining({
        actionId: 'theme.set',
        file: 'src/components/layout/theme-provider.tsx',
        setter: 'setTheme',
        state: 'theme',
        values: ['dark', 'light', 'system'],
        usedIn: ['src/components/settings/theme-buttons.tsx'],
        registration: "const { setTheme } = useTheme();\nuseAiClientAction('theme.set', ({ theme }) => setTheme(theme), "
          + "z.object({ theme: z.enum(['dark', 'light', 'system']) }));",
      }),
    })]);
  });

  it('reads explicit themes and a disabled system theme', async () => {
    const provider = THEME_PROVIDER.replace('enableSystem', "enableSystem={false} themes={['light', 'dark', 'sepia']}");
    const observed = await observe({ 'src/components/layout/theme-provider.tsx': provider });
    expect(unbound(observed)[0]?.expected).toMatchObject({ values: ['dark', 'light', 'sepia'] });
  });

  it('stays quiet once a client action reaches the setter, in the provider or through the hook', async () => {
    const inProvider = await observe({
      'src/lib/ui-size.ts': SIZE_LIB,
      'src/components/layout/ui-size-provider.tsx': SIZE_PROVIDER(
        "  useAiClientAction('ui-size.set', ({ size }) => setSize(size), z.object({ size: z.enum(UI_SIZES) }));\n",
        "import { z } from 'zod';\nimport { useAiClientAction } from 'glirastes/react';\n",
      ),
    });
    expect(unbound(inProvider)).toEqual([]);
    expect(inProvider.observations.map((tool) => tool.execution.definitionId)).toEqual(['ui.uiSize.set']);
    expect(inProvider.observations[0]?.findings).toEqual([]);

    const throughHook = await observe({
      'src/lib/ui-size.ts': SIZE_LIB,
      'src/components/layout/ui-size-provider.tsx': SIZE_PROVIDER(),
      'src/components/layout/size-action.tsx': "import { z } from 'zod';\nimport { useAiClientAction } from 'glirastes/react';\n"
        + "import { useUiSize } from './ui-size-provider';\nimport { UI_SIZES } from '@/lib/ui-size';\n"
        + 'export function SizeAction() {\n  const { setSize } = useUiSize();\n'
        + "  useAiClientAction('ui-size.set', ({ size }) => setSize(size), z.object({ size: z.enum(UI_SIZES) }));\n  return null;\n}\n",
    });
    expect(unbound(throughHook)).toEqual([]);

    const theme = await observe({
      'src/components/layout/theme-provider.tsx': THEME_PROVIDER,
      'src/components/settings/theme-buttons.tsx': THEME_SETTINGS().replace(
        '  const { setTheme } = useTheme();\n',
        '  const { setTheme } = useTheme();\n'
          + "  useAiClientAction('theme.set', ({ theme }) => setTheme(theme), z.object({ theme: z.enum(['dark', 'light', 'system']) }));\n",
      ).replace("import { useTheme } from 'next-themes';\n",
        "import { useTheme } from 'next-themes';\nimport { z } from 'zod';\nimport { useAiClientAction } from 'glirastes/react';\n"),
    });
    expect(unbound(theme)).toEqual([]);
  });

  it('flags a client action whose contract allows values the setter does not know', async () => {
    const observed = await observe({
      'src/lib/ui-size.ts': SIZE_LIB,
      'src/components/layout/ui-size-provider.tsx': SIZE_PROVIDER(
        "  useAiClientAction('ui-size.set', ({ size }) => setSize(size as UiSize), z.object({ size: z.enum(['small', 'huge']) }));\n",
        "import { z } from 'zod';\nimport { useAiClientAction } from 'glirastes/react';\n",
      ),
    });
    expect(unbound(observed)).toEqual([]);
    expect(observed.observations[0]?.findings).toEqual([expect.objectContaining({
      code: 'ui-control-contract-mismatch',
      severity: 'needs_attention',
      subjectRef: 'UI action ui-size.set',
    })]);
  });

  it('proposes z.boolean() for a boolean setter', async () => {
    const observed = await observe({
      'src/components/compact.tsx': "import { createContext } from 'react';\n"
        + 'export const CompactModeContext = createContext({ compact: false, setCompact: (value: boolean) => { void value; } });\n',
    });
    expect(unbound(observed)[0]?.expected).toMatchObject({
      actionId: 'compact-mode.set',
      values: [false, true],
      registration: "useAiClientAction('compact-mode.set', ({ compact }) => setCompact(compact), z.object({ compact: z.boolean() }));",
    });
  });

  it('leaves out open domains, setters that write to a server, secrets and excluded controls', async () => {
    const files = {
      'src/components/contexts.tsx': "import { createContext } from 'react';\n"
        + 'export const SearchContext = createContext({ query: \'\', setQuery: (query: string) => { void query; } });\n'
        + "type Mode = 'shown' | 'hidden';\n"
        + "export const PasswordContext = createContext({ password: 'shown' as Mode, setPassword: (mode: Mode) => { void mode; } });\n"
        + "export const PlanContext = createContext<{ plan: 'free' | 'pro'; setPlan(plan: 'free' | 'pro'): void }>({ plan: 'free', setPlan: () => {} });\n"
        + "async function savePlan(plan: 'free' | 'pro') { await fetch('/api/plan', { method: 'POST', body: plan }); }\n"
        + 'export function PlanProvider({ children }: { children: React.ReactNode }) {\n'
        + "  return <PlanContext.Provider value={{ plan: 'free', setPlan: savePlan }}>{children}</PlanContext.Provider>;\n}\n",
      'src/lib/ui-size.ts': SIZE_LIB,
      'src/components/layout/ui-size-provider.tsx': SIZE_PROVIDER(),
    };
    const observed = await observe(files, {
      excludeControls: [{ control: 'src/components/layout/ui-size-provider.tsx#setSize', reason: 'Not for the chat.' }],
    });
    expect(unbound(observed)).toEqual([]);
  });

  it('ignores files that merely mention a setter in a comment', async () => {
    const observed = await observe({
      'tsconfig.json': TSCONFIG,
      'src/notes.ts': '// createContext and next-themes are discussed here.\nexport const note = 1;\n',
    });
    expect(observed.findings).toEqual([]);
  });
});
