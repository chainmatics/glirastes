import { describe, expect, it } from 'vitest';
import {
  applySttSegment,
  createSttTranscript,
  type SttSegment,
} from '../segments.js';

function segment(
  id: string,
  text: string,
  isFinal: boolean,
  sequence: number,
): SttSegment {
  return { id, text, isFinal, sequence };
}

describe('STT segment accumulation', () => {
  it('replaces interim text and commits the final segment without duplication', () => {
    let transcript = createSttTranscript();
    transcript = applySttSegment(transcript, segment('a', 'Hallo', false, 1));
    transcript = applySttSegment(transcript, segment('a', 'Hallo Welt', false, 1));

    expect(transcript.displayText).toBe('Hallo Welt');
    expect(transcript.finalText).toBe('');

    transcript = applySttSegment(transcript, segment('a', 'Hallo Welt', true, 1));
    transcript = applySttSegment(transcript, segment('a', 'Hallo Welt', true, 1));

    expect(transcript.displayText).toBe('Hallo Welt');
    expect(transcript.finalText).toBe('Hallo Welt');
  });

  it('orders final and interim segments deterministically', () => {
    let transcript = createSttTranscript();
    transcript = applySttSegment(transcript, segment('b', 'morgen', false, 2));
    transcript = applySttSegment(transcript, segment('a', 'Bis', true, 1));

    expect(transcript.displayText).toBe('Bis morgen');
    expect(transcript.finalText).toBe('Bis');
  });

  it('does not lose a corrected final segment', () => {
    let transcript = createSttTranscript();
    transcript = applySttSegment(transcript, segment('a', 'Aufgabe', true, 1));
    transcript = applySttSegment(transcript, segment('a', 'Aufgaben', true, 1));

    expect(transcript.finalText).toBe('Aufgaben');
  });
});
