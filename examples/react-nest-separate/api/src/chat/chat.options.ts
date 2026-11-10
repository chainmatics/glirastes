import type { LanguageModel } from 'ai';

export const CHAT_OPTIONS = Symbol('CHAT_OPTIONS');

export interface ChatOptions {
  model: () => LanguageModel;
  /** The API's own origin, e.g. `http://127.0.0.1:4000`; tools call it with the user's credentials. */
  apiOrigin: () => string;
  tenantId: string;
}
