import type { EntityDeclarationsByTool } from '../../contracts/entity-declaration.js';
import type {
  ApprovalDescriptionFn,
  ApprovalOutcome,
  PendingApproval,
  ToolPartApproval,
} from '../types.js';
import { readActivitySteps } from './activity.js';
import { describeApprovalCall } from './describe-approval.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** What the activity log would call the call, as an approval outcome. */
function outcomeOf(part: Record<string, unknown>, approved: boolean | undefined): ApprovalOutcome {
  switch (part.state) {
    case 'approval-requested':
      return 'open';
    case 'approval-responded':
      return approved === false ? 'declined' : 'running';
    case 'output-denied':
      return approved === true ? 'not-run' : 'declined';
    case 'output-error':
      return 'failed';
    case 'output-available': {
      const status = readActivitySteps([part], () => false)[0]?.status;
      return status === 'error' ? 'failed' : status === 'expected' ? 'expected' : 'done';
    }
    default:
      return approved === false ? 'declined' : 'running';
  }
}

export interface ReadToolPartApprovalOptions {
  toolName: string;
  /** Open approvals of the provider, by approval id. */
  pending: ReadonlyArray<PendingApproval>;
  messages: ReadonlyArray<unknown>;
  declarations?: EntityDeclarationsByTool;
  describe: ApprovalDescriptionFn;
  withSubjects: boolean;
  /** The chat's language, for server preview labels. */
  language?: string;
}

/**
 * The approval of an AI SDK tool part (`approval: { id, approved? }`), open
 * or decided, or undefined for a part that never asked for one. An open one
 * is the provider's pending approval; a decided one is described again from
 * the part's input and the conversation the browser holds now, so it also
 * works after a reload (the names may be newer than on the card).
 */
export function readToolPartApproval(part: unknown, options: ReadToolPartApprovalOptions): ToolPartApproval | undefined {
  if (!isRecord(part) || !isRecord(part.approval) || typeof part.approval.id !== 'string' || !part.approval.id) {
    return undefined;
  }
  const approvalId = part.approval.id;
  const approved = typeof part.approval.approved === 'boolean' ? part.approval.approved : undefined;
  const outcome = outcomeOf(part, approved);
  const toolCallId = typeof part.toolCallId === 'string' ? part.toolCallId : undefined;
  const base = { approvalId, ...(toolCallId ? { toolCallId } : {}), toolName: options.toolName };
  const open = outcome === 'open' ? options.pending.find((approval) => approval.id === approvalId) : undefined;
  const described = open ?? describeApprovalCall({
    toolName: options.toolName,
    approvalId,
    input: part.input,
    messages: options.messages,
    declarations: options.declarations,
    describe: options.describe,
    withSubjects: options.withSubjects,
    // A decided call keeps the server's names after a reload: its subjects part stays in the history.
    ...(toolCallId ? { toolCallId } : {}),
    ...(options.language ? { language: options.language } : {}),
  });
  const card = {
    label: described.description ?? options.toolName,
    ...(described.details && described.details.length > 0 ? { details: described.details } : {}),
    ...(described.subjects && described.subjects.length > 0 ? { subjects: described.subjects } : {}),
  };
  if (outcome === 'open') {
    return { ...base, state: 'open', outcome, ...card, ...(open ? { pending: open } : {}) };
  }
  const decision = approved === undefined ? (outcome === 'declined' ? 'declined' : 'approved') : approved ? 'approved' : 'declined';
  return { ...base, state: 'decided', decision, outcome, ...card };
}
