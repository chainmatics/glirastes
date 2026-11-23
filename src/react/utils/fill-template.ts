/**
 * A label template with its `{placeholder}`s filled in one pass. Values are
 * inserted as they are, through a replacer function: `$&`, `$1` or `$$` in a
 * name are never replacement patterns, and a value that itself contains
 * `{id}` is never filled again. An unknown placeholder stays as written.
 */
export function fillTemplate(template: string, values: Readonly<Record<string, string>>): string {
  return template.replace(/\{([A-Za-z]\w*)\}/g, (whole, key: string) => (
    Object.prototype.hasOwnProperty.call(values, key) ? values[key]! : whole
  ));
}
