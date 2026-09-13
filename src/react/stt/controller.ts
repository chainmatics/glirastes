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
type StopOperation = { generation: number; promise: Promise<string> };

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
  private stopOperation: StopOperation | null = null;

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
      if (generation !== this.sessionGeneration) return;
      await this.releaseResources();
      if (generation !== this.sessionGeneration) return;
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
      if (generation !== this.sessionGeneration) return;

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

  stop(): Promise<string> {
    if (this.stopOperation?.generation === this.sessionGeneration) {
      return this.stopOperation.promise;
    }
    const fallback = this.transcript.finalText || this.transcript.displayText;
    // Install the operation before notifying subscribers, which may also stop.
    const operation: StopOperation = {
      generation: this.sessionGeneration,
      promise: Promise.resolve().then(() => this.finishStop(operation, fallback)),
    };
    this.stopOperation = operation;
    const clear = () => {
      if (this.stopOperation === operation) this.stopOperation = null;
    };
    void operation.promise.then(clear, clear);
    return operation.promise;
  }

  private async finishStop(operation: StopOperation, fallback: string): Promise<string> {
    if (operation.generation !== this.sessionGeneration) return fallback;
    if (!this.connection) {
      const committed = this.transcript.finalText
        || this.transcript.displayText;
      if (
        this.currentSnapshot.phase === 'requesting_permission'
        || this.currentSnapshot.phase === 'connecting'
      ) {
        operation.generation = ++this.sessionGeneration;
        await this.releaseResources();
        if (operation.generation === this.sessionGeneration) this.update({
          phase: 'completed',
          displayTranscript: committed,
          finalTranscript: committed,
          interimTranscript: '',
          error: null,
        });
      }
      return committed;
    }
    const connection = this.connection;
    this.update({ ...this.currentSnapshot, phase: 'finalizing' });
    if (operation.generation !== this.sessionGeneration) return fallback;
    try {
      await connection.finalize();
      if (operation.generation !== this.sessionGeneration) return fallback;
      const committed = this.transcript.finalText || this.transcript.displayText;
      operation.generation = ++this.sessionGeneration;
      await this.releaseResources();
      if (operation.generation === this.sessionGeneration) this.update({
        phase: 'completed',
        displayTranscript: committed,
        finalTranscript: committed,
        interimTranscript: '',
        error: null,
      });
      return committed;
    } catch (error) {
      if (operation.generation === this.sessionGeneration) await this.fail(error);
      throw error;
    }
  }

  async cancel(): Promise<string> {
    const generation = ++this.sessionGeneration;
    const previousDraft = this.previousDraft;
    try {
      if (this.connection) await this.connection.cancel();
      if (generation !== this.sessionGeneration) return previousDraft;
      await this.releaseResources();
    } catch (error) {
      if (generation === this.sessionGeneration) await this.fail(error);
      throw error;
    }
    if (generation !== this.sessionGeneration) return previousDraft;
    this.transcript = createSttTranscript();
    this.update({
      phase: 'cancelled',
      displayTranscript: '',
      finalTranscript: '',
      interimTranscript: '',
      error: null,
    });
    return previousDraft;
  }

  async dispose(): Promise<void> {
    this.sessionGeneration += 1;
    await this.releaseResources();
  }

  private async fail(error: unknown): Promise<void> {
    const resolved = error instanceof Error ? error : new Error(String(error));
    const generation = ++this.sessionGeneration;
    try {
      await this.releaseResources();
    } catch {
      // Tracks are detached/stopped before provider cleanup. Preserve the
      // original failure rather than emit an unhandled secondary close error.
    }
    if (generation === this.sessionGeneration) this.update({
      ...this.currentSnapshot,
      phase: 'failed',
      error: resolved.message,
    });
  }

  private async releaseResources(): Promise<void> {
    // Detach synchronously: awaiting an old provider must never expose or later
    // read resources belonging to a newer recording. Stop tracks even if close
    // rejects or remains pending.
    const abortController = this.abortController;
    this.abortController = null;
    const connection = this.connection;
    this.connection = null;
    const connectionClosed = this.connectionClosed;
    this.connectionClosed = true;
    const stream = this.stream;
    this.stream = null;
    abortController?.abort();
    if (stream) {
      for (const track of stream.getTracks()) track.stop();
    }
    if (connection && !connectionClosed) await connection.close();
  }

  private update(snapshot: SttSessionSnapshot): void {
    this.currentSnapshot = Object.freeze(snapshot);
    for (const listener of this.listeners) listener(this.currentSnapshot);
  }
}
