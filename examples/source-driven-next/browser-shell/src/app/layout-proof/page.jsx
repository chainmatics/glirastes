'use client';
import { useState } from 'react';
import { VercelAiChat } from 'glirastes/react/vercel';

// Layout-only browser fixture: no model, app credentials or database access.
export default function LayoutProof() {
  const [open, setOpen] = useState(true);
  const [sidebarWidth, setSidebarWidth] = useState(420);
  return <div data-testid="layout-host" style={{ display: 'flex', height: '100dvh', minWidth: 0 }}>
    <main data-testid="layout-main" style={{ flex: 1, minWidth: 0 }}>
      <h1>Native application</h1>
      <button onClick={() => setOpen(true)}>Open assistant</button>
    </main>
    <VercelAiChat endpoint="/api/chat" portal={false} open={open} onOpenChange={setOpen} keepMounted layoutControls
      defaultMode="sidebar" size={{ width: 672, height: 540 }} title="App assistant"
      welcomeMessage="Ask your app to help"
      sidebarWidth={sidebarWidth} onSidebarWidthChange={setSidebarWidth} />
  </div>;
}
