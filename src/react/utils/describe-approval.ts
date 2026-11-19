import type { EntityDeclarationsByTool } from '../../contracts/entity-declaration.js';
import type { ApprovalDescriptionFn, PendingApproval } from '../types.js';
import { resolveApprovalSubjects } from './approval-subjects.js';
import { collectEntitySightings, collectSeenEntityIds, isUuidLike, userTextsOf } from './entity-names.js';

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
  const described = describe(toolName, approvalId, input, { names });
  const subjects = withSubjects ? resolved : [];
  return subjects.length > 0 ? { ...described, subjects } : described;
}
