import { z } from 'zod';
import { defineTool, type Tool, type FollowupsConfig, type FollowupLocale } from '../../types.js';

// ============================================================================
// Default Locale (English)
// ============================================================================

const DEFAULT_LOCALE: FollowupLocale = {
  description: 'Suggest contextual follow-up actions after completing a task.',
  suggestionHint:
    'Formulate suggestions as the user would type them. ' +
    'Use concrete names/titles from the context instead of generic placeholders.',
  examples: {
    good: [
      'Set deadline for "Prepare meeting"',
      'Create subtasks for "Prepare meeting"',
      'Show only high priority tasks',
    ],
    bad: [
      'Perform another action',
      'Show help',
    ],
  },
};

// ============================================================================
// Default Followup Config
// ============================================================================

const DEFAULT_COUNT = 3;

// ============================================================================
// Factory
// ============================================================================

/**
 * Create a followup suggestion tool definition.
 *
 * This tool allows the LLM to suggest contextual follow-up actions
 * at the end of a conversation turn. The frontend renders these as
 * clickable suggestion chips.
 */
export function createFollowupTool(config?: FollowupsConfig): Tool | null {
  const enabled = config?.enabled ?? true;
  if (!enabled) return null;

  const count = Math.max(1, Math.min(5, config?.count ?? DEFAULT_COUNT));
  const locale = config?.locale ?? DEFAULT_LOCALE;

  const goodExamples = locale.examples?.good
    ? locale.examples.good.map((e) => `- "${e}"`).join('\n')
    : '';
  const badExamples = locale.examples?.bad
    ? locale.examples.bad.map((e) => `- "${e}"`).join('\n')
    : '';

  const description = `${locale.description}

${locale.suggestionHint}

${goodExamples ? `Good examples:\n${goodExamples}\n` : ''}
${badExamples ? `Avoid:\n${badExamples}\n` : ''}
Generate exactly ${count} suggestions.

IMPORTANT: After calling this tool, do NOT include the suggestions in your text response. The UI renders them automatically as clickable chips. Your text response should only confirm the completed action — never list or repeat the suggestions.`;

  const inputSchema = z.object({
    suggestions: z
      .array(z.string().min(1).max(200))
      .min(1)
      .max(5)
      .describe(locale.suggestionHint),
  });

  return defineTool({
    id: 'suggest_followups',
    description,
    inputSchema,
    needsApproval: false,
    execute: async (input: z.infer<typeof inputSchema>) => {
      const limitedSuggestions = input.suggestions.slice(0, count);
      return {
        success: true,
        followups: limitedSuggestions,
        _instruction:
          'Suggestions registered and will be shown as clickable chips in the UI. ' +
          'Do NOT repeat or list them in your text response.',
      };
    },
  });
}
