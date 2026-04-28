import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { IncomingMessage } from 'http';
// Type-only import — erased at compile time, doesn't trigger runtime resolution.
import type WebSocket from 'ws';
import { loadWs } from './ws-loader.js';

export function createSpeechStreamHandler(configService: ConfigService) {
  const logger = new Logger('SpeechStreamGateway');

  return async (clientSocket: WebSocket, req: IncomingMessage) => {
    const { WebSocket: WebSocketCtor } = await loadWs();
    const WS_OPEN = (WebSocketCtor as typeof WebSocket).OPEN;
    const url = new URL(req.url ?? '', `http://${req.headers.host}`);
    const token = url.searchParams.get('token');

    if (!token) {
      logger.warn('Speech stream connection rejected: missing token');
      clientSocket.close(4401, 'Missing authentication token');
      return;
    }

    // Auth enforcement is the consumer's responsibility — the SDK just requires
    // a token to be present. Validate it upstream (auth guard, reverse proxy, etc.).

    const apiKey = configService.get<string>('DEEPGRAM_API_KEY');
    if (!apiKey) {
      logger.error('DEEPGRAM_API_KEY not configured');
      clientSocket.close(1011, 'Speech-to-text not configured');
      return;
    }

    const language = url.searchParams.get('language') ?? 'en';

    const dgUrl = new URL('wss://api.deepgram.com/v1/listen');
    dgUrl.searchParams.set('model', 'nova-3');
    dgUrl.searchParams.set('language', language);
    dgUrl.searchParams.set('punctuate', 'true');
    dgUrl.searchParams.set('interim_results', 'true');
    dgUrl.searchParams.set('encoding', 'linear16');
    dgUrl.searchParams.set('sample_rate', '16000');

    const dgSocket = new WebSocketCtor(dgUrl.toString(), {
      headers: { Authorization: `Token ${apiKey}` },
    });

    dgSocket.on('open', () => {
      logger.log(`Deepgram connected (language=${language})`);
    });

    dgSocket.on('message', (data: Buffer | string) => {
      if (clientSocket.readyState === WS_OPEN) {
        clientSocket.send(data.toString());
      }
    });

    dgSocket.on('error', (err: Error) => {
      logger.error(`Deepgram error: ${err.message}`);
      if (clientSocket.readyState === WS_OPEN) {
        clientSocket.send(
          JSON.stringify({ type: 'error', message: 'Transcription error' }),
        );
      }
    });

    dgSocket.on('close', () => {
      if (clientSocket.readyState === WS_OPEN) {
        clientSocket.close();
      }
    });

    clientSocket.on('message', (data: Buffer) => {
      if (dgSocket.readyState === WS_OPEN) {
        dgSocket.send(data);
      }
    });

    clientSocket.on('close', () => {
      if (dgSocket.readyState === WS_OPEN) {
        dgSocket.close();
      }
    });

    clientSocket.on('error', (err: Error) => {
      logger.error(`Client socket error: ${err.message}`);
      if (dgSocket.readyState === WS_OPEN) {
        dgSocket.close();
      }
    });
  };
}
