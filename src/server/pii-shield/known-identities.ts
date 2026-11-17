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

/** Splits a display name into protected parts; the last token is the family name. */
export function planName(name: string): NamePlan | null {
  const full = normalizeName(name);
  if (full.length < 2) return null;
  const tokens = full.split(' ').map((token) => token.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '')).filter(Boolean);
  if (tokens.length === 0) return null;
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
const PERSON_ID_KEYS = ['userId', 'user_id', 'memberId', 'contactId', 'personId'];
const EMAIL_KEYS = ['email', 'mail', 'emailAddress', 'userPrincipalName'];
/** Name/id pairs that describe a related person inside another object. */
const RELATED_PAIRS: Array<[string, string]> = [
  ['assigneeName', 'assigneeId'],
  ['ownerName', 'ownerId'],
  ['creatorName', 'createdById'],
  ['createdByName', 'createdById'],
];

/**
 * Collects person-like objects from a tool result: an object with an e-mail
 * field, or with a name field next to a person id field. Free `title` or
 * `description` fields stay free text and are never treated as names.
 */
export function extractIdentitiesFromJson(value: unknown, limit = 500): KnownIdentity[] {
  const found: KnownIdentity[] = [];
  const seen = new Set<unknown>();
  const visit = (node: unknown, depth: number) => {
    if (found.length >= limit || depth > 12 || node === null || typeof node !== 'object' || seen.has(node)) return;
    seen.add(node);
    if (Array.isArray(node)) {
      for (const item of node) visit(item, depth + 1);
      return;
    }
    const record = node as Record<string, unknown>;
    const str = (key: string) => (typeof record[key] === 'string' && (record[key] as string).trim().length > 1 ? record[key] as string : undefined);
    const idOf = (key: string) => (typeof record[key] === 'string' || typeof record[key] === 'number' ? record[key] as string | number : undefined);
    const email = EMAIL_KEYS.map(str).find((v) => v?.includes('@'));
    const personName = PERSON_NAME_KEYS.map(str).find(Boolean);
    const personId = PERSON_ID_KEYS.map(idOf).find((v) => v !== undefined);
    if (email || (personName && personId !== undefined)) {
      const id = personId ?? (email ? idOf('id') : undefined);
      found.push({
        ...(email ? { email } : {}),
        ...(personName ? { name: personName } : {}),
        ...(id !== undefined ? { id } : {}),
      });
    }
    for (const [nameKey, idKey] of RELATED_PAIRS) {
      const name = str(nameKey);
      const id = idOf(idKey);
      if (name) found.push({ name, ...(id !== undefined ? { id } : {}) });
    }
    for (const child of Object.values(record)) visit(child, depth + 1);
  };
  visit(value, 0);
  return found;
}
