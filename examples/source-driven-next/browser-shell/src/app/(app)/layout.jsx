'use client';
import { VercelAiChat } from 'glirastes/react/vercel';
import { GlirastesBridge } from '../../glirastes-bridge.jsx';

// The chat and the navigation bridge live in the layout, so they survive the
// page changes that ui.navigate and ui.filter.tasks ask the router for.
export default function AppLayout({ children }) {
  return <main>
    <p>Native app + Glirastes SDK — deterministic test model</p>
    {children}
    <GlirastesBridge />
    <VercelAiChat endpoint="/chat" title="App assistant" defaultOpen showMic={false} />
  </main>;
}
