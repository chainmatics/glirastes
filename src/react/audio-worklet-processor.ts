/**
 * AudioWorklet processor for real-time audio streaming
 * Converts Float32 audio samples to Int16 format for Deepgram
 *
 * Note: This file is intentionally not unit tested as AudioWorkletProcessor
 * runs in a separate audio rendering thread and is difficult to test in isolation.
 * Integration testing happens in the useDeepgramTranscription hook.
 */

// Type declarations for AudioWorklet API (not in standard TypeScript libs)
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
  process(
    inputs: Float32Array[][],
    outputs: Float32Array[][],
    parameters: Record<string, Float32Array>
  ): boolean;
}

declare function registerProcessor(
  name: string,
  processorCtor: typeof AudioWorkletProcessor
): void;

class AudioProcessor extends AudioWorkletProcessor {
  process(
    inputs: Float32Array[][],
    outputs: Float32Array[][],
    parameters: Record<string, Float32Array>
  ): boolean {
    const input = inputs[0]?.[0];

    if (!input || input.length === 0) {
      return true;
    }

    // Convert Float32 (-1.0 to 1.0) to Int16 (-32768 to 32767)
    const int16Data = new Int16Array(input.length);

    for (let i = 0; i < input.length; i++) {
      const sample = Math.max(-1, Math.min(1, input[i] ?? 0));
      int16Data[i] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
    }

    // Send to main thread
    this.port.postMessage(int16Data, [int16Data.buffer]);

    return true; // Keep processor alive
  }
}

registerProcessor('audio-processor', AudioProcessor);
