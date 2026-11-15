/**
 * The environment chain of an app (E1 < E2 < … < En, any names, any length):
 * the branches environments deploy from. New code is described where it
 * enters the chain; a promotion between environments carries what the lower
 * one accepted and never changes it.
 */

/** Branch names the fallback detection looks for on origin when no chain is configured. */
export const DEFAULT_ENVIRONMENT_CANDIDATES = [
  'dev', 'develop', 'development', 'pre-dev', 'qa', 'test', 'uat', 'staging', 'stage', 'preprod',
  'main', 'master', 'prod', 'production', 'live',
] as const;

const BRANCH = /^(?!.*\.\.)[A-Za-z0-9._/-]{1,200}$/;

/** A comma-separated list of branch names; `undefined` when empty or invalid. */
export function parseEnvironmentList(value: string | undefined): string[] | undefined {
  const names = (value ?? '').split(',').map((name) => name.trim()).filter((name) => name !== '');
  if (names.length === 0 || names.some((name) => !BRANCH.test(name))) return undefined;
  return [...new Set(names)];
}

export interface EnvironmentSources {
  /** `--environments a,b,c` */
  flag?: string;
  /** `GLIRASTES_ENVIRONMENT_BRANCHES` */
  env?: string;
  /** `enrich.environments` of `.glirastes/tools.json` */
  config?: ReadonlyArray<string>;
  /** Branches on origin, for the fallback detection. */
  remoteBranches: () => Promise<string[] | undefined>;
}

/** The chain from the flag, the environment, the config, or else the known names that exist on origin. */
export async function environmentBranches(sources: EnvironmentSources): Promise<{ branches: string[]; source: 'flag' | 'env' | 'config' | 'detected' }> {
  const flag = parseEnvironmentList(sources.flag);
  if (flag) return { branches: flag, source: 'flag' };
  const env = parseEnvironmentList(sources.env);
  if (env) return { branches: env, source: 'env' };
  if (sources.config && sources.config.length > 0) return { branches: [...sources.config], source: 'config' };
  const remote = new Set(await sources.remoteBranches() ?? []);
  return { branches: DEFAULT_ENVIRONMENT_CANDIDATES.filter((name) => remote.has(name)), source: 'detected' };
}

/**
 * The environment a run promotes from, or `undefined` when it brings new code.
 * A promotion is a head branch that is an environment itself, or a head commit
 * some other environment already holds (a release branch cut from one, a
 * fast-forward merged up). Containment that cannot be decided is no promotion:
 * the content check still keeps current entries unchanged.
 */
export async function promotionSource(input: {
  head: string;
  base: string;
  environments: ReadonlyArray<string>;
  containedIn: (environment: string) => Promise<boolean | undefined>;
}): Promise<string | undefined> {
  if (input.head !== input.base && input.environments.includes(input.head)) return input.head;
  for (const environment of input.environments) {
    if (environment === input.base || environment === input.head) continue;
    if (await input.containedIn(environment) === true) return environment;
  }
  return undefined;
}
