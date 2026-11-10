import { describe, expect, it } from 'vitest';
import { generateIntentModules } from './module-generator.js';

describe('generateIntentModules escaping', () => {
  it('emits hint, examples and system prompt as safe string literals', () => {
    const meta = new Map([['tasks', {
      hint: "C:\\path\\ it's",
      examples: ["ends with \\", "it's"],
      systemPrompt: 'Use `code` and ${process.exit(1)}',
    }]]);
    const out = generateIntentModules(['tasks'], meta, new Map([['tasks', new Set(['tasks.list'])]]));
    expect(out).toContain(`hint: ${JSON.stringify("C:\\path\\ it's")}`);
    expect(out).toContain(`examples: [${JSON.stringify('ends with \\')}, ${JSON.stringify("it's")}]`);
    expect(out).toContain(`systemPrompt: ${JSON.stringify('Use `code` and ${process.exit(1)}')}`);
  });
});
