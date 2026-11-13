export type RuntimeMode = 'standalone' | 'managed';

/** The hosted Glirastes Platform. Set `GLIRASTES_CONTROL_PLANE_URL` only to self-host or run it locally. */
export const DEFAULT_CONTROL_PLANE_URL = 'https://api.glirastes.io';

/** The shape of a runtime key issued by `glirastes connect`. */
export const RUNTIME_API_KEY_PATTERN = /^gl_[A-Za-z0-9]{32,128}$/;

/** What a connected runtime reads from its environment; the rest it asks the Platform. */
export interface RuntimeConnectionConfig {
  baseUrl: string;
  apiKey: string;
  /** `GLIRASTES_ENVIRONMENT`; absent means a development connection. */
  environment?: string;
}

const ENVIRONMENT_KEY_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:';
  } catch {
    return false;
  }
}

/**
 * The connection of this process, or undefined in Standalone. The switch is
 * `GLIRASTES_API_KEY`: without it the runtime stays network-silent. A
 * malformed key or a control plane URL that is not http(s) fails closed; the
 * error names the variable, never its value.
 */
export function resolveRuntimeConnectionConfig(
  env: Record<string, string | undefined>,
): RuntimeConnectionConfig | undefined {
  const apiKey = env.GLIRASTES_API_KEY?.trim();
  const configuredUrl = env.GLIRASTES_CONTROL_PLANE_URL?.trim();
  if (configuredUrl && !isHttpUrl(configuredUrl)) {
    throw new Error('GLIRASTES_CONTROL_PLANE_URL must be an http(s) URL.');
  }
  if (!apiKey) return undefined;
  if (!RUNTIME_API_KEY_PATTERN.test(apiKey)) {
    throw new Error(
      'GLIRASTES_API_KEY is malformed. Refusing to fall back to standalone; '
      + 'rerun `glirastes connect` or remove the variable.',
    );
  }
  const environment = env.GLIRASTES_ENVIRONMENT?.trim();
  if (environment && !ENVIRONMENT_KEY_PATTERN.test(environment)) {
    throw new Error(
      'GLIRASTES_ENVIRONMENT must be lowercase letters, digits and hyphens (up to 64), starting with a letter or digit.',
    );
  }
  return {
    baseUrl: configuredUrl || DEFAULT_CONTROL_PLANE_URL,
    apiKey,
    ...(environment ? { environment } : {}),
  };
}

/**
 * Standalone is the default. Managed (Connected) is opted into by setting
 * `GLIRASTES_API_KEY`. A malformed configuration fails closed — it never
 * silently degrades into standalone.
 */
export function resolveRuntimeMode(
  env: Record<string, string | undefined>,
): RuntimeMode {
  return resolveRuntimeConnectionConfig(env) ? 'managed' : 'standalone';
}
