import { randomUUID } from 'node:crypto';

export interface SessionUser {
  subjectId: string;
  tenantId: string;
  roles: string[];
  attributes: Record<string, unknown>;
}

// Reference session store. Never use it in place of the app's own auth.
const sessions = new Map<string, SessionUser>();

export function createSession(user: SessionUser): string {
  const token = randomUUID();
  sessions.set(token, structuredClone(user));
  return token;
}

export function revokeSession(token: string): void {
  sessions.delete(token);
}

/** The session of a request: the `session` cookie of the browser, or a bearer token. */
export function sessionFor(headers: { cookie?: string | null; authorization?: string | null }): SessionUser | undefined {
  const bearer = headers.authorization?.match(/^Bearer\s+(\S+)$/i)?.[1];
  const cookie = headers.cookie?.match(/(?:^|;\s*)session=([^;]+)/)?.[1];
  const user = sessions.get(bearer ?? cookie ?? '');
  return user && structuredClone(user);
}

/** The same session for the Web Request the chat handler receives. */
export function resolveSession(request: Request): SessionUser | undefined {
  return sessionFor({ cookie: request.headers.get('cookie'), authorization: request.headers.get('authorization') });
}
