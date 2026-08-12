export type RuntimeMode = 'standalone' | 'managed';

/**
 * Standalone is the default. Managed is opted into by configuring the
 * control plane. A half-configured managed mode fails closed — it never
 * silently degrades into standalone.
 */
export function resolveRuntimeMode(
  env: Record<string, string | undefined>,
): RuntimeMode {
  const controlPlaneUrl = env.GLIRASTES_CONTROL_PLANE_URL?.trim();
  if (!controlPlaneUrl) return 'standalone';
  if (!env.GLIRASTES_API_KEY?.trim()) {
    throw new Error(
      'Managed mode is configured (GLIRASTES_CONTROL_PLANE_URL) but '
      + 'GLIRASTES_API_KEY is missing. Refusing to fall back to standalone.',
    );
  }
  return 'managed';
}
