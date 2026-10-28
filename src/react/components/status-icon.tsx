export type StatusIconKind = 'check' | 'spinner' | 'pending' | 'error';

/**
 * Inline status icon. It carries its own shape and motion (SMIL), so it
 * reads correctly in unstyled mode without any stylesheet.
 */
export function StatusIcon({ icon }: { icon: StatusIconKind }) {
  return (
    <svg
      data-element="icon"
      data-icon={icon}
      viewBox="0 0 16 16"
      width="14"
      height="14"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {icon === 'check' && <path d="M3 8.5l3.5 3.5L13 4.5" />}
      {icon === 'error' && <path d="M4.5 4.5l7 7M11.5 4.5l-7 7" />}
      {icon === 'pending' && <circle cx="8" cy="8" r="5.5" strokeWidth="1.5" opacity="0.5" />}
      {icon === 'spinner' && (
        <path d="M8 2.5a5.5 5.5 0 1 1-5.5 5.5">
          <animateTransform
            attributeName="transform"
            type="rotate"
            from="0 8 8"
            to="360 8 8"
            dur="0.9s"
            repeatCount="indefinite"
          />
        </path>
      )}
    </svg>
  );
}
