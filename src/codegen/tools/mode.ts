import { FoundationDiagnosticError } from '../../diagnostics/index.js';

export type ToolsMode = 'write' | 'frozen' | 'integrity';

const MODES: ReadonlySet<string> = new Set(['write', 'frozen', 'integrity']);

export function isToolsMode(value: string): value is ToolsMode {
  return MODES.has(value);
}

/** Flag → GLIRASTES_TOOLS_MODE → CI set ⇒ frozen → write. */
export function resolveToolsMode(input: {
  flag?: ToolsMode;
  env: NodeJS.ProcessEnv;
}): ToolsMode {
  if (input.flag) return input.flag;
  const configured = input.env.GLIRASTES_TOOLS_MODE?.trim();
  if (configured) {
    if (!isToolsMode(configured)) {
      throw new FoundationDiagnosticError({
        code: 'E-TOOLS-003',
        operation: 'tools.mode',
        message: 'GLIRASTES_TOOLS_MODE must be write, frozen or integrity.',
        remediation: 'set-valid-tools-mode',
      });
    }
    return configured;
  }
  const ci = input.env.CI?.trim().toLowerCase();
  if (ci && ci !== '0' && ci !== 'false') return 'frozen';
  return 'write';
}
