import { attachmentIdOf, isChatAttachmentId } from '../../contracts/attachments.js';
import type { ChatMessage } from '../types.js';
import { dataUrlToBlob, type AttachmentBlobStore, type StoredAttachment } from './attachment-blob-store.js';

export interface ChatAttachmentSource {
  conversationId: string;
  messages: () => ReadonlyArray<ChatMessage>;
  store: AttachmentBlobStore | null;
}

let activeSource: ChatAttachmentSource | null = null;

/** Internal: the provider registers its active chat. Last writer wins. */
export function setActiveChatAttachmentSource(source: ChatAttachmentSource | null): void {
  activeSource = source;
}

/** Internal: clears the source only if it is still the caller's own. */
export function clearChatAttachmentSource(source: ChatAttachmentSource): void {
  if (activeSource === source) activeSource = null;
}

function fromMessages(source: ChatAttachmentSource, id: string): StoredAttachment | null {
  for (const message of source.messages()) {
    for (const part of message.parts as ReadonlyArray<unknown>) {
      const p = part as { type?: string; url?: unknown; filename?: string; mediaType?: string };
      if (p.type !== 'file' || attachmentIdOf(part) !== id || typeof p.url !== 'string') continue;
      const blob = dataUrlToBlob(p.url);
      if (blob) return { blob, name: p.filename ?? 'file', mediaType: p.mediaType ?? blob.type };
    }
  }
  return null;
}

/** Resolves an attachment of the active chat; anything else gives `null`. */
export async function getChatAttachment(id: string): Promise<StoredAttachment | null> {
  const source = activeSource;
  if (!source || !isChatAttachmentId(id)) return null;
  const live = fromMessages(source, id);
  if (live) return live;
  if (!source.store) return null;
  return source.store.get(source.conversationId, id).catch(() => null);
}

export async function chatAttachmentFormData(id: string, field = 'file'): Promise<FormData | null> {
  const attachment = await getChatAttachment(id);
  if (!attachment) return null;
  const form = new FormData();
  form.append(field, new File([attachment.blob], attachment.name, { type: attachment.mediaType }));
  return form;
}
