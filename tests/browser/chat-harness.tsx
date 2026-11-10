// Browser harness for tests/chat-browser.test.mjs. Bundled by Bun from the
// SDK sources; no model, network provider, app data or credentials.
import { useCallback, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  AiChatPanel,
  AiChatProvider,
  FloatingChatUI,
  createUiToolCommandProvider,
  useChatContext,
  type ChatMessage,
  type ChatTransport,
  type SessionConfig,
  type SessionSummary,
  type SttProviderAdapter,
} from '../../src/react/index.js';
import { defineGlirastesChatElement, type GlirastesChatElement } from '../../src/embed/index.js';

interface HarnessApi {
  sent: string[];
  events: Array<{ type: string; detail: unknown }>;
  streamCount(): number;
  liveTrackCount(): number;
  maxConcurrentLiveTracks(): number;
  failNextConnect(): void;
}

const sent: string[] = [];
const events: Array<{ type: string; detail: unknown }> = [];
const streams: MediaStream[] = [];
let maxConcurrent = 0;
let failNext = false;

const liveTrackCount = () => streams
  .flatMap((stream) => stream.getTracks())
  .filter((track) => track.readyState === 'live').length;

// Count every microphone the SDK opens; Chrome's fake device supplies audio.
const mediaDevices = navigator.mediaDevices;
const realGetUserMedia = mediaDevices.getUserMedia.bind(mediaDevices);
mediaDevices.getUserMedia = async (constraints) => {
  const stream = await realGetUserMedia(constraints);
  streams.push(stream);
  maxConcurrent = Math.max(maxConcurrent, liveTrackCount());
  return stream;
};

// Not declared as a global `Window.harness`: tests/browser/voice-press-fixture.tsx
// declares the same property with its own type, and the two cannot merge under
// `typecheck:tests` (one program over every file in tests/).
const api: HarnessApi = {
  sent,
  events,
  streamCount: () => streams.length,
  liveTrackCount,
  maxConcurrentLiveTracks: () => maxConcurrent,
  failNextConnect: () => { failNext = true; },
};
Object.assign(window, { harness: api });

/** Deterministic speech provider: interim text while recording, final on Stop. */
const speech: SttProviderAdapter = {
  async connect({ events: sink, signal }) {
    if (failNext) {
      failNext = false;
      throw new Error('fixture provider unavailable');
    }
    const timer = setTimeout(() => sink.onSegment({
      id: 's1', sequence: 1, text: 'hallo welt aus dem browser', isFinal: false,
    }), 30);
    signal.addEventListener('abort', () => clearTimeout(timer));
    return {
      finalize: async () => {
        clearTimeout(timer);
        sink.onSegment({ id: 's1', sequence: 1, text: 'Hallo Welt aus dem Browser', isFinal: true });
      },
      cancel: async () => clearTimeout(timer),
      close: async () => clearTimeout(timer),
    };
  },
};

const noop = () => {};

/** Like a real transport: stable callbacks, only `messages` changes. */
function useFakeTransport(initial: ChatMessage[]): ChatTransport {
  const [messages, setMessages] = useState<ChatMessage[]>(initial);
  const sendMessage = useCallback(async ({ text }: { text: string }) => {
    sent.push(text);
    setMessages((previous) => [...previous, {
      id: `user-${previous.length}`, role: 'user', parts: [{ type: 'text', text }],
    }]);
  }, []);
  const replaceMessages = useCallback((next: ChatMessage[]) => setMessages(next), []);
  return useMemo<ChatTransport>(() => ({
    messages,
    status: 'ready',
    error: null,
    sendMessage,
    stop: noop,
    setMessages: replaceMessages,
    addToolApprovalResponse: noop,
  }), [messages, sendMessage, replaceMessages]);
}

const sessionRows = new Map<string, ChatMessage[]>([['first', []], ['second', []]]);
const sessionList: SessionSummary[] = [
  { id: 'first', title: 'Erste Sitzung' },
  { id: 'second', title: 'Zweite Sitzung' },
];
const sessions: SessionConfig = {
  defaultActiveId: 'first',
  list: async () => sessionList,
  load: async (id) => sessionRows.get(id) ?? [],
  save: async (id, rows) => { sessionRows.set(id, rows); },
  create: async () => sessionList[0]!,
  remove: async () => {},
};

function SessionButton() {
  const { switchSession, activeSessionId } = useChatContext();
  return (
    <button type="button" onClick={() => { void switchSession(activeSessionId === 'first' ? 'second' : 'first'); }}>
      Switch session
    </button>
  );
}

function SttView() {
  const [route, setRoute] = useState(location.pathname);
  const [mounted, setMounted] = useState(true);
  const transport = useFakeTransport([]);
  const voice = useMemo(() => ({ enabled: true, adapter: speech, routeKey: route }), [route]);
  window.onpopstate = () => setRoute(location.pathname);
  return (
    <main>
      <nav>
        <button type="button" onClick={() => {
          history.pushState({}, '', '/reports');
          setRoute('/reports');
        }}>Go to reports</button>
        <button type="button" onClick={() => setMounted(false)}>Unmount chat</button>
      </nav>
      {mounted && (
        <AiChatProvider transport={transport} voice={voice} session={sessions}>
          <SessionButton />
          <div style={{ height: 600 }}><AiChatPanel /></div>
        </AiChatProvider>
      )}
    </main>
  );
}

const clarification = {
  id: 'assistant-1',
  role: 'assistant',
  parts: [{
    type: 'tool-ask_clarification',
    toolCallId: 'call-1',
    state: 'output-available',
    input: { question: 'Welche Aufgabe soll ich verschieben?', target: 'object' },
    output: {
      success: true,
      clarification: {
        question: 'Welche Aufgabe soll ich verschieben?',
        target: 'object',
        options: [
          { id: 'task-1', label: 'Quartalsbericht für die Geschäftsführung fertigstellen' },
          { id: 'task-2', label: 'Release prüfen' },
          { id: 'task-3', label: 'Kundentermin vorbereiten' },
        ],
        allowFreeText: true,
      },
    },
  }],
} as unknown as ChatMessage;

const commands = createUiToolCommandProvider({ tools: [
  { definitionId: 'ui.navigate.overview', label: 'Übersicht öffnen' },
  { definitionId: 'ui.filter.done', label: 'Erledigte Aufgaben filtern' },
] });

function MobileView() {
  const transport = useFakeTransport([
    { id: 'user-0', role: 'user', parts: [{ type: 'text', text: 'Verschiebe die Aufgabe auf morgen' }] },
    clarification,
  ]);
  const voice = useMemo(() => ({ enabled: true, adapter: speech }), []);
  const providers = useMemo(() => [commands], []);
  return (
    <div style={{ display: 'flex', height: '100dvh', minWidth: 0 }}>
      <main style={{ flex: 1, minWidth: 0 }}><h1>Native application</h1></main>
      <AiChatProvider transport={transport} voice={voice} completionProviders={providers}>
        <FloatingChatUI portal={false} defaultOpen keepMounted layoutControls defaultMode="sidebar" />
      </AiChatProvider>
    </div>
  );
}

function EmbedView() {
  return <main><h1>Plain host</h1><div id="embed-slot" style={{ height: 600 }} /></main>;
}

const view = new URLSearchParams(location.search).get('view') ?? 'stt';
createRoot(document.getElementById('root')!).render(
  view === 'mobile' ? <MobileView /> : view === 'embed' ? <EmbedView /> : <SttView />,
);

if (view === 'embed') {
  defineGlirastesChatElement();
  for (const type of ['ready', 'status', 'tool-result', 'error']) {
    document.addEventListener(`glirastes-chat:${type}`, (event) => {
      events.push({ type: event.type, detail: (event as CustomEvent).detail });
    });
  }
  const mountEmbed = () => {
    const slot = document.getElementById('embed-slot');
    if (!slot) {
      requestAnimationFrame(mountEmbed);
      return;
    }
    const element = document.createElement('glirastes-chat') as GlirastesChatElement;
    element.setAttribute('endpoint', '/api/chat');
    element.setAttribute('placeholder', 'Frag deine App');
    element.style.setProperty('--glirastes-chat-primary', '#10b981');
    element.transport = {
      messages: [],
      status: 'ready',
      error: null,
      async sendMessage({ text }) { sent.push(text); },
      stop() {},
      setMessages() {},
      addToolApprovalResponse() {},
    };
    slot.append(element);
  };
  mountEmbed();
}
