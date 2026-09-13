'use client';
import { useState } from 'react';
import { ChatWindow } from 'glirastes/react';

// Layout-only browser fixture: no model, app credentials or database access.
export default function LayoutProof() {
  const [open, setOpen] = useState(true);
  const [draft, setDraft] = useState('');
  const [sidebarWidth, setSidebarWidth] = useState(420);
  return <div data-testid="layout-host" style={{ display: 'flex', height: '100dvh', minWidth: 0 }}>
    <main data-testid="layout-main" style={{ flex: 1, minWidth: 0 }}>
      <h1>Native application</h1>
      <button onClick={() => setOpen(true)}>Open assistant</button>
    </main>
    <ChatWindow portal={false} open={open} onOpenChange={setOpen} keepMounted layoutControls
      defaultMode="sidebar" width={672} height={540} title="App assistant"
      sidebarWidth={sidebarWidth} onSidebarWidthChange={setSidebarWidth}>
      <label>Draft<input aria-label="Layout draft" value={draft} onChange={event => setDraft(event.target.value)} /></label>
    </ChatWindow>
  </div>;
}
