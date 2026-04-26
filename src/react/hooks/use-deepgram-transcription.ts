import { useState, useRef, useCallback, useEffect } from 'react';
import type {
  UseDeepgramTranscriptionOptions,
  UseDeepgramTranscriptionReturn,
} from '../types.js';

const DEFAULT_LANGUAGE = 'de';
const CONNECT_TIMEOUT_MS = 5000;
const SPEECH_STREAM_ENDPOINT = '/api/ai/speech-stream';

type TransportType = 'websocket' | 'http';

export function useDeepgramTranscription(
  options: UseDeepgramTranscriptionOptions = {},
): UseDeepgramTranscriptionReturn {
  const {
    language = DEFAULT_LANGUAGE,
    baseUrl,
    getToken,
    onInterimTranscript,
    onError,
  } = options;

  const [isRecording, setIsRecording] = useState(false);
  const [isConnecting, setIsConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [transcript, setTranscript] = useState('');

  const socketRef = useRef<WebSocket | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const processorRef = useRef<AudioNode | null>(null);
  const connectTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);

  const transcriptRef = useRef('');
  const lastFullTextRef = useRef('');

  const clearConnectTimeout = useCallback(() => {
    if (connectTimeoutRef.current) {
      clearTimeout(connectTimeoutRef.current);
      connectTimeoutRef.current = null;
    }
  }, []);

  const cleanup = useCallback(() => {
    clearConnectTimeout();

    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }

    if (mediaRecorderRef.current) {
      const recorder = mediaRecorderRef.current;
      if (recorder.state !== 'inactive') {
        recorder.stop();
      }
      mediaRecorderRef.current = null;
    }

    if (processorRef.current) {
      processorRef.current.disconnect();
      processorRef.current = null;
    }

    if (sourceRef.current) {
      sourceRef.current.disconnect();
      sourceRef.current = null;
    }

    if (audioContextRef.current) {
      void audioContextRef.current.close();
      audioContextRef.current = null;
    }

    if (socketRef.current) {
      const socket = socketRef.current;
      socket.onopen = null;
      socket.onmessage = null;
      socket.onerror = null;
      socket.onclose = null;
      if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
        socket.close();
      }
      socketRef.current = null;
    }

    if (streamRef.current) {
      for (const track of streamRef.current.getTracks()) {
        track.stop();
      }
      streamRef.current = null;
    }
  }, [clearConnectTimeout]);

  useEffect(() => cleanup, [cleanup]);

  const determineTransportAndUrl = useCallback((token?: string): { transport: TransportType; url: string } => {
    const tokenParam = token ? `&token=${encodeURIComponent(token)}` : '';

    if (baseUrl) {
      const urlLower = baseUrl.toLowerCase();
      if (urlLower.startsWith('ws://') || urlLower.startsWith('wss://')) {
        return { transport: 'websocket', url: `${baseUrl}?language=${encodeURIComponent(language)}${tokenParam}` };
      } else if (urlLower.startsWith('http://') || urlLower.startsWith('https://')) {
        return { transport: 'http', url: `${baseUrl}?language=${encodeURIComponent(language)}${tokenParam}` };
      }
    }
    // Default: WebSocket from current origin
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}${SPEECH_STREAM_ENDPOINT}?language=${encodeURIComponent(language)}${tokenParam}`;
    return { transport: 'websocket', url: wsUrl };
  }, [baseUrl, language]);

  const handleTranscriptMessage = useCallback((data: {
    type?: string;
    message?: string;
    is_final?: boolean;
    channel?: { alternatives?: Array<{ transcript?: string }> };
  }) => {
    if (data.type === 'error') {
      const errMsg = data.message ?? 'Transcription error';
      setError(errMsg);
      onError?.(errMsg);
      return;
    }

    const text = data.channel?.alternatives?.[0]?.transcript;
    if (!text) return;

    if (data.is_final) {
      if (text.trim()) {
        transcriptRef.current += (transcriptRef.current ? ' ' : '') + text;
        setTranscript(transcriptRef.current);
        lastFullTextRef.current = transcriptRef.current;
      }
      return;
    }

    const fullText = `${transcriptRef.current}${transcriptRef.current ? ' ' : ''}${text}`;
    lastFullTextRef.current = fullText;
    onInterimTranscript?.(fullText);
  }, [onError, onInterimTranscript]);

  const startHttpStreaming = useCallback(async (stream: MediaStream, url: string) => {
    const abortController = new AbortController();
    abortControllerRef.current = abortController;

    const mediaRecorder = new MediaRecorder(stream, {
      mimeType: 'audio/webm;codecs=opus',
    });
    mediaRecorderRef.current = mediaRecorder;

    mediaRecorder.start(250); // Send chunks every 250ms

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/octet-stream',
        },
        body: new ReadableStream({
          start(controller) {
            mediaRecorder.ondataavailable = (event) => {
              if (event.data.size > 0) {
                void event.data.arrayBuffer().then((buffer) => {
                  controller.enqueue(new Uint8Array(buffer));
                });
              }
            };
            mediaRecorder.onstop = () => {
              controller.close();
            };
          },
        }),
        // @ts-expect-error - duplex is required for streaming request body but not in TS types yet
        duplex: 'half',
        signal: abortController.signal,
      });

      if (!response.ok) {
        throw new Error('HTTP streaming failed');
      }

      if (!response.body) {
        throw new Error('No response body');
      }

      setIsConnecting(false);
      setIsRecording(true);

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() ?? '';

          for (const line of lines) {
            if (line.startsWith('data: ')) {
              const jsonStr = line.slice(6);
              try {
                const data = JSON.parse(jsonStr);
                handleTranscriptMessage(data);
              } catch {
                // Ignore malformed JSON
              }
            }
          }
        }
      } catch (err) {
        if (abortController.signal.aborted) {
          // Normal abort, not an error
          return;
        }
        throw err;
      }
    } catch (err) {
      if (abortController.signal.aborted) {
        // Normal abort, not an error
        return;
      }
      const errMsg = err instanceof Error ? err.message : 'Verbindungsfehler';
      setError(errMsg);
      onError?.(errMsg);
      cleanup();
      setIsRecording(false);
      setIsConnecting(false);
    }
  }, [cleanup, onError, handleTranscriptMessage]);

  const startWebSocketStreaming = useCallback(async (stream: MediaStream, wsUrl: string) => {
    const socket = new WebSocket(wsUrl);
    socketRef.current = socket;

    await new Promise<void>((resolve, reject) => {
      connectTimeoutRef.current = setTimeout(() => {
        reject(new Error('Verbindungs-Timeout'));
      }, CONNECT_TIMEOUT_MS);

      socket.onopen = () => {
        clearConnectTimeout();
        resolve();
      };

      socket.onerror = () => {
        clearConnectTimeout();
        reject(new Error('Verbindungsfehler'));
      };
    });

    socket.onmessage = (event) => {
      try {
        const payload = typeof event.data === 'string' ? event.data : '';
        if (!payload) return;

        const data = JSON.parse(payload);
        handleTranscriptMessage(data);
      } catch {
        // Ignore malformed messages
      }
    };

    socket.onerror = () => {
      const errMsg = 'Verbindungsfehler';
      setError(errMsg);
      onError?.(errMsg);
      cleanup();
      setIsRecording(false);
      setIsConnecting(false);
    };

    socket.onclose = () => {
      setIsRecording(false);
      setIsConnecting(false);
    };

    const AudioContextCtor =
      globalThis.AudioContext ??
      ((globalThis as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext);
    if (!AudioContextCtor) {
      throw new Error('Browser unterstuetzt keine Audioaufnahme');
    }

    const audioContext = new AudioContextCtor({ sampleRate: 16000 });

    try {
      await audioContext.audioWorklet.addModule('/audio-worklet-processor.js');
    } catch {
      throw new Error('AudioWorklet nicht verfuegbar');
    }

    const source = audioContext.createMediaStreamSource(stream);
    const processor = new AudioWorkletNode(audioContext, 'audio-processor');

    processor.port.onmessage = (event: MessageEvent<Int16Array>) => {
      if (socket.readyState !== WebSocket.OPEN) return;
      socket.send(event.data.buffer);
    };

    source.connect(processor);
    processor.connect(audioContext.destination);

    audioContextRef.current = audioContext;
    sourceRef.current = source;
    processorRef.current = processor;

    setIsConnecting(false);
    setIsRecording(true);
  }, [clearConnectTimeout, cleanup, onError, handleTranscriptMessage]);

  const startRecording = useCallback(async () => {
    setError(null);
    setTranscript('');
    transcriptRef.current = '';
    lastFullTextRef.current = '';
    setIsConnecting(true);

    try {
      if (!navigator?.mediaDevices?.getUserMedia) {
        throw new Error('Browser unterstuetzt keine Audioaufnahme');
      }

      let stream: MediaStream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            channelCount: 1,
            sampleRate: 16000,
          },
        });
      } catch {
        throw new Error('Mikrofon-Zugriff verweigert');
      }
      streamRef.current = stream;

      const token = getToken?.() ?? undefined;
      const { transport, url } = determineTransportAndUrl(token);

      // For WebSocket, token is required for authentication
      // For HTTP, cookie-based auth can be used instead
      if (transport === 'websocket' && !token) {
        throw new Error('Authentication token required for WebSocket speech stream');
      }

      if (transport === 'http') {
        await startHttpStreaming(stream, url);
      } else {
        await startWebSocketStreaming(stream, url);
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : 'Unbekannter Fehler';
      setError(errMsg);
      onError?.(errMsg);
      setIsConnecting(false);
      setIsRecording(false);
      cleanup();
    }
  }, [cleanup, onError, getToken, determineTransportAndUrl, startHttpStreaming, startWebSocketStreaming]);

  const stopRecording = useCallback((): string => {
    const finalText = lastFullTextRef.current || transcriptRef.current;

    if (finalText && finalText !== transcriptRef.current) {
      setTranscript(finalText);
    }

    cleanup();
    setIsRecording(false);
    setIsConnecting(false);

    return finalText;
  }, [cleanup]);

  return {
    isRecording,
    isConnecting,
    error,
    transcript,
    startRecording,
    stopRecording,
  };
}
