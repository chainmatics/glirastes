import { existsSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

interface ScaffoldTestOptions {
  rootDir: string;
  outputPath?: string;
  force?: boolean;
  dryRun?: boolean;
}

const TEST_TEMPLATE = `import { createAiTestSuite } from 'glirastes/server/testing';
import { defineModule } from 'glirastes/server';
// Import your module definitions:
// import { modules } from '@/lib/ai/module-definitions';
// Import your tool registries (optional, for approval tests):
// import { endpointToolRegistry } from '@/generated/ai-tools/endpoint.generated';
// import { uiToolRegistry } from '@/generated/ai-tools/ui.generated';

// TODO: Replace with your actual module definitions
const modules = [
  defineModule({
    id: 'task_query',
    name: 'Task Query',
    description: 'Show, search, filter tasks',
    tools: ['list_tasks', 'get_task_details'],
    classification: { hint: 'Show tasks', examples: ['show my tasks'] },
  }),
  defineModule({
    id: 'task_mutation',
    name: 'Task Mutation',
    description: 'Create, update, delete tasks',
    tools: ['create_task', 'update_task', 'delete_task'],
    classification: { hint: 'Create/update tasks', examples: ['create a task'] },
  }),
];

const suite = createAiTestSuite({
  modules,
  // tools: { ...endpointToolRegistry, ...uiToolRegistry },
  pipeline: {
    guardrails: { enableInjectionDetection: true, maxInputLength: 4000 },
    confidenceThresholds: { high: 0.85, medium: 0.65 },
  },
});

// Smoke tests: module completeness, tool naming, no duplicates
suite.smokeTest();

// Guardrails: injection detection, length limits, sanitization
suite.guardrailsTest();

// Approval flags: mutations need approval, queries don't
// suite.approvalTest(); // Uncomment when tool registry is imported

// Routing: deterministic pipeline simulation (add your own scenarios)
suite.routingTest([
  { input: 'show my tasks', expectModule: 'task_query', expectTools: ['list_tasks'] },
  { input: 'create a task', expectModule: 'task_mutation', expectTools: ['create_task'] },
]);
`;

export async function scaffoldTestFile(options: ScaffoldTestOptions): Promise<void> {
  const { rootDir, force, dryRun } = options;

  // Default output path: src/__tests__/ai-behavior.test.ts
  const outputFile = options.outputPath
    ? resolve(rootDir, options.outputPath)
    : join(rootDir, 'src', '__tests__', 'ai-behavior.test.ts');

  if (dryRun) {
    console.log(TEST_TEMPLATE);
    return;
  }

  if (existsSync(outputFile) && !force) {
    console.log(
      `File already exists: ${outputFile}\n` +
        `Use --force to overwrite, or --dry-run to preview.`,
    );
    return;
  }

  // Ensure directory exists
  const dir = outputFile.substring(0, outputFile.lastIndexOf('/'));
  const { mkdirSync } = await import('node:fs');
  mkdirSync(dir, { recursive: true });

  writeFileSync(outputFile, TEST_TEMPLATE, 'utf-8');
  console.log(`✓ Scaffolded AI behavior test at ${outputFile}`);
  console.log(`  Edit the file to import your actual module definitions and tool registries.`);
}
