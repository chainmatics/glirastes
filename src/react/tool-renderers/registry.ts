import type { ComponentType } from 'react';
import type { SchemaLike } from '../../types.js';

export interface ToolResultRendererProps<TOutput = unknown> {
  definitionId: string;
  /** Model-facing tool name as stored in the message. */
  toolName: string;
  schemaVersion: number;
  output: TOutput;
}

/**
 * A local, compact result component for one tool. `outputSchema` guards the
 * stored output: messages written by an older tool version fall back to an
 * older renderer version or the default block instead of crashing.
 */
export interface ToolResultRenderer<TOutput = unknown> {
  definitionId: string;
  schemaVersion: number;
  outputSchema: SchemaLike<TOutput>;
  component: ComponentType<ToolResultRendererProps<TOutput>>;
}

// Renderers are invariant in their output type; the registry erases it.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyToolResultRenderer = ToolResultRenderer<any>;

export interface ResolvedToolResultRenderer {
  renderer: AnyToolResultRenderer;
  output: unknown;
}

export interface ToolResultRendererRegistry {
  readonly size: number;
  resolve(toolName: string, output: unknown): ResolvedToolResultRenderer | undefined;
}

const DEFINITION_ID = /^[A-Za-z0-9_.-]{1,200}$/;

export function defineToolResultRenderer<TOutput>(
  renderer: ToolResultRenderer<TOutput>,
): ToolResultRenderer<TOutput> {
  return renderer;
}

function modelFacingName(definitionId: string): string {
  return definitionId.replace(/\./g, '_');
}

export function createToolResultRendererRegistry(
  renderers: ReadonlyArray<AnyToolResultRenderer>,
): ToolResultRendererRegistry {
  const byName = new Map<string, AnyToolResultRenderer[]>();
  const seen = new Set<string>();
  for (const renderer of renderers) {
    if (!DEFINITION_ID.test(renderer.definitionId)) {
      throw new Error(`Invalid renderer definitionId: ${renderer.definitionId}`);
    }
    if (!Number.isInteger(renderer.schemaVersion) || renderer.schemaVersion < 1) {
      throw new Error(`Renderer ${renderer.definitionId} needs a positive integer schemaVersion`);
    }
    const identity = `${renderer.definitionId}@${renderer.schemaVersion}`;
    if (seen.has(identity)) throw new Error(`Duplicate renderer: ${identity}`);
    seen.add(identity);
    for (const name of new Set([renderer.definitionId, modelFacingName(renderer.definitionId)])) {
      const list = byName.get(name) ?? [];
      list.push(renderer);
      list.sort((left, right) => right.schemaVersion - left.schemaVersion);
      byName.set(name, list);
    }
  }

  return Object.freeze({
    size: seen.size,
    resolve(toolName: string, output: unknown) {
      for (const renderer of byName.get(toolName) ?? []) {
        let parsed: ReturnType<AnyToolResultRenderer['outputSchema']['safeParse']>;
        try {
          parsed = renderer.outputSchema.safeParse(output);
        } catch {
          continue;
        }
        if (parsed.success) return { renderer, output: parsed.data };
      }
      return undefined;
    },
  });
}
