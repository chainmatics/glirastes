import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect } from 'vitest';
import {
  runToolsPipeline,
  ToolsPipelineFailure,
  type ToolsPipelineResult,
} from '../../src/codegen/tools/pipeline.js';
import { AppSetupArtifactSchema, type AppSetupArtifact } from '../../src/contracts/index.js';

/** Shared steps of the change corpora: every fixture runs the same sequence. */
export async function artifactOf(root: string): Promise<AppSetupArtifact> {
  return AppSetupArtifactSchema.parse(JSON.parse(await readFile(join(root, '.glirastes/setup-artifact.json'), 'utf8')));
}

export function toolNamed(artifact: AppSetupArtifact, name: string): AppSetupArtifact['tools'][number] {
  const tool = artifact.tools.find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`No tool ${name}`);
  return tool;
}

export async function replaceIn(root: string, file: string, from: string, to: string): Promise<void> {
  const path = join(root, file);
  const text = await readFile(path, 'utf8');
  expect(text).toContain(from);
  await writeFile(path, text.replace(from, to));
}

/** `glirastes tools check`: frozen refresh that must fail with a named drift finding. */
export async function failingCheck(root: string): Promise<ToolsPipelineResult> {
  const outcome = await runToolsPipeline({ root, mode: 'frozen' }).then(() => undefined, (error: unknown) => error);
  expect(outcome).toBeInstanceOf(ToolsPipelineFailure);
  const { result } = outcome as ToolsPipelineFailure;
  expect(result.wrote).toBe(false);
  expect(result.findings).toEqual(expect.arrayContaining([
    expect.objectContaining({ code: 'tool-outputs-drift', subjectRef: '.glirastes/foundation-execution-inventory.json' }),
  ]));
  return result;
}

export async function passingCheck(root: string): Promise<void> {
  expect((await runToolsPipeline({ root, mode: 'frozen' })).driftPaths).toEqual([]);
}

export async function tombstonesOf(root: string): Promise<unknown[]> {
  return (JSON.parse(await readFile(join(root, '.glirastes/tool-tombstones.json'), 'utf8')) as { tombstones: unknown[] }).tombstones;
}

export function hrefOf(result: unknown): unknown {
  return (result as { uiAction?: { payload?: { href?: unknown } } }).uiAction?.payload?.href;
}

export const byToolId = (left: { toolId: string }, right: { toolId: string }) => (left.toolId < right.toolId ? -1 : 1);
