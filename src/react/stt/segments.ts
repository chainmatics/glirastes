export interface SttSegment {
  id: string;
  sequence: number;
  text: string;
  isFinal: boolean;
}

interface StoredSttSegment extends SttSegment {
  text: string;
}

export interface SttTranscript {
  readonly segments: ReadonlyArray<StoredSttSegment>;
  readonly finalText: string;
  readonly interimText: string;
  readonly displayText: string;
}

function joinText(segments: ReadonlyArray<StoredSttSegment>): string {
  return segments
    .map((segment) => segment.text.trim())
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function materialize(segments: ReadonlyArray<StoredSttSegment>): SttTranscript {
  const ordered = [...segments].sort((left, right) => (
    left.sequence - right.sequence || left.id.localeCompare(right.id)
  ));
  return {
    segments: ordered,
    finalText: joinText(ordered.filter((segment) => segment.isFinal)),
    interimText: joinText(ordered.filter((segment) => !segment.isFinal)),
    displayText: joinText(ordered),
  };
}

export function createSttTranscript(): SttTranscript {
  return materialize([]);
}

export function applySttSegment(
  transcript: SttTranscript,
  segment: SttSegment,
): SttTranscript {
  const text = segment.text.trim();
  if (!text) return transcript;

  const next = transcript.segments.filter((candidate) => candidate.id !== segment.id);
  next.push({ ...segment, text });
  return materialize(next);
}
