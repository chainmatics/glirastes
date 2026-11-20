let parentURL;

export function initialize(data) {
  parentURL = data.parentURL;
}

export function resolve(specifier, context, next) {
  if (specifier === 'pg' || specifier.startsWith('pg/')) return next(specifier, { ...context, parentURL });
  return next(specifier, context);
}
