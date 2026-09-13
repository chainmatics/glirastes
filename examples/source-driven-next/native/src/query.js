import { resolveSession } from './auth.js';

export async function query(request, inputSchema, outputSchema, execute) {
  const principal = resolveSession(request);
  if (!principal) return Response.json({ error: 'Unauthenticated' }, { status: 401 });
  if (!principal.roles.includes('member')) return Response.json({ error: 'Forbidden' }, { status: 403 });
  const input = inputSchema.safeParse(Object.fromEntries(new URL(request.url).searchParams));
  if (!input.success) return Response.json({ error: 'Invalid query' }, { status: 400 });
  const output = outputSchema.safeParse(await execute(input.data, principal));
  if (!output.success) return Response.json({ error: 'Invalid response' }, { status: 500 });
  return Response.json(output.data);
}
