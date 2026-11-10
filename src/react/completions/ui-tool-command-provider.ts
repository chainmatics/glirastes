import type {
  ChatCompletionProvider,
  CompletionItem,
  UiToolCommandSource,
} from '../types.js';
import { describeToolReference } from '../utils/mention-markup.js';

interface UiToolCommand {
  readonly tool: UiToolCommandSource;
  readonly commandId: string;
  /** Fixed arguments; undefined when the source has none or an empty object. */
  readonly args?: Readonly<Record<string, unknown>>;
  /** The id is not the definition id, or fixed arguments exist: the model needs both. */
  readonly carriesTool: boolean;
}

function fold(value: string): string {
  return value.normalize('NFKD').replace(/\p{M}+/gu, '').toLowerCase().trim();
}

function rank(command: UiToolCommand, needle: string): number | undefined {
  if (!needle) return 0;
  const { tool } = command;
  const label = fold(tool.label);
  if (label.startsWith(needle)) return 0;
  if (label.split(/[^\p{L}\p{N}]+/u).some((word) => word.startsWith(needle))) return 1;
  if (label.includes(needle)) return 2;
  if ([command.commandId, tool.definitionId].some((id) => fold(id).includes(needle))) return 3;
  if ((tool.keywords ?? []).some((keyword) => fold(keyword).includes(needle))) return 4;
  return undefined;
}

function toCommand(tool: UiToolCommandSource): UiToolCommand {
  const commandId = tool.commandId ?? tool.definitionId;
  if (!commandId.trim() || commandId.length > 200 || /[:}]/.test(commandId)) {
    throw new Error(
      `Invalid UI tool command id ${JSON.stringify(commandId)} `
      + '(non-blank, max 200 characters, no ":" or "}")',
    );
  }
  const args = tool.args && Object.keys(tool.args).length > 0 ? tool.args : undefined;
  const carriesTool = commandId !== tool.definitionId || args !== undefined;
  if (carriesTool && describeToolReference(tool.definitionId, args) === undefined) {
    throw new Error(
      `UI tool command ${commandId} has a definition id or arguments the model cannot be given `
      + '(definition id [A-Za-z0-9_.-] up to 200 characters, arguments a JSON object up to 2000 characters)',
    );
  }
  return { tool, commandId, args, carriesTool };
}

/**
 * Built-in `/` command provider over the catalog's UI tools (navigation,
 * filters, dialogs). Role filtering only hides commands; executing one still
 * goes through the model, the turn snapshot and the app's own checks.
 *
 * The item id is the tool's `commandId` (default `definitionId`). A command
 * whose id is not the definition id, or that has fixed `args`, also carries
 * `definitionId` and `args` so the model learns which definition to run.
 * Creation throws on an invalid or duplicate command id.
 */
export function createUiToolCommandProvider(options: {
  tools: ReadonlyArray<UiToolCommandSource>;
  id?: string;
}): ChatCompletionProvider {
  const commands = options.tools
    .filter((tool) => tool.definitionId.trim() && tool.label.trim())
    .map(toCommand);
  const commandIds = new Set<string>();
  for (const { commandId } of commands) {
    if (commandIds.has(commandId)) {
      throw new Error(`Duplicate UI tool command id: ${commandId}`);
    }
    commandIds.add(commandId);
  }
  return {
    id: options.id ?? 'ui-tools',
    trigger: '/',
    search({ query, context, limit }) {
      const roles = new Set(context.roles ?? []);
      const needle = fold(query);
      return commands
        .filter(({ tool }) => !tool.allowedRoles?.length
          || tool.allowedRoles.some((role) => roles.has(role)))
        .map((command) => ({ command, rank: rank(command, needle) }))
        .filter((candidate): candidate is { command: UiToolCommand; rank: number } =>
          candidate.rank !== undefined)
        .sort((left, right) =>
          left.rank - right.rank
          || left.command.tool.label.localeCompare(right.command.tool.label))
        .slice(0, limit)
        .map(({ command: { tool, commandId, args, carriesTool } }): CompletionItem => ({
          id: commandId,
          type: 'command',
          label: tool.label,
          ...(tool.description ? { description: tool.description } : {}),
          ...(carriesTool ? { definitionId: tool.definitionId } : {}),
          ...(args ? { args } : {}),
        }));
    },
  };
}
