import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateFromOpenApiFile } from './index.js';

const currentFile = fileURLToPath(import.meta.url);
const currentDir = path.dirname(currentFile);
const repoRoot = path.resolve(currentDir, '../../../');

const inputPath = path.join(repoRoot, 'examples/openapi.todo.json');
const outputPath = path.join(repoRoot, 'examples/generated/endpoint-tools.generated.ts');

const validation = await generateFromOpenApiFile({ inputPath, outputPath });

for (const warning of validation.warnings) {
  console.warn(warning);
}

console.log(`Generated: ${outputPath}`);
console.log(`Enabled AI tools: ${validation.enabledTools}. Warnings: ${validation.warnings.length}.`);
