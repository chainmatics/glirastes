// @vitest-environment jsdom

import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const adapterConnect = vi.hoisted(() => vi.fn(async () => ({
  finalize: vi.fn(async () => {}),
  cancel: vi.fn(async () => {}),
  close: vi.fn(async () => {}),
})));

vi.mock('../../stt/deepgram.js', () => ({
  DeepgramSttAdapter: class {
    connect = adapterConnect;
  },
}));

import { useDeepgramTranscription } from '../use-deepgram-transcription.js';

afterEach(() => {
  adapterConnect.mockClear();
});

describe('useDeepgramTranscription', () => {
  it('keeps an active recording when the token callback identity changes', async () => {
    const stopTrack = vi.fn();
    const stream = {
      getTracks: () => [{ stop: stopTrack }],
    } as unknown as MediaStream;
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: {
        getUserMedia: vi.fn(async () => stream),
      },
    });

    const { result, rerender, unmount } = renderHook(
      ({ getToken }) => useDeepgramTranscription({ getToken }),
      {
        initialProps: {
          getToken: (): string => 'first-token',
        },
      },
    );

    await act(async () => {
      await result.current.startRecording('');
    });
    expect(result.current.isRecording).toBe(true);

    rerender({ getToken: () => 'second-token' });

    expect(result.current.isRecording).toBe(true);
    expect(stopTrack).not.toHaveBeenCalled();

    unmount();
  });
});
