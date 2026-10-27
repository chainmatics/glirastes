/** The fixture ships no model and no key; an app returns its own provider model here. */
export function chatModel() {
  throw new Error('Configure the chat model in runtime/model.mjs');
}
