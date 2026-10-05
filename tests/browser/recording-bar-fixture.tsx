import { createRoot } from 'react-dom/client';
import { RecordingBar } from '../../src/react/components/recording-bar.js';
import { RichMentionInput } from '../../src/react/components/rich-mention-input.js';

declare global {
  interface Window {
    mountComposer(transcript: string): void;
  }
}

/**
 * The provider composer while recording, as ProviderMentionInput renders it
 * (src/react/components/mention-input.tsx): editor, the mic button that reads
 * "stop", the inline recording bar, and Send, all in one bare <form>. Real
 * editor, real RecordingBar, real styles.css; only the chat context is left
 * out, so the Chrome fake-microphone harness covers the full flow instead.
 */
function Composer({ transcript }: { transcript: string }) {
  return (
    <div data-component="ai-chat-panel">
      <div data-component="mention-input" data-mode="providers">
        <form onSubmit={(event) => event.preventDefault()}>
          <RichMentionInput placeholder="Type a message..." onSearch={() => []} />
          <button type="button" data-component="voice-input-addon" data-state="recording">stop</button>
          <RecordingBar
            variant="inline"
            isConnecting={false}
            stream={null}
            transcript={transcript}
            onCancel={() => {}}
            onStop={() => {}}
          />
          <button type="submit" data-action="send" disabled>Send</button>
        </form>
      </div>
    </div>
  );
}

const root = createRoot(document.getElementById('root')!);
window.mountComposer = (transcript) => root.render(<Composer transcript={transcript} />);
