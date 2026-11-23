/** Internal provenance for SDK conversion, also retained by ordinary object copies. */
const CONVERSION = Symbol.for('glirastes.privacy-conversion');
interface Conversion { execute: unknown; protectedTool: () => object }
const executions = new WeakMap<Function, Conversion>();

export function markPrivacyConversion<T extends object>(tool: T, protectedTool: () => object): T {
  const execute = (tool as { execute?: unknown }).execute;
  const conversion = { execute, protectedTool };
  Object.defineProperty(tool, CONVERSION, { value: conversion, enumerable: true });
  if (typeof execute === 'function') executions.set(execute, conversion);
  return tool;
}

/** Rebuild before lossy conversion; do not remove consumer-added execution guards. */
export function preparePrivacyConversion<T extends object>(tool: T): T {
  const candidate = tool as { [CONVERSION]?: Conversion; execute?: unknown };
  const conversion = candidate[CONVERSION]
    ?? (typeof candidate.execute === 'function' ? executions.get(candidate.execute) : undefined);
  if (!conversion) return tool;
  if (candidate.execute !== conversion.execute) {
    // An arbitrary replacement cannot safely be reconstructed around the original
    // conversion. Refuse instead of discarding its authorization or executing it.
    return { ...tool, execute: async () => ({ success: false, error: 'privacy_tool_conversion_unsupported' }) };
  }
  return { ...tool, ...conversion.protectedTool() };
}
