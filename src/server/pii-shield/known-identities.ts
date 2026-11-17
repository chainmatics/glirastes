/**
 * Identities the application already knows from the authenticated context
 * (the signed-in user) and from resources its tools returned to this
 * principal. They are protected deterministically: exact ids, the full name,
 * its "Last, First" form, the e-mail address and the single name parts.
 *
 * Only register identities the principal is authorized to see. Loading other
 * tenants' or unrelated contacts just for detection is not allowed. A
 * pseudonym is never an authority for a write: tool inputs are rehydrated
 * only within the same scope, and the backend authorizes the final values.
 */
export interface KnownIdentity {
  /** Stable id (user id, contact id). Matched exactly, also as a JSON number. */
  id?: string | number;
  /** Display name. */
  name?: string;
  email?: string;
  /** Further spellings, e.g. a login name. Matched like a full name. */
  aliases?: string[];
  kind?: string;
}

export interface NamePlan {
  parts: Array<{ token: string; role: 'first' | 'last' }>;
  full: string;
}

const MIN_PART = 3;

export function normalizeName(value: string): string {
  return value.normalize('NFKC').replace(/[\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * Splits a display name into protected parts; the last token is the family
 * name. A "Last, First" display name is read as "First Last", and `full`
 * holds only cleaned tokens, so every token of `full` is either a part or a
 * short token (below three letters) that the shield replaces on its own.
 */
export function planName(name: string): NamePlan | null {
  let normalized = normalizeName(name);
  const commas = normalized.split(',');
  if (commas.length === 2 && commas[0]!.trim() && commas[1]!.trim()) {
    normalized = `${commas[1]!.trim()} ${commas[0]!.trim()}`;
  }
  const tokens = normalized.split(' ').map((token) => token.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '')).filter(Boolean);
  const full = tokens.join(' ');
  if (full.length < 2 || tokens.length === 0) return null;
  const parts: NamePlan['parts'] = [];
  tokens.forEach((token, index) => {
    if (token.length < MIN_PART) return;
    parts.push({ token, role: tokens.length > 1 && index === tokens.length - 1 ? 'last' : 'first' });
  });
  return { parts, full };
}

/** Variants of a full name: "First Last" and "Last, First". */
export function nameVariants(full: string): string[] {
  const tokens = full.split(' ');
  if (tokens.length < 2) return [full];
  const last = tokens[tokens.length - 1]!;
  const rest = tokens.slice(0, -1).join(' ');
  return [full, `${last}, ${rest}`];
}

/**
 * The id as registered for protection. Purely numeric ids shorter than six
 * digits are not registered: they cannot be told apart from quantities,
 * page numbers or amounts, and replacing those would corrupt tool input.
 */
export function identityIdString(id: string | number | undefined): string | undefined {
  if (id === undefined || id === null) return undefined;
  const value = String(id).normalize('NFKC').trim();
  if (/^\d+$/.test(value)) return value.length >= 6 ? value : undefined;
  return value.length >= 2 ? value : undefined;
}

const PERSON_NAME_KEYS = ['displayName', 'display_name', 'fullName', 'full_name', 'userName', 'name'];
const FIRST_NAME_KEYS = ['firstName', 'first_name', 'firstname', 'givenName', 'given_name', 'vorname'];
const LAST_NAME_KEYS = ['lastName', 'last_name', 'lastname', 'familyName', 'family_name', 'surname', 'nachname'];
const PERSON_ID_KEYS = ['userId', 'user_id', 'memberId', 'member_id', 'contactId', 'contact_id', 'personId', 'person_id', 'employeeId', 'employee_id'];
const EMAIL_KEYS = ['email', 'mail', 'emailAddress', 'email_address', 'userPrincipalName'];
/** Keys of an object or list that hold people: `{ id, name }` below them is a person. */
const PERSON_CONTAINER_KEYS = new Set([
  'user', 'users', 'member', 'members', 'contact', 'contacts', 'person', 'people', 'persons', 'employee', 'employees',
  'assignee', 'assignees', 'owner', 'owners', 'creator', 'author', 'authors', 'participant', 'participants',
  'attendee', 'attendees', 'customer_contact', 'colleague', 'colleagues', 'recipient', 'recipients', 'sender',
  'reporter', 'reviewer', 'reviewers', 'approver', 'approvers', 'manager', 'teammates',
]);
/** `kind`/`type` values that mark an object as a person. */
const PERSON_KINDS = new Set(['user', 'person', 'contact', 'member', 'employee', 'people', 'colleague']);
/** Name/id pairs that describe a related person inside another object. */
const RELATED_PAIRS: Array<[string, string]> = [
  ['assigneeName', 'assigneeId'],
  ['ownerName', 'ownerId'],
  ['creatorName', 'createdById'],
  ['createdByName', 'createdById'],
  ['authorName', 'authorId'],
  ['reporterName', 'reporterId'],
  ['contactName', 'contactId'],
  ['userName', 'userId'],
];

export interface IdentityExtraction {
  identities: KnownIdentity[];
  /**
   * False when the walk stopped at its limit (count, depth) before seeing
   * the whole value: the caller must not treat the result as complete.
   */
  complete: boolean;
}

function containerKey(key: string | undefined): boolean {
  if (!key) return false;
  const k = key.replace(/([a-z])([A-Z])/g, '$1_$2').toLowerCase();
  return PERSON_CONTAINER_KEYS.has(k) || PERSON_CONTAINER_KEYS.has(k.split('_').at(-1) ?? '');
}

/**
 * Collects people from a tool result. An object is a person when it has an
 * e-mail field, first and last name fields, a name next to a person id
 * field, or a name and id with a person signal: a `kind`/`type` such as
 * `user`, or a parent key such as `members` or `assignee`. A plain
 * `{ id, name }` (a project, product or appointment) is not a person; use
 * an explicit `identitiesFromToolResults` adapter where the shape alone is
 * ambiguous. Free `title` or `description` fields stay free text.
 */
export function extractIdentities(value: unknown, limit = 500, maxDepth = 12): IdentityExtraction {
  const found: KnownIdentity[] = [];
  const seen = new Set<unknown>();
  let complete = true;
  const visit = (node: unknown, depth: number, parentKey: string | undefined) => {
    if (node === null || typeof node !== 'object' || seen.has(node)) return;
    if (found.length >= limit || depth > maxDepth) {
      complete = false;
      return;
    }
    seen.add(node);
    if (Array.isArray(node)) {
      for (const item of node) visit(item, depth + 1, parentKey);
      return;
    }
    const record = node as Record<string, unknown>;
    const str = (key: string) => (typeof record[key] === 'string' && (record[key] as string).trim().length > 1 ? record[key] as string : undefined);
    const idOf = (key: string) => (typeof record[key] === 'string' || typeof record[key] === 'number' ? record[key] as string | number : undefined);
    const email = EMAIL_KEYS.map(str).find((v) => v?.includes('@'));
    const first = FIRST_NAME_KEYS.map(str).find(Boolean);
    const last = LAST_NAME_KEYS.map(str).find(Boolean);
    const composed = first && last ? `${first.trim()} ${last.trim()}` : undefined;
    const personName = PERSON_NAME_KEYS.map(str).find(Boolean) ?? composed ?? first ?? last;
    const personId = PERSON_ID_KEYS.map(idOf).find((v) => v !== undefined);
    const kind = [record.kind, record.type, record.entityType].find((v) => typeof v === 'string') as string | undefined;
    const personSignal = Boolean(email) || Boolean(first && last) || personId !== undefined
      || (kind !== undefined && PERSON_KINDS.has(kind.toLowerCase())) || containerKey(parentKey);
    if ((personName && personSignal) || email) {
      const id = personId ?? idOf('id');
      const push = (identity: KnownIdentity) => {
        if (found.length < limit) found.push(identity);
        else complete = false;
      };
      push({
        ...(email ? { email } : {}),
        ...(personName ? { name: personName } : {}),
        ...(id !== undefined ? { id } : {}),
      });
      // "First Last" from parts and a display name can differ: protect both.
      if (composed && personName !== composed) push({ name: composed });
    }
    for (const [nameKey, idKey] of RELATED_PAIRS) {
      const name = str(nameKey);
      const id = idOf(idKey);
      if (name) {
        if (found.length < limit) found.push({ name, ...(id !== undefined ? { id } : {}) });
        else complete = false;
      }
    }
    for (const [key, child] of Object.entries(record)) visit(child, depth + 1, key);
  };
  visit(value, 0, undefined);
  return { identities: found, complete };
}

/** {@link extractIdentities} without the completeness flag (kept for callers that only need the list). */
export function extractIdentitiesFromJson(value: unknown, limit = 500): KnownIdentity[] {
  return extractIdentities(value, limit).identities;
}
