'use client';
import { useMemo } from 'react';
import { useChatInteractionsData } from 'glirastes/react';
import { VercelAiChat } from 'glirastes/react/vercel';
import { GlirastesBridge } from '../../glirastes-bridge.jsx';

// The chat and the navigation bridge live in the layout, so they survive the
// page changes that ui.navigate and ui.filter.tasks ask the router for.
export default function AppLayout({ children }) {
  // `/` commands derived from the app's pages, filters and actions; they run without the model.
  const data = useChatInteractionsData('/chat');
  const chatInteractions = useMemo(() => (data ? { data } : undefined), [data]);
  return <main>
    <p>Native app + Glirastes SDK — deterministic test model</p>
    {children}
    <GlirastesBridge />
    <VercelAiChat endpoint="/chat" title="App assistant" defaultOpen showMic={false} chatInteractions={chatInteractions} />
  </main>;
}
