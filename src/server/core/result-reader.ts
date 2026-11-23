// Enumerable provenance survives normal tool copies; execute identity also
// survives adapters which retain only the function. It carries no user data.
const READER = Symbol.for('glirastes.result-reader');


export function markResultReader<T extends object>(tool: T): T {
  Object.defineProperty(tool, READER, { value: true, enumerable: true });
  const execute = (tool as { execute?: unknown }).execute;
  if (typeof execute === 'function') Object.defineProperty(execute, READER, { value: true });
  return tool;
}

export function isResultReader(tool: unknown): boolean {
  if (typeof tool !== 'object' || tool === null) return false;
  const candidate = tool as { [READER]?: boolean; execute?: unknown };
  return candidate[READER] === true
    || (typeof candidate.execute === 'function' && (candidate.execute as unknown as { [READER]?: boolean })[READER] === true);
}

export function unsupportedPrivateResultRead() {
  return {
    success: false,
    error: { code: 'privacy_result_handles_unsupported', message: 'Stored result retrieval is unavailable while privacy protection is active.' },
  };
}
