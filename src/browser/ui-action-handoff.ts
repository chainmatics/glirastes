/**
 * Model-facing note of a UI tool result. The server only hands a UI action
 * to the browser; it does not learn whether the app carried it out (a
 * contract check or handler can still refuse it, an app may have no handler
 * at all). The note keeps the model from reporting the action as done.
 */
export const UI_ACTION_HANDOFF_NOTE =
  'Whether it was carried out is not known: do not tell the user it succeeded, say it was requested. Do not quote this text.';

/** `message` of a UI tool result that handed its action to the app. */
export const UI_ACTION_HANDOFF_MESSAGE = `Handed to the app. ${UI_ACTION_HANDOFF_NOTE}`;

/** `message` of a page-bound client action the app runs after opening `route`. */
export function uiActionHandoffToRouteMessage(route: string): string {
  return `Handed to the app, which opens ${route} to run the action there. ${UI_ACTION_HANDOFF_NOTE}`;
}

/**
 * True for a tool result message that is only the model-facing hand-off
 * note. The chat UI does not show it to the user.
 */
export function isUiActionHandoffMessage(message: unknown): boolean {
  return typeof message === 'string' && message.endsWith(UI_ACTION_HANDOFF_NOTE);
}
