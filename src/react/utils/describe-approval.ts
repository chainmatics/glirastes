import type { EntityDeclarationsByTool } from '../../contracts/entity-declaration.js';
import type { ApprovalDescriptionFn, PendingApproval } from '../types.js';
import { resolveApprovalSubjects } from './approval-subjects.js';
import { collectEntitySightings, collectSeenEntityIds, isUuidLike, userTextsOf } from './entity-names.js';
import type { ApprovalSubjectsPartData } from '../../contracts/approval-subject.js';
import {
  applyServerApprovalSubjects,
  applyServerSubjectNames,
  findApprovalSubjectsPart,
  mergeServerApprovalSubjects,
} from './server-approval-subjects.js';

export interface DescribeApprovalCallOptions {
  toolName: string;
  approvalId: string;
  input: unknown;
  /** The conversation the browser holds: the names and ids it showed. */
  messages: ReadonlyArray<unknown>;
  declarations?: EntityDeclarationsByTool;
  describe: ApprovalDescriptionFn;
  /** `approvalSubjects` of the provider: attach the resolved ids. */
  withSubjects: boolean;
  /**
   * The call's id: its `data-approval-subjects` part in `messages` (the
   * server's lookup, only with a declaration) then names its records; the
   * history guess stays the fallback.
   */
  toolCallId?: string;
  /** The chat's language, for the preview labels. */
  language?: string;
}

/** The server's subjects of a call, from any message of the conversation. */
function serverPartOf(messages: ReadonlyArray<unknown>, toolCallId: string | undefined): ApprovalSubjectsPartData | undefined {
  if (!toolCallId) return undefined;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const parts = (messages[index] as { parts?: unknown } | undefined)?.parts;
    if (!Array.isArray(parts)) continue;
    const found = findApprovalSubjectsPart(parts, toolCallId);
    if (found) return found;
  }
  return undefined;
}

/**
 * The approval card data of one tool call: the app's (or derived)
 * description with the names this conversation showed for its ids, and the
 * resolved `subjects`. Display only, from the browser's own history (not a
 * trust boundary): the approved arguments stay exactly what the call carries.
 * Nothing is sent anywhere.
 */
export function describeApprovalCall({
  toolName,
  approvalId,
  input,
  messages,
  declarations,
  describe,
  withSubjects,
  toolCallId,
  language,
}: DescribeApprovalCallOptions): PendingApproval {
  const sightings = collectEntitySightings(messages, declarations);
  const inputEntities = declarations && Object.prototype.hasOwnProperty.call(declarations, toolName)
    ? declarations[toolName]!.input
    : undefined;
  const resolved = resolveApprovalSubjects(input, sightings, collectSeenEntityIds(messages, declarations), {
    toolName,
    ...(inputEntities ? { inputEntities, userTexts: userTextsOf(messages), declarations } : {}),
  });
  const names = new Map([...sightings].map(([id, seen]) => [id, seen.name]));
  // An id seen for records of different kinds names the record this call picks, or
  // none (also when the call uses it for two kinds: `nameLabels` look up by id only).
  const picked = new Map<string, string | undefined>();
  for (const subject of resolved) {
    const key = subject.id.toLowerCase();
    if (!sightings.get(key)?.kinds) continue;
    const name = subject.status === 'named' ? subject.name : undefined;
    picked.set(key, picked.has(key) && picked.get(key) !== name ? undefined : name);
  }
  for (const [key, seen] of sightings) {
    // A UUID is one record wherever it occurs: never a collision.
    if (!seen.kinds || isUuidLike(key)) continue;
    const name = picked.get(key);
    if (name) names.set(key, name);
    else names.delete(key);
  }
  // What the server looked up through the tool's declared read source (only with a declaration).
  const serverPart = serverPartOf(messages, toolCallId);
  applyServerSubjectNames(names, serverPart, resolved);
  const described = describe(toolName, approvalId, input, { names });
  return applyServerApprovalSubjects(described, withSubjects
    ? mergeServerApprovalSubjects(resolved, serverPart, language)
    : { subjects: [] });
}
