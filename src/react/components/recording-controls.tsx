/**
 * Shared cancel / stop buttons used by both AiTriggerButton and RecordingBar.
 * All styling is done via inline styles so the buttons render identically
 * regardless of the host CSS context (portal, chat panel, etc.).
 */

// ---------------------------------------------------------------------------
// Cancel Button
// ---------------------------------------------------------------------------

interface CancelButtonProps {
  onClick: () => void;
  ariaLabel?: string;
  title?: string;
}

export function CancelButton({ onClick, ariaLabel = 'Cancel recording', title }: CancelButtonProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={ariaLabel}
      title={title}
      data-element="cancel-button"
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: '28px',
        height: '28px',
        borderRadius: '9999px',
        flexShrink: 0,
        border: 'none',
        background: 'transparent',
        color: 'inherit',
        cursor: 'pointer',
        position: 'relative',
        zIndex: 10,
        padding: 0,
      }}
    >
      <svg
        xmlns="http://www.w3.org/2000/svg"
        width="14"
        height="14"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d="M18 6 6 18" />
        <path d="m6 6 12 12" />
      </svg>
    </button>
  );
}

// ---------------------------------------------------------------------------
// Stop Button
// ---------------------------------------------------------------------------

interface StopButtonProps {
  onClick: () => void;
  ariaLabel?: string;
  title?: string;
}

export function StopButton({ onClick, ariaLabel = 'Stop recording', title }: StopButtonProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={ariaLabel}
      title={title}
      data-element="stop-button"
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: '28px',
        height: '28px',
        borderRadius: '9999px',
        flexShrink: 0,
        border: 'none',
        backgroundColor: 'hsl(0 84% 60%)',
        cursor: 'pointer',
        padding: 0,
      }}
    >
      <svg width="10" height="10" viewBox="0 0 10 10" fill="white" aria-hidden="true">
        <rect x="0" y="0" width="10" height="10" rx="2" />
      </svg>
    </button>
  );
}
