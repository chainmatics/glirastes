import { gateway } from 'ai';

/** Preserve the AI SDK resolver, then recheck each provider attempt, including retries. */
export function guardModelDispatch<M>(model: M, beforeDispatch: () => void | Promise<void>): M {
  // This is the same string resolution used by the pinned AI SDK. It also
  // honors a consumer's global provider; credentials remain in that provider.
  const target = typeof model === 'string'
    ? (globalThis.AI_SDK_DEFAULT_PROVIDER ?? gateway).languageModel(model)
    : model;
  if ((typeof target !== 'object' && typeof target !== 'function') || target === null) return model;
  // A fresh forwarding target also supports frozen and callable descriptors.
  // Proxying the original frozen object would violate immutable-method invariants.
  const wrapped = new Proxy(Object.create(null) as object, {
    get(_object, property) {
      const value = Reflect.get(target, property, target);
      if ((property === 'doGenerate' || property === 'doStream') && typeof value === 'function') {
        return async (...args: unknown[]) => { await beforeDispatch(); return value.apply(target, args); };
      }
      return value;
    },
    has: (_object, property) => Reflect.has(target, property),
    ownKeys: () => Reflect.ownKeys(target),
    getOwnPropertyDescriptor: (_object, property) => {
      const descriptor = Reflect.getOwnPropertyDescriptor(target, property);
      return descriptor ? {configurable: true, enumerable: descriptor.enumerable, get: () => Reflect.get(wrapped, property)} : undefined;
    },
    getPrototypeOf: () => Reflect.getPrototypeOf(target),
  });
  return wrapped as M;
}
