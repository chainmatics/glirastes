import type { ReferenceGeneration } from './adapter.mjs';

/** Writes `.glirastes/runtime.mjs` atomically and returns the generation it was built from. */
export function buildReference(rootDir: string): Promise<ReferenceGeneration>;
