import { randomUUID } from 'node:crypto';

// Test fixture only. Shared between Next route bundles in this single process.
// Production apps must keep their actual session resolver instead.
const key = Symbol.for('glirastes.native-browser-reference.sessions');
const sessions = globalThis[key] ??= new Map();
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
