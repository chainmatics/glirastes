import { createSession } from '../../auth.js';

// Explicit test-only bootstrap. Not discovered as an app capability.
export async function POST(request) {
  const expected = process.env.GLIRASTES_REFERENCE_CAPABILITY;
  if (process.env.GLIRASTES_REFERENCE_TEST_MODE !== '1' || !expected
    || request.headers.get('x-reference-capability') !== expected) {
    return Response.json({ error: 'Unavailable' }, { status: 403 });
  }
  const token = createSession({ subjectId: 'alice', tenantId: '019fb007-0000-7000-8000-000000000002',
    roles: ['member'], attributes: {} });
  return Response.json({ ready: true }, { headers: {
    'set-cookie': `session=${token}; HttpOnly; SameSite=Strict; Path=/`, 'cache-control': 'no-store',
  } });
}
