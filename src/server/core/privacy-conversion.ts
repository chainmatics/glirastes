/** Internal provenance for SDK conversion, also retained by ordinary object copies. */
const CONVERSION = Symbol.for('glirastes.privacy-conversion');
interface Conversion { execute: unknown; protectedTool: () => object }


export function markPrivacyConversion<T extends object>(tool: T, protectedTool: () => object): T {
  const execute = (tool as { execute?: unknown }).execute;
  const conversion = { execute, protectedTool };
  Object.defineProperty(tool, CONVERSION, { value: conversion, enumerable: true });
  if (typeof execute === 'function') Object.defineProperty(execute, CONVERSION, { value: conversion });
  return tool;
}

/** Rebuild before lossy conversion; do not remove consumer-added execution guards. */
export function preparePrivacyConversion<T extends object>(tool: T): T {
  const candidate = tool as { [CONVERSION]?: Conversion; execute?: unknown };
  const conversion = candidate[CONVERSION]
    ?? (typeof candidate.execute === 'function' ? (candidate.execute as unknown as { [CONVERSION]?: Conversion })[CONVERSION] : undefined);
  if (!conversion) return tool;
  if (candidate.execute !== conversion.execute) {
    // An arbitrary replacement cannot safely be reconstructed around the original
    // conversion. Refuse instead of discarding its authorization or executing it.
    return Object.create(Object.getPrototypeOf(tool), { ...Object.getOwnPropertyDescriptors(tool),
      execute: {value: async () => ({success:false,error:'privacy_tool_conversion_unsupported'}), enumerable:true, configurable:true},
    }) as T;
  }
  // Only replace the SDK result projection. The current descriptor owns its
  // schema, approval predicate and all other consumer authorization metadata.
  const protectedTool = conversion.protectedTool() as { execute?: unknown; needsApproval?: unknown };
  return Object.create(Object.getPrototypeOf(tool), { ...Object.getOwnPropertyDescriptors(tool),
    // The original descriptor remains the authorization receiver. Copies of
    // own state would freeze mutable flags and change `this` inside guards.
    needsApproval: { enumerable: true, configurable: true, get: () => {
      const owner = 'needsApproval' in tool ? tool as { needsApproval?: unknown } : protectedTool;
      const guard = owner.needsApproval;
      return typeof guard === 'function' ? guard.bind(owner) : guard;
    } },
    execute: { value: protectedTool.execute, enumerable: true, configurable: true },
  }) as T;
}
