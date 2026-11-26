export {
  bindable,
  defineChatComponent,
  mergeChatManifests,
  refOnly,
  toChatComponentManifest,
} from './define.js';
export { chatElementId } from './element-id.js';
export type {
  ChatComponentChildren,
  ChatComponentDefinition,
  ChatComponentDefinitionInput,
  ChatComponentItemScope,
  ChatComponentTextRule,
  ChatPropSchema,
  ChatPropsOf,
} from './define.js';
export { starterChatComponentManifest, starterChatComponents } from './starter-catalog.js';
export { CHAT_VIEW_PROMPT_RULE, describeChatCatalog } from './describe.js';
export { effectiveChatManifest, validateChatViewSpec } from './validate.js';
export type { ChatViewSpecValidation, ValidateChatViewSpecOptions } from './validate.js';
export { resolveChatView } from './resolve.js';
export type { ChatViewResolution, ChatViewSource, ChatViewSourceLookup } from './resolve.js';
export { chatElementToText, chatViewToText } from './text.js';
export type { ChatViewTextOptions } from './text.js';
// The types the functions above take and return, so a root import is enough.
export type {
  ChatComponentManifest,
  ChatComponentManifestEntry,
  ChatItemRef,
  ChatOperator,
  ChatSaid,
  ChatValueRef,
  ChatViewCapabilities,
  ChatViewSpec,
  ResolvedChatView,
} from '../contracts/chat-view.js';
