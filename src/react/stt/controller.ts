import {
  applySttSegment,
  createSttTranscript,
  type SttSegment,
  type SttTranscript,
} from './segments.js';

export type SttSessionPhase =
  | 'idle'
  | 'requesting_permission'
  | 'connecting'
  | 'recording'
  | 'finalizing'
  | 'completed'
  | 'cancelled'
  | 'failed';

export interface SttSessionSnapshot {
  phase: SttSessionPhase;
  displayTranscript: string;
  finalTranscript: string;
  interimTranscript: string;
  error: string | null;
}

export interface SttProviderEvents {
  onSegment: (segment: SttSegment) => void;
  onError: (error: Error) => void;
  onClosed: () => void;
}

export interface SttProviderConnection {
  finalize(): Promise<void>;
  cancel(): Promise<void>;
  close(): Promise<void>;
}

export interface SttProviderAdapter {
  connect(input: {
    stream: MediaStream;
    language: string;
    signal: AbortSignal;
    events: SttProviderEvents;
  }): Promise<SttProviderConnection>;
}

export interface SttSessionControllerOptions {
  adapter: SttProviderAdapter;
  language: string;
  getUserMedia?: (constraints: MediaStreamConstraints) => Promise<MediaStream>;
}

type Listener = (snapshot: SttSessionSnapshot) => void;

export class SttSessionController {
  private currentSnapshot: SttSessionSnapshot = {
    phase: 'idle',
    displayTranscript: '',
    finalTranscript: '',
    interimTranscript: '',
    error: null,
  };
  private transcript: SttTranscript = createSttTranscript();
  private stream: MediaStream | null = null;
  private connection: SttProviderConnection | null = null;
  private abortController: AbortController | null = null;
  private listeners = new Set<Listener>();
  private sessionGeneration = 0;
  private previousDraft = '';
  private connectionClosed = false;

  constructor(private readonly options: SttSessionControllerOptions) {}

  get snapshot(): SttSessionSnapshot {
    return this.currentSnapshot;
  }

  getStream(): MediaStream | null {
    return this.stream;
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async start(previousDraft: string): Promise<void> {
    await this.releaseResources();
    const generation = ++this.sessionGeneration;
    this.previousDraft = previousDraft;
    this.transcript = createSttTranscript();
    this.update({
      phase: 'requesting_permission',
      displayTranscript: '',
      finalTranscript: '',
      interimTranscript: '',
      error: null,
    });

    let connectionError: Error | null = null;
    try {
      const getUserMedia = this.options.getUserMedia
        ?? ((constraints: MediaStreamConstraints) => (
          navigator.mediaDevices.getUserMedia(constraints)
        ));
      const stream = await getUserMedia({
        audio: { channelCount: 1, sampleRate: 16_000 },
      });
      if (generation !== this.sessionGeneration) {
        for (const track of stream.getTracks()) track.stop();
        return;
      }
      this.stream = stream;
      this.abortController = new AbortController();
      this.connectionClosed = false;
      this.update({ ...this.currentSnapshot, phase: 'connecting' });

      const connection = await this.options.adapter.connect({
        stream,
        language: this.options.language,
        signal: this.abortController.signal,
        events: {
          onSegment: (segment) => {
            if (generation !== this.sessionGeneration) return;
            this.transcript = applySttSegment(this.transcript, segment);
            this.update({
              ...this.currentSnapshot,
              displayTranscript: this.transcript.displayText,
              finalTranscript: this.transcript.finalText,
              interimTranscript: this.transcript.interimText,
            });
          },
          onError: (error) => {
            if (generation !== this.sessionGeneration) return;
            connectionError = error;
            void this.fail(error);
          },
          onClosed: () => {
            if (generation !== this.sessionGeneration) return;
            this.connectionClosed = true;
            if (
              this.currentSnapshot.phase === 'connecting'
              || this.currentSnapshot.phase === 'recording'
            ) {
              connectionError = new Error(
                'Speech provider connection closed unexpectedly',
              );
              void this.fail(connectionError);
            }
          },
        },
      });
      if (connectionError) {
        await connection.close();
        throw connectionError;
      }
      if (generation !== this.sessionGeneration) {
        await connection.close();
        return;
      }
      this.connection = connection;
      this.update({ ...this.currentSnapshot, phase: 'recording' });
    } catch (error) {
      if (generation !== this.sessionGeneration) {
        if (this.currentSnapshot.phase === 'failed') throw error;
        return;
      }
      await this.fail(error);
      throw error;
    }
  }

  async retry(): Promise<void> {
    await this.start(this.previousDraft);
  }

  async stop(): Promise<string> {
    if (!this.connection) {
      const committed = this.transcript.finalText
        || this.transcript.displayText;
      if (
        this.currentSnapshot.phase === 'requesting_permission'
        || this.currentSnapshot.phase === 'connecting'
      ) {
        this.sessionGeneration += 1;
        await this.releaseResources();
        this.update({
          phase: 'completed',
          displayTranscript: committed,
          finalTranscript: committed,
          interimTranscript: '',
          error: null,
        });
      }
      return committed;
    }
    this.update({ ...this.currentSnapshot, phase: 'finalizing' });
    try {
      await this.connection.finalize();
      const committed = this.transcript.finalText || this.transcript.displayText;
      await this.releaseResources();
      this.update({
        phase: 'completed',
        displayTranscript: committed,
        finalTranscript: committed,
        interimTranscript: '',
        error: null,
      });
      return committed;
    } catch (error) {
      await this.fail(error);
      throw error;
    }
  }

  async cancel(): Promise<string> {
    this.sessionGeneration += 1;
    if (this.connection) await this.connection.cancel();
    await this.releaseResources();
    this.transcript = createSttTranscript();
    this.update({
      phase: 'cancelled',
      displayTranscript: '',
      finalTranscript: '',
      interimTranscript: '',
      error: null,
    });
    return this.previousDraft;
  }

  async dispose(): Promise<void> {
    this.sessionGeneration += 1;
    await this.releaseResources();
  }

  private async fail(error: unknown): Promise<void> {
    const resolved = error instanceof Error ? error : new Error(String(error));
    this.sessionGeneration += 1;
    await this.releaseResources();
    this.update({
      ...this.currentSnapshot,
      phase: 'failed',
      error: resolved.message,
    });
  }

  private async releaseResources(): Promise<void> {
    this.abortController?.abort();
    this.abortController = null;

    const connection = this.connection;
    this.connection = null;
    if (connection && !this.connectionClosed) {
      this.connectionClosed = true;
      await connection.close();
    }

    const stream = this.stream;
    this.stream = null;
    if (stream) {
      for (const track of stream.getTracks()) track.stop();
    }
  }

  private update(snapshot: SttSessionSnapshot): void {
    this.currentSnapshot = Object.freeze(snapshot);
    for (const listener of this.listeners) listener(this.currentSnapshot);
  }
}
