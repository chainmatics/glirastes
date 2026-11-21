// @vitest-environment jsdom

import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const adapterConnect = vi.hoisted(() => vi.fn(async () => ({
  finalize: vi.fn(async () => {}),
  cancel: vi.fn(async () => {}),
  close: vi.fn(async () => {}),
})));
const adapterOptions = vi.hoisted(() => vi.fn());

vi.mock('../../stt/deepgram.js', () => ({
  DeepgramSttAdapter: class {
    constructor(options: unknown) {
      adapterOptions(options);
    }
    connect = adapterConnect;
  },
}));

import { useDeepgramTranscription } from '../use-deepgram-transcription.js';

afterEach(() => {
  adapterConnect.mockClear();
  adapterOptions.mockClear();
});

it('passes workletUrl to the adapter it creates', () => {
  const { unmount } = renderHook(() => useDeepgramTranscription({ workletUrl: '/static/pcm.js' }));
  expect(adapterOptions).toHaveBeenCalledWith(expect.objectContaining({ workletUrl: '/static/pcm.js' }));
  unmount();
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

  it('records through the provider adapter of the app when one is given', async () => {
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: { getUserMedia: vi.fn(async () => ({ getTracks: () => [] }) as unknown as MediaStream) },
    });
    const connect = vi.fn(async () => ({
      finalize: vi.fn(async () => {}),
      cancel: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
    }));

    // One adapter for the life of the component, as an app keeps it.
    const adapter = { connect };
    const { result, unmount } = renderHook(() => useDeepgramTranscription({ adapter }));
    await act(async () => {
      await result.current.startRecording('');
    });

    expect(connect).toHaveBeenCalledTimes(1);
    expect(adapterConnect).not.toHaveBeenCalled();
    unmount();
  });
});
