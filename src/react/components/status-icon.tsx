import { useSyncExternalStore } from 'react';

export type StatusIconKind = 'check' | 'spinner' | 'pending' | 'error' | 'declined' | 'notice';

const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';

function reducedMotionQuery(): MediaQueryList | null {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return null;
  return window.matchMedia(REDUCED_MOTION_QUERY);
}

function subscribeReducedMotion(onChange: () => void): () => void {
  const query = reducedMotionQuery();
  if (!query) return () => {};
  if (typeof query.addEventListener === 'function') {
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }
  // Safari before 14.
  query.addListener?.(onChange);
  return () => query.removeListener?.(onChange);
}

/** True while the user's system asks for reduced motion; false on the server. */
function usePrefersReducedMotion(): boolean {
  return useSyncExternalStore(
    subscribeReducedMotion,
    () => reducedMotionQuery()?.matches === true,
    () => false,
  );
}

/**
 * Inline status icon. It carries its own shape and motion (SMIL), so it
 * reads correctly in unstyled mode without any stylesheet. Under
 * `prefers-reduced-motion: reduce` the spinner stands still as an open arc
 * (`data-motion="reduced"`), still unlike the faint full circle of `pending`.
 */
export function StatusIcon({ icon }: { icon: StatusIconKind }) {
  const reducedMotion = usePrefersReducedMotion();
  const still = icon === 'spinner' && reducedMotion;
  return (
    <svg
      data-element="icon"
      data-icon={icon}
      {...(still ? { 'data-motion': 'reduced' } : {})}
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
      {icon === 'declined' && <path d="M4.5 8h7" />}
      {icon === 'notice' && <path d="M8 4.5v4.5M8 11.5v.01" />}
      {icon === 'pending' && <circle cx="8" cy="8" r="5.5" strokeWidth="1.5" opacity="0.5" />}
      {icon === 'spinner' && (
        <path d="M8 2.5a5.5 5.5 0 1 1-5.5 5.5">
          {!still && (
            <animateTransform
              attributeName="transform"
              type="rotate"
              from="0 8 8"
              to="360 8 8"
              dur="0.9s"
              repeatCount="indefinite"
            />
          )}
        </path>
      )}
    </svg>
  );
}
