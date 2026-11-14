import {
  DEFAULT_ATTACHMENT_MAX_FILE_BYTES,
  DEFAULT_ATTACHMENT_MAX_FILES,
  DEFAULT_ATTACHMENT_MEDIA_TYPES,
  attachmentPlaceholderText,
  isOmittedAttachmentUrl,
} from '../../contracts/attachments.js';
import type { ChatAttachment, ChatAttachmentOptions, ChatMessage, FilePart, MessagePart } from '../types.js';

export interface ResolvedAttachmentOptions {
  mediaTypes: ReadonlyArray<string>;
  maxFiles: number;
  maxFileBytes: number;
  prepare?: ChatAttachmentOptions['prepare'];
}

export type AttachmentProblem =
  | { code: 'type'; name: string }
  | { code: 'too-many'; count: number }
  | { code: 'too-large'; name: string; maxBytes: number }
  | { code: 'read-failed'; name: string }
  | { code: 'command' }
  | { code: 'unsupported' };

/** Null when attachments are off. */
export function resolveAttachmentOptions(
  config: boolean | ChatAttachmentOptions | undefined,
): ResolvedAttachmentOptions | null {
  if (!config) return null;
  const options = config === true ? {} : config;
  if (options.enabled === false) return null;
  return {
    mediaTypes: (options.mediaTypes ?? DEFAULT_ATTACHMENT_MEDIA_TYPES).map((type) => type.toLowerCase()),
    maxFiles: options.maxFiles ?? DEFAULT_ATTACHMENT_MAX_FILES,
    maxFileBytes: options.maxFileBytes ?? DEFAULT_ATTACHMENT_MAX_FILE_BYTES,
    prepare: options.prepare,
  };
}

/** The files that fit the type list and the remaining count; the first refusal is reported. */
export function validateFiles(
  files: ReadonlyArray<File>,
  existingCount: number,
  options: ResolvedAttachmentOptions,
): { accepted: File[]; error: AttachmentProblem | null } {
  const accepted: File[] = [];
  let error: AttachmentProblem | null = null;
  for (const file of files) {
    if (!options.mediaTypes.includes(file.type.toLowerCase())) {
      error ??= { code: 'type', name: file.name };
      continue;
    }
    if (existingCount + accepted.length >= options.maxFiles) {
      error ??= { code: 'too-many', count: options.maxFiles };
      continue;
    }
    accepted.push(file);
  }
  return { accepted, error };
}

export function fileToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => (typeof reader.result === 'string' ? resolve(reader.result) : reject(new Error('unreadable')));
    reader.onerror = () => reject(reader.error ?? new Error('unreadable'));
    reader.readAsDataURL(blob);
  });
}

let nextAttachmentId = 0;

/** Checks, prepares and reads files into composer attachments. */
export async function readAttachments(
  files: ReadonlyArray<File>,
  existingCount: number,
  options: ResolvedAttachmentOptions,
): Promise<{ attachments: ChatAttachment[]; error: AttachmentProblem | null }> {
  const checked = validateFiles(files, existingCount, options);
  let error = checked.error;
  const attachments: ChatAttachment[] = [];
  for (const file of checked.accepted) {
    let prepared: Blob;
    let url: string;
    try {
      prepared = options.prepare ? await options.prepare(file) : file;
      if (prepared.size > options.maxFileBytes) {
        error ??= { code: 'too-large', name: file.name, maxBytes: options.maxFileBytes };
        continue;
      }
      url = await fileToDataUrl(prepared);
    } catch {
      error ??= { code: 'read-failed', name: file.name };
      continue;
    }
    const mediaType = (prepared.type || file.type).toLowerCase();
    nextAttachmentId += 1;
    attachments.push({
      id: `attachment-${Date.now().toString(36)}-${nextAttachmentId}`,
      name: file.name,
      mediaType,
      size: prepared.size,
      url,
      ...(mediaType.startsWith('image/') ? { previewUrl: url } : {}),
    });
  }
  return { attachments, error };
}

export function toFilePart(attachment: ChatAttachment): FilePart {
  return { type: 'file', mediaType: attachment.mediaType, url: attachment.url, filename: attachment.name };
}

const isFilePart = (part: MessagePart | Record<string, unknown>): part is FilePart =>
  (part as { type?: unknown }).type === 'file';

const placeholder = (part: FilePart): MessagePart =>
  ({ type: 'text', text: attachmentPlaceholderText(part.filename) });

/**
 * The messages as sent: file data only in the `keepUserTurns` most recent
 * user messages, a text placeholder elsewhere, so request bodies stay bounded.
 */
export function limitRequestAttachments<T extends Pick<ChatMessage, 'role' | 'parts'>>(
  messages: T[],
  keepUserTurns = 2,
): T[] {
  let userTurns = 0;
  let changed = false;
  const result = [...messages];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!;
    if (message.role === 'user') userTurns += 1;
    const keep = message.role === 'user' && userTurns <= keepUserTurns;
    if (!Array.isArray(message.parts) || !message.parts.some(isFilePart)) continue;
    const drop = (part: FilePart) => !keep || isOmittedAttachmentUrl(part.url);
    if (!message.parts.some((part) => isFilePart(part) && drop(part))) continue;
    changed = true;
    result[index] = {
      ...message,
      parts: message.parts.map((part) => (isFilePart(part) && drop(part) ? placeholder(part) : part)),
    };
  }
  return changed ? result : messages;
}

/** The messages to store: file parts keep name and type, their data is dropped. */
export function omitAttachmentData<T extends Pick<ChatMessage, 'parts'>>(messages: T[]): T[] {
  return messages.map((message) => (Array.isArray(message.parts) && message.parts.some(isFilePart)
    ? { ...message, parts: message.parts.map((part) => (isFilePart(part) ? { ...part, url: '' } : part)) }
    : message));
}

export function formatBytes(bytes: number): string {
  if (bytes >= 1_000_000) return `${Math.round(bytes / 100_000) / 10} MB`;
  if (bytes >= 1_000) return `${Math.round(bytes / 1_000)} KB`;
  return `${bytes} B`;
}
