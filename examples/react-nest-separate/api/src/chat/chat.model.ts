import type { LanguageModel } from 'ai';

/** The fixture ships no model and no key; an app returns its own provider model here. */
export function chatModel(): LanguageModel {
  throw new Error('Configure the chat model in api/src/chat/chat.model.ts');
}
