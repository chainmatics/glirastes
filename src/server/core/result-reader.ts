// Enumerable provenance survives normal tool copies; execute identity also
// survives adapters which retain only the function. It carries no user data.
const READER = Symbol.for('glirastes.result-reader');
const executions = new WeakSet<Function>();

export function markResultReader<T extends object>(tool: T): T {
  Object.defineProperty(tool, READER, { value: true, enumerable: true });
  const execute = (tool as { execute?: unknown }).execute;
  if (typeof execute === 'function') executions.add(execute);
  return tool;
}

export function isResultReader(tool: unknown): boolean {
  if (typeof tool !== 'object' || tool === null) return false;
  const candidate = tool as { [READER]?: boolean; execute?: unknown };
  return candidate[READER] === true
    || (typeof candidate.execute === 'function' && executions.has(candidate.execute));
}

export function unsupportedPrivateResultRead() {
  return {
    success: false,
    error: { code: 'privacy_result_handles_unsupported', message: 'Stored result retrieval is unavailable while privacy protection is active.' },
  };
}
