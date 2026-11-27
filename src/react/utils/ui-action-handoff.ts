import type { UiAction } from '../../browser/ui-action-bus.js';
import { extractUiAction } from './create-tool-result-handler.js';
import type { UiActionHandoffOptions } from '../types.js';

export function findPageAction(
  output: Record<string, unknown>,
  toolName: string,
  isPageAction?: UiActionHandoffOptions['isPageAction'],
): UiAction | undefined {
  const raw = extractUiAction(output);
  const actions = Array.isArray(raw) ? raw : [raw];
  return actions.find((action): action is UiAction =>
    typeof action === 'object' && action !== null && typeof action.type === 'string' && (
      action.type === 'glirastes.navigate'
      || (action.type === 'glirastes.action' && typeof action.route === 'string')
      || isPageAction?.(action, toolName) === true
    ));
}

export function pageActionDestination(action: UiAction): string | undefined {
  const href = action.type === 'glirastes.navigate' && typeof action.payload === 'object' && action.payload !== null
    ? (action.payload as { href?: unknown }).href
    : action.route;
  if (typeof href !== 'string' || !href.startsWith('/') || href.startsWith('//')) return undefined;
  return href.split(/[?#]/, 1)[0];
}
