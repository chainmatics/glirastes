import { gateway } from 'ai';

/** Preserve the AI SDK resolver, then recheck each provider attempt, including retries. */
export function guardModelDispatch<M>(model: M, beforeDispatch: () => void | Promise<void>): M {
  // This is the same string resolution used by the pinned AI SDK. It also
  // honors a consumer's global provider; credentials remain in that provider.
  const target = typeof model === 'string'
    ? (globalThis.AI_SDK_DEFAULT_PROVIDER ?? gateway).languageModel(model)
    : model;
  if (typeof target !== 'object' || target === null) return model;
  return new Proxy(target, {
    get(object, property) {
      const value = Reflect.get(object, property, object);
      if ((property === 'doGenerate' || property === 'doStream') && typeof value === 'function') {
        return async (...args: unknown[]) => { await beforeDispatch(); return value.apply(object, args); };
      }
      return value;
    },
  }) as M;
}
