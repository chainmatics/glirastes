// ============================================================================
// glirastes/embed
//
// Framework-neutral chat embedding: <glirastes-chat> wraps the React chat UI
// in a Shadow DOM for non-React hosts (Vue, Angular, Svelte, plain HTML).
// Peer requirements: react, react-dom, @ai-sdk/react and ai.
// ============================================================================

export {
  GLIRASTES_CHAT_TAG,
  GlirastesChatElement,
  defineGlirastesChatElement,
  type GlirastesChatElementConfig,
  type GlirastesChatEventMap,
  type GlirastesChatEventName,
} from './glirastes-chat-element.js';
export { EMBED_CSS_VARIABLES, embedThemeCss } from './theme.js';
export {
  defineChatCommand,
  defineChatEntity,
  type ChatCommandDefinition,
  type ChatEntityAction,
  type ChatEntityCard,
  type ChatEntityDefinition,
  type ChatEntityItem,
  type ChatEntitySearchContext,
} from '../react/interactions/definitions.js';
export type {
  ChatInteractionArg,
  ChatInteractionsData,
  ChatLocaleCode,
  ChatText,
} from '../contracts/chat-interactions.js';
