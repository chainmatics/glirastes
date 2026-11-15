// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { VoiceInputAddon } from '../voice-input-addon.js';
import { ChatContext } from '../../provider/chat-context.js';
import { deChatLocale } from '../../locale-de.js';
import type { ChatContextValue } from '../../provider/chat-context.js';
afterEach(cleanup);
it('shows icons with localized labels and a useful localized capture error', async () => {
  Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: async () => ({ getTracks: () => [{ stop: vi.fn() }] }) } });
  const adapter = { connect: async () => { throw new Error('Speech audio asset could not be loaded: /missing.js.'); } };
  render(<ChatContext.Provider value={{ locale: deChatLocale } as ChatContextValue}>
    <VoiceInputAddon disabled={false} language="de" adapter={adapter} onTranscript={vi.fn()} />
  </ChatContext.Provider>);
  const mic = screen.getByRole('button', { name: 'Aufnahme starten' });
  expect(mic.querySelector('svg')).not.toBeNull();
  expect(mic.textContent).not.toBe('mic');
  fireEvent.click(mic);
  await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('Audio-Datei'));
  expect(screen.getByRole('button', { name: 'Aufnahme wiederholen' }).textContent).toContain('Aufnahme wiederholen');
});
