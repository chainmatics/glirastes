// @vitest-environment jsdom
import { useState } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { VercelAiChat } from '../../transports/vercel/vercel-ai-chat.js';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('drop-in shared chat layout', () => {
  it('does not focus the hidden composer and focuses it on retained reopen', () => {
    render(<button>Native focus</button>);
    const native = screen.getByRole('button', { name: 'Native focus' });
    native.focus();
    render(<VercelAiChat endpoint="/api/chat" keepMounted />);
    expect(document.activeElement).toBe(native);
    fireEvent.click(screen.getByRole('button', { name: 'AI Assistant' }));
    expect(document.activeElement).toBe(screen.getByRole('textbox'));
    fireEvent.click(screen.getByRole('button', { name: 'Close chat' }));
    native.focus();
    fireEvent.keyDown(window, { key: 'i', ctrlKey: true });
    expect(document.activeElement).toBe(screen.getByRole('textbox'));
  });

  it('dismisses the session menu when the window collapses', async () => {
    const sessions = { defaultActiveId: 'one', load: async () => [], list: async () => [{ id: 'one', title: 'First chat' }], create: async () => ({ id: 'two', title: 'Second chat' }), remove: async () => {} };
    const { rerender } = render(<VercelAiChat endpoint="/api/chat" sessions={sessions} open mode="sidebar" keepMounted />);
    fireEvent.click(await screen.findByRole('button', { name: 'First chat' }));
    expect(screen.getByRole('listbox')).toBeTruthy();
    rerender(<VercelAiChat endpoint="/api/chat" sessions={sessions} open mode="sidebar" collapsed keepMounted />);
    rerender(<VercelAiChat endpoint="/api/chat" sessions={sessions} open mode="sidebar" collapsed={false} keepMounted />);
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it.each(['close', 'collapse'])('dismisses a portaled clear dialog on %s without clearing', async (action) => {
    const sessions = { defaultActiveId: 'one', load: async () => [{ id: 'message', role: 'user' as const, parts: [{ type: 'text' as const, text: 'Saved message' }] }] };
    const { rerender } = render(<VercelAiChat endpoint="/api/chat" sessions={sessions} open mode="sidebar" keepMounted />);
    await screen.findByText('Saved message');
    fireEvent.click(screen.getByRole('button', { name: 'Clear conversation' }));
    expect(screen.getByRole('alertdialog')).toBeTruthy();
    rerender(<VercelAiChat endpoint="/api/chat" sessions={sessions} open={action !== 'close'} mode="sidebar" collapsed={action === 'collapse'} keepMounted />);
    expect(screen.queryByRole('alertdialog')).toBeNull();
    rerender(<VercelAiChat endpoint="/api/chat" sessions={sessions} open mode="sidebar" collapsed={false} keepMounted />);
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(screen.getByText('Saved message')).toBeTruthy();
  });

  it('forwards controlled open and welcome text through the actual Vercel entry', () => {
    const changed = vi.fn();
    render(<VercelAiChat endpoint="/api/chat" open onOpenChange={changed} welcomeMessage="Welcome to your app" />);
    expect(screen.getByRole('textbox')).toBeTruthy();
    expect(screen.getByText('Welcome to your app')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Close chat' }));
    expect(changed).toHaveBeenCalledWith(false);
  });

  it('retains the actual composer through dock, float, collapse and shortcut expand', () => {
    render(<VercelAiChat endpoint="/api/chat" defaultOpen defaultMode="sidebar" portal={false} layoutControls keepMounted />);
    const input = screen.getByRole('textbox') as HTMLTextAreaElement;
    const panel = input.closest('section')!;
    expect(panel.dataset.mode).toBe('sidebar');
    expect(panel.style.position).toBe('relative');
    fireEvent.change(input, { target: { value: 'Keep this draft' } });
    fireEvent.click(screen.getByRole('button', { name: 'Float chat' }));
    expect(panel.dataset.mode).toBe('floating');
    fireEvent.click(screen.getByRole('button', { name: 'Dock chat' }));
    fireEvent.click(screen.getByRole('button', { name: 'Collapse chat' }));
    expect(screen.queryByRole('textbox')).toBeNull();
    fireEvent.keyDown(window, { key: 'i', ctrlKey: true });
    expect(screen.getByRole('textbox')).toBe(input);
    expect(input.value).toBe('Keep this draft');
  });

  it('preserves an unsent draft on close and trigger reopen when requested', () => {
    render(<VercelAiChat endpoint="/api/chat" defaultOpen keepMounted />);
    const input = screen.getByRole('textbox') as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: 'Not submitted' } });
    fireEvent.click(screen.getByRole('button', { name: 'Close chat' }));
    expect(input.isConnected).toBe(true);
    expect(screen.queryByRole('textbox')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'AI Assistant' }));
    expect(screen.getByRole('textbox')).toBe(input);
    expect(input.value).toBe('Not submitted');
  });

  it('supports externally owned layout, localized controls and sidebar width', () => {
    const widths: number[] = [];
    function App() {
      const [mode, setMode] = useState<'sidebar' | 'floating'>('sidebar');
      const [collapsed, setCollapsed] = useState(false);
      const [width, setWidth] = useState(510);
      return <VercelAiChat endpoint="/api/chat" defaultOpen portal={false} layoutControls
        mode={mode} onModeChange={setMode} collapsed={collapsed} onCollapsedChange={setCollapsed}
        sidebarWidth={width} minSidebarWidth={400} maxSidebarWidth={550}
        onSidebarWidthChange={next => { widths.push(next); setWidth(next); }}
        layoutLabels={{ float: 'Fenster', collapse: 'Einklappen', expand: 'Ausklappen', resize: 'Breite' }} />;
    }
    render(<App />);
    const panel = screen.getByRole('textbox').closest('section')!;
    expect(panel.style.width).toBe('510px');
    fireEvent.keyDown(screen.getByRole('separator', { name: 'Breite' }), { key: 'End' });
    expect(panel.style.width).toBe('550px');
    expect(widths).toContain(550);
    fireEvent.click(screen.getByRole('button', { name: 'Einklappen' }));
    fireEvent.click(screen.getByRole('button', { name: 'Ausklappen' }));
    fireEvent.click(screen.getByRole('button', { name: 'Fenster' }));
    expect(panel.dataset.mode).toBe('floating');
  });
});
