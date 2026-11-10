/**
 * Scope the model-facing tools to the pipeline's module selection.
 *
 * A selected name missing from `aiTools` but present in the registry was
 * removed for this principal (roles, approval state) and is skipped silently.
 * A selected name the registry has never served is configuration drift —
 * module definitions referencing retired tool names once shipped an app whose
 * model could not call a single domain tool while every probe stayed green.
 * That case fails closed and names the offenders.
 */
export function scopePipelineTools<T>(options: {
  aiTools: Record<string, T>;
  registryToolNames: ReadonlySet<string>;
  selected: ReadonlyArray<string>;
  /** Preserve historical behavior unless the pipeline declares an exact selection. */
  fallbackToAll?: boolean;
}): Record<string, T> {
  const unknown = options.selected.filter(
    (name) => !options.registryToolNames.has(name),
  );
  if (unknown.length > 0) {
    throw new Error(
      'Pipeline selected tools unknown to the tool registry '
      + `(module configuration drift): ${unknown.join(', ')}`,
    );
  }

  const scoped: Record<string, T> = {};
  for (const name of options.selected) {
    if (options.aiTools[name]) scoped[name] = options.aiTools[name];
  }
  return options.fallbackToAll === false || Object.keys(scoped).length > 0
    ? scoped
    : options.aiTools;
}
