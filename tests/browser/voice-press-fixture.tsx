import { useMemo } from 'react';
import { createRoot } from 'react-dom/client';
import { AiChatProvider } from '../../src/react/provider/ai-chat-provider.js';
import { ChatInput } from '../../src/react/components/chat-input.js';
import { MentionInput } from '../../src/react/components/mention-input.js';
import type { SttProviderAdapter } from '../../src/react/stt/controller.js';
import type { ChatCompletionProvider, ChatTransport } from '../../src/react/types.js';

interface PressHarness {
  /** Texts the composer sent; speech must never land here by itself. */
  sent: string[];
  /** Microphone streams opened so far (Chrome's fake device). */
  streamCount(): number;
  liveTrackCount(): number;
  maxConcurrentLiveTracks(): number;
}

declare global {
  interface Window {
    harness: PressHarness;
    mountVoiceComposer(kind: 'default' | 'providers', voice?: { pushToTalk?: false }): void;
  }
}

const streams: MediaStream[] = [];
let maxLive = 0;
const live = () => streams
  .flatMap((stream) => stream.getTracks())
  .filter((track) => track.readyState === 'live').length;

// Count what the controller really opens on the fake device.
const realGetUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
navigator.mediaDevices.getUserMedia = async (constraints) => {
  const stream = await realGetUserMedia(constraints);
  streams.push(stream);
  maxLive = Math.max(maxLive, live());
  return stream;
};

const sent: string[] = [];
window.harness = {
  sent,
  streamCount: () => streams.length,
  liveTrackCount: live,
  maxConcurrentLiveTracks: () => maxLive,
};

// An instant provider: the stop completes within microtasks, the fastest
// case for a click that follows a hold release.
const adapter: SttProviderAdapter = {
  connect: async ({ events }) => {
    events.onSegment({ id: 's1', sequence: 1, text: 'hallo wel', isFinal: false });
    return {
      finalize: async () => {
        events.onSegment({ id: 's1', sequence: 1, text: 'Hallo Welt', isFinal: true });
      },
      cancel: async () => {},
      close: async () => {},
    };
  },
};

const chat: ChatTransport = {
  messages: [],
  status: 'ready',
  error: null,
  sendMessage: async ({ text }) => { sent.push(text); },
  stop: () => {},
  setMessages: () => {},
  addToolApprovalResponse: async () => {},
};

const people: ChatCompletionProvider = {
  id: 'people',
  trigger: '@',
  search: () => [{ id: '42', type: 'user', label: 'Alice Doe' }],
};

function Composer({ kind, pushToTalk }: { kind: 'default' | 'providers'; pushToTalk?: false }) {
  const voice = useMemo(() => ({ enabled: true, adapter, pushToTalk }), [pushToTalk]);
  const providers = useMemo(() => [people], []);
  return (
    <AiChatProvider
      transport={chat}
      voice={voice}
      completionProviders={kind === 'providers' ? providers : undefined}
    >
      {/* styles.css scopes the composer layout to the panel element. */}
      <div data-component="ai-chat-panel" style={{ maxWidth: 800 }}>
        {kind === 'providers' ? <MentionInput /> : <ChatInput />}
      </div>
    </AiChatProvider>
  );
}

const root = createRoot(document.getElementById('root')!);
window.mountVoiceComposer = (kind, voice) => root.render(
  <Composer kind={kind} pushToTalk={voice?.pushToTalk} />,
);
