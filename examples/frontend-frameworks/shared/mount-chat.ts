/** Client-only host glue. It reuses SDK UI, persistence and actions; it defines no tools or backend authorization. */
export async function mountChat(host: HTMLElement, options: {
  framework: string;
  push: (href: string) => unknown;
  signal: AbortSignal;
}): Promise<() => void> {
  const [{ defineGlirastesChatElement }, { createLocalSessionStore }, { registerAiClientAction, registerNavigationBridge }, { z }] = await Promise.all([
    import('glirastes/embed'), import('glirastes/react'), import('glirastes/browser'), import('zod'),
  ]);
  if (options.signal.aborted) return () => {};
  const response = await fetch('/api/me', { credentials: 'same-origin', signal: options.signal });
  if (!response.ok) throw new Error('A verified backend session is required');
  const identity = z.object({ userId: z.string().min(1), tenantId: z.string().min(1) }).parse(await response.json());
  if (options.signal.aborted) return () => {};
  const unregisterAction = registerAiClientAction('fixture.highlight', () => {
    const target = document.querySelector<HTMLElement>('[data-testid="highlight-target"]');
    if (!target) return false;
    target.dataset.highlightCount = String(Number(target.dataset.highlightCount ?? 0) + 1);
    target.style.backgroundColor = '#fff2a8';
    return true;
  }, z.object({}).strict());
  const unregisterNavigation = registerNavigationBridge({ push: options.push });
  defineGlirastesChatElement();
  const chat = document.createElement('glirastes-chat') as import('glirastes/embed').GlirastesChatElement;
  chat.setAttribute('endpoint', '/api/chat');
  chat.setAttribute('placeholder', 'Ask the fixture');
  // Set before append: connectedCallback must never initialize an unscoped store.
  chat.config = { session: createLocalSessionStore({
    storageKey: JSON.stringify(['frontend-reference', options.framework, 'local', identity.tenantId, identity.userId]),
  }) };
  const cleanup = () => {
    options.signal.removeEventListener('abort', cleanup);
    unregisterAction(); unregisterNavigation(); chat.remove();
  };
  options.signal.addEventListener('abort', cleanup, { once: true });
  host.append(chat);
  return cleanup;
}
