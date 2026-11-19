import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { useChatContext } from '../provider/chat-context.js';
import { fillTemplate } from '../utils/fill-template.js';
import type { AttachmentButtonProps, AttachmentTrayProps } from '../types.js';

const VISUALLY_HIDDEN: CSSProperties = {
  position: 'absolute',
  width: 1,
  height: 1,
  padding: 0,
  margin: -1,
  overflow: 'hidden',
  clip: 'rect(0,0,0,0)',
  whiteSpace: 'nowrap',
  border: 0,
};

const fill = (text: string, name: string) => fillTemplate(text, { name });

/**
 * Files waiting in the composer: image thumbnails, other files by name,
 * each with a remove button. Errors and added files are announced politely.
 */
export function AttachmentTray({ attachments, onRemove, error, className }: AttachmentTrayProps) {
  const { locale } = useChatContext();
  const known = useRef(new Set(attachments.map((attachment) => attachment.id)));
  const [added, setAdded] = useState('');

  useEffect(() => {
    const fresh = attachments.filter((attachment) => !known.current.has(attachment.id));
    known.current = new Set(attachments.map((attachment) => attachment.id));
    if (fresh.length > 0) setAdded(fresh.map((attachment) => fill(locale.attachmentAddedLabel, attachment.name)).join(', '));
  }, [attachments, locale.attachmentAddedLabel]);

  return (
    <div className={className} data-component="attachment-tray" data-state={error ? 'error' : 'idle'}>
      {attachments.length > 0 && (
        <ul role="list" aria-label={locale.attachmentsLabel} data-element="attachment-list">
          {attachments.map((attachment) => (
            <li key={attachment.id} data-element="attachment" data-kind={attachment.previewUrl ? 'image' : 'file'}>
              {attachment.previewUrl
                ? <img src={attachment.previewUrl} alt={attachment.name} data-element="thumbnail" />
                : <span data-element="file-name" title={attachment.name}>{attachment.name}</span>}
              <button
                type="button"
                data-action="remove-attachment"
                aria-label={fill(locale.removeAttachmentLabel, attachment.name)}
                title={fill(locale.removeAttachmentLabel, attachment.name)}
                onClick={() => onRemove(attachment.id)}
              >
                {'×'}
              </button>
            </li>
          ))}
        </ul>
      )}
      <div
        role="status"
        aria-live="polite"
        data-element="attachment-status"
        style={error ? undefined : VISUALLY_HIDDEN}
      >
        {error ?? added}
      </div>
    </div>
  );
}

/** Paperclip button that opens the composer's file picker. */
export function AttachmentButton({ onClick, disabled, className }: AttachmentButtonProps) {
  const { locale } = useChatContext();
  return (
    <button
      type="button"
      className={className}
      data-component="attachment-button"
      aria-label={locale.attachButtonLabel}
      title={locale.attachButtonLabel}
      disabled={disabled}
      onClick={onClick}
    >
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48" />
      </svg>
    </button>
  );
}
