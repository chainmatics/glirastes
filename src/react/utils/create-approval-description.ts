import type { PendingApproval, ApprovalDescriptionFn } from '../types.js';

// ============================================================================
// Types
// ============================================================================

export interface ApprovalDescriptionConfig {
  /** Map field names to human-readable labels. Example: `{ dueDate: 'Due date' }` */
  fieldLabels?: Record<string, string>;

  /**
   * Map of field+value to translated display value.
   * Outer key = field name, inner key = raw value.
   *
   * @example
   * ```ts
   * { priority: { high: 'High', low: 'Low' }, status: { done: 'Done' } }
   * ```
   */
  valueTranslations?: Record<string, Record<string, string>>;

  /** Field names to always hide (e.g. internal IDs). UUIDs are hidden automatically. */
  hiddenFields?: string[] | Set<string>;

  /** Map tool names to human-readable action labels */
  toolLabels?: Record<string, string>;

  /** Locale for date formatting (default: `'en-US'`) */
  dateLocale?: string;

  /** Default confirm button text */
  defaultConfirmText?: string;

  /** Default description for unknown tools */
  defaultDescription?: string;
}

// ============================================================================
// Helpers
// ============================================================================

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_DATE_REGEX = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}:\d{2}(\.\d{3})?(Z|[+-]\d{2}:\d{2})?)?$/;

function capitalize(str: string): string {
  return str ? str.charAt(0).toUpperCase() + str.slice(1) : str;
}

function formatDateValue(strValue: string, locale: string): string {
  try {
    const date = new Date(strValue);
    if (isNaN(date.getTime())) return strValue;
    // Date-only (YYYY-MM-DD)
    if (strValue.length === 10) {
      return date.toLocaleDateString(locale, { day: '2-digit', month: '2-digit', year: 'numeric' });
    }
    return date.toLocaleString(locale, {
      day: '2-digit', month: '2-digit', year: 'numeric',
      hour: '2-digit', minute: '2-digit',
    });
  } catch {
    return strValue;
  }
}

// ============================================================================
// Factory
// ============================================================================

/**
 * Create an approval description generator that formats tool arguments
 * into human-readable detail lines for approval cards.
 *
 * Features:
 * - Auto-hides UUID values and configurable field names
 * - Auto-formats ISO dates using the configured locale
 * - Translates field values via configurable mappings
 * - Flattens nested objects into detail lines
 * - Filters empty arrays and null/undefined values
 *
 * @example
 * ```ts
 * import { createApprovalDescriptionGenerator } from '../index.js';
 *
 * const getApprovalDescription = createApprovalDescriptionGenerator({
 *   fieldLabels: { title: 'Title', dueDate: 'Due date', priority: 'Priority' },
 *   valueTranslations: { priority: { high: 'High', medium: 'Medium', low: 'Low' } },
 *   hiddenFields: ['taskId', 'assigneeId', 'groupId'],
 *   toolLabels: { create_task: 'Create task', update_task: 'Update task' },
 *   dateLocale: 'de-DE',
 *   defaultConfirmText: 'Execute',
 * });
 *
 * <AiChatProvider approvalDescription={getApprovalDescription} ... />
 * ```
 */
export function createApprovalDescriptionGenerator(
  config: ApprovalDescriptionConfig = {},
): ApprovalDescriptionFn {
  const {
    fieldLabels = {},
    valueTranslations = {},
    hiddenFields: rawHiddenFields,
    toolLabels = {},
    dateLocale = 'en-US',
    defaultConfirmText,
    defaultDescription = 'Confirm action?',
  } = config;

  const hiddenFields = rawHiddenFields instanceof Set
    ? rawHiddenFields
    : new Set(rawHiddenFields ?? []);

  function formatValue(key: string, value: unknown): string {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      return Object.entries(value as Record<string, unknown>)
        .filter(([, v]) => v !== undefined && v !== null && v !== '')
        .map(([k, v]) => `${fieldLabels[k] || k}: ${formatValue(k, v)}`)
        .join(', ');
    }
    const strValue = String(value);
    if (valueTranslations[key]?.[strValue]) return valueTranslations[key][strValue];
    if (ISO_DATE_REGEX.test(strValue)) return formatDateValue(strValue, dateLocale);
    return capitalize(strValue);
  }

  function collectDetails(obj: Record<string, unknown>): string[] {
    const result: string[] = [];
    for (const [key, value] of Object.entries(obj)) {
      if (value === undefined || value === null || value === '') continue;
      if (hiddenFields.has(key)) continue;
      if (UUID_REGEX.test(String(value))) continue;

      if (value && typeof value === 'object' && !Array.isArray(value)) {
        result.push(...collectDetails(value as Record<string, unknown>));
        continue;
      }

      const label = fieldLabels[key] || key;
      let displayValue: string;
      if (Array.isArray(value)) {
        const filtered = value.filter((v) => !UUID_REGEX.test(String(v)));
        if (filtered.length === 0) continue;
        displayValue = filtered.map((v) => formatValue(key, v)).join(', ');
      } else {
        displayValue = formatValue(key, value);
      }
      result.push(`${label}: ${displayValue}`);
    }
    return result;
  }

  return (
    toolName: string,
    approvalId: string,
    args: unknown,
  ): PendingApproval => {
    const details: string[] = [];
    if (args && typeof args === 'object') {
      details.push(...collectDetails(args as Record<string, unknown>));
    }

    return {
      id: approvalId,
      toolName,
      args: (args && typeof args === 'object' ? args : {}) as Record<string, unknown>,
      messageId: '',
      description: toolLabels[toolName] || defaultDescription,
      details,
      ...(defaultConfirmText ? { confirmText: defaultConfirmText } : {}),
    };
  };
}
