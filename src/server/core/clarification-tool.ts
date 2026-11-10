import { z } from 'zod';
import { defineTool, type Tool } from '../../types.js';
import {
  CLARIFICATION_MAX_DESCRIPTION_LENGTH,
  CLARIFICATION_MAX_LABEL_LENGTH,
  CLARIFICATION_MAX_OPTIONS,
  CLARIFICATION_MAX_QUESTION_LENGTH,
  CLARIFICATION_OPTION_ID_PATTERN,
  CLARIFICATION_TARGETS,
  CLARIFICATION_TOOL_NAME,
  type ClarificationRequest,
} from '../../contracts/clarification.js';

export interface ClarificationConfig {
  /** Default true when the object is provided. */
  enabled?: boolean;
  /** Replaces the model-facing description, e.g. for a German-only prompt. */
  description?: string;
}

const DEFAULT_DESCRIPTION = [
  'Ask the user exactly one targeted question when the request lacks a required',
  'target person, object, time or scope that cannot be derived from the',
  `conversation, mentions or app context. Offer up to ${CLARIFICATION_MAX_OPTIONS} concrete options when`,
  'you know them. Never ask when the intent is clear: act instead. After calling',
  'this tool, end your turn and wait for the answer.',
].join(' ');

const OptionSchema = z.object({
  id: z.string().regex(CLARIFICATION_OPTION_ID_PATTERN),
  label: z.string().trim().min(1).max(CLARIFICATION_MAX_LABEL_LENGTH),
  description: z.string().trim().min(1).max(CLARIFICATION_MAX_DESCRIPTION_LENGTH).optional(),
});

export const ClarificationInputSchema = z.object({
  question: z.string().trim().min(1).max(CLARIFICATION_MAX_QUESTION_LENGTH),
  target: z.enum(CLARIFICATION_TARGETS),
  options: z.array(OptionSchema).max(CLARIFICATION_MAX_OPTIONS).optional(),
  allowFreeText: z.boolean().optional(),
}).superRefine((input, context) => {
  const ids = (input.options ?? []).map((option) => option.id);
  if (new Set(ids).size !== ids.length) {
    context.addIssue({ code: 'custom', message: 'Option ids must be unique', path: ['options'] });
  }
  if (ids.length === 0 && input.allowFreeText === false) {
    context.addIssue({
      code: 'custom',
      message: 'Provide options or allow a free-text answer',
      path: ['allowFreeText'],
    });
  }
});

/**
 * Built-in, side-effect-free clarification tool. It never calls the app; the
 * chat UI renders the request and resumes the original task with the answer.
 */
export function createClarificationTool(config?: ClarificationConfig): Tool | null {
  if (config?.enabled === false) return null;
  return defineTool({
    id: CLARIFICATION_TOOL_NAME,
    description: config?.description ?? DEFAULT_DESCRIPTION,
    inputSchema: ClarificationInputSchema,
    needsApproval: false,
    execute: async (input) => {
      const clarification: ClarificationRequest = {
        question: input.question,
        target: input.target,
        options: input.options ?? [],
        allowFreeText: input.allowFreeText ?? true,
      };
      return {
        success: true,
        clarification,
        _instruction:
          'The question is shown to the user. End this turn now and wait for the answer.',
      };
    },
  });
}
