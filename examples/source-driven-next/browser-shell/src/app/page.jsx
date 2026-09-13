'use client';
import { useEffect, useRef, useState } from 'react';
import { UiActionBus } from 'glirastes/react';
import { VercelAiChat } from 'glirastes/react/vercel';
import { NativeUiBridge } from '../glirastes-ui-bridge.js';
import { mountNativeUi } from '../ui.js';
import config from '../ui-config.json';

export default function Page() {
  const container = useRef(null);
  const [bus] = useState(() => new UiActionBus());
  const [ui, setUi] = useState(null);
  const [error, setError] = useState('');
  useEffect(() => {
    const abort = new AbortController();
    let mounted;
    fetch('/api/tasks', { signal: abort.signal }).then(async (response) => {
      if (!response.ok) throw new Error('Start an authenticated reference session first.');
      const { tasks } = await response.json();
      if (abort.signal.aborted) return;
      mounted = mountNativeUi(container.current, config, tasks);
      setUi(mounted);
    }).catch((error) => { if (!abort.signal.aborted) setError(error.message); });
    return () => { abort.abort(); mounted?.dispose(); };
  }, []);
  return <main>
    <p>Native app + Glirastes SDK — deterministic test model</p>
    {error && <p role="alert">{error}</p>}
    <section ref={container} data-testid="native-ui" aria-label="Native application" />
    {ui && <><NativeUiBridge bus={bus} ui={ui} />
      <VercelAiChat endpoint="/chat" title="App assistant" defaultOpen showMic={false}
        onToolResult={(_name, result) => { if (result?.success && result.uiAction) void bus.dispatch(result.uiAction); }} />
    </>}
  </main>;
}
