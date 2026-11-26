/**
 * What the model sees of a tool's result, when it differs from what the
 * browser gets (internal). A tool registered here keeps its full result in
 * the tool part (the UI stream, the persisted message); `toolToAiTool` puts
 * the mapping on the converted tool as `_modelOutput`, and the AI SDK engine
 * hands it to the AI SDK as `toModelOutput`, so the model of this turn only
 * gets the mapped value. Later turns need their own model-input transform:
 * the history the client sends back carries the full result.
 */
import type { Tool } from '../../types.js';

/** Maps a tool's result (as the tool part holds it) to the JSON value the model gets. */
export type ToolModelOutput = (output: unknown) => unknown;

const MODEL_OUTPUTS = new WeakMap<object, ToolModelOutput>();

/** Registers the model-facing form of `tool`'s results; returns `tool`. */
export function withToolModelOutput<T extends Tool>(tool: T, modelOutput: ToolModelOutput): T {
  MODEL_OUTPUTS.set(tool, modelOutput);
  return tool;
}

/** The model-facing form registered for `tool`, if any. */
export function toolModelOutputOf(tool: unknown): ToolModelOutput | undefined {
  return typeof tool === 'object' && tool !== null ? MODEL_OUTPUTS.get(tool) : undefined;
}
