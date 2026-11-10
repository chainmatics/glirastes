import { randomUUID } from 'node:crypto';

// Test-only server-side session store. Never use this in place of app auth.
const sessions = new Map();
export function createSession(principal) {
  const token = randomUUID();
  sessions.set(token, structuredClone(principal));
  return token;
}
export function resolveSession(request) {
  const token = request.headers.get('cookie')?.match(/(?:^|;\s*)session=([^;]+)/)?.[1];
  const principal = sessions.get(token);
  return principal && structuredClone(principal);
}
export function revokeSession(token) { sessions.delete(token); }
