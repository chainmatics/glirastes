import {
  PairingStartRequestSchema,
  PairingStartResponseSchema,
  PairingTokenResultSchema,
  type PairingStartRequest,
  type PairingStartResponse,
  type PairingTokenResult,
} from '../contracts/index.js';
import { FoundationDiagnosticError } from '../diagnostics/index.js';

export interface RuntimeConnectClientOptions {
  baseUrl: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
  sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
}

export interface PollForConnectionOptions {
  deviceCode: string;
  pollIntervalMs: number;
  expiresInSeconds: number;
  signal?: AbortSignal;
}

function safeControlPlaneBaseUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new FoundationDiagnosticError({
      code: 'E-CONNECT-URL-INVALID',
      operation: 'connect.client',
      message: 'The Control Plane URL is invalid.',
      remediation: 'configure-control-plane-url',
    });
  }
  if (value.length > 2_048) {
    throw new FoundationDiagnosticError({
      code: 'E-CONNECT-URL-INVALID',
      operation: 'connect.client',
      message: 'The Control Plane URL exceeds the supported length.',
      remediation: 'configure-control-plane-url',
    });
  }
  if (url.username || url.password) {
    throw new FoundationDiagnosticError({
      code: 'E-CONNECT-URL-INVALID',
      operation: 'connect.client',
      message: 'The Control Plane URL must not contain credentials.',
      remediation: 'remove-url-credentials',
    });
  }
  const loopback = new Set(['localhost', '127.0.0.1', '[::1]']);
  if (
    url.protocol !== 'https:'
    && !(url.protocol === 'http:' && loopback.has(url.hostname))
  ) {
    throw new FoundationDiagnosticError({
      code: 'E-CONNECT-URL-INVALID',
      operation: 'connect.client',
      message: 'The Control Plane URL must use HTTPS or loopback HTTP.',
      remediation: 'use-secure-control-plane-url',
    });
  }
  return value.replace(/\/$/, '');
}

function diagnostic(
  code: `E-CONNECT-${string}`,
  message: string,
  remediation: string,
): FoundationDiagnosticError {
  return new FoundationDiagnosticError({
    code,
    operation: 'connect.pairing',
    message,
    remediation,
  });
}

async function defaultSleep(
  milliseconds: number,
  signal?: AbortSignal,
): Promise<void> {
  if (signal?.aborted) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, milliseconds);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}

export class RuntimeConnectClient {
  private readonly baseUrl: string;

  constructor(private readonly options: RuntimeConnectClientOptions) {
    this.baseUrl = safeControlPlaneBaseUrl(options.baseUrl);
  }

  async startPairing(
    input: PairingStartRequest,
    signal?: AbortSignal,
  ): Promise<PairingStartResponse> {
    const body = PairingStartRequestSchema.parse(input);
    const value = await this.request('', body, signal);
    const parsed = PairingStartResponseSchema.safeParse(value);
    if (!parsed.success) {
      throw diagnostic(
        'E-CONNECT-RESPONSE-INVALID',
        'The Control Plane returned an invalid pairing response.',
        'retry-browser-pairing',
      );
    }
    return parsed.data;
  }

  async pollForConnection(
    options: PollForConnectionOptions,
  ): Promise<PairingTokenResult> {
    const startedAt = (this.options.now ?? Date.now)();
    const deadline = startedAt + options.expiresInSeconds * 1_000;
    let interval = options.pollIntervalMs;
    const sleep = this.options.sleep ?? defaultSleep;

    while (true) {
      this.assertActive(options.signal, deadline);
      await sleep(interval, options.signal);
      this.assertActive(options.signal, deadline);

      const value = await this.request(
        '/token',
        { deviceCode: options.deviceCode },
        options.signal,
      );
      const parsed = PairingTokenResultSchema.safeParse(value);
      if (!parsed.success) {
        throw diagnostic(
          'E-CONNECT-RESPONSE-INVALID',
          'The Control Plane returned an invalid pairing status.',
          'retry-browser-pairing',
        );
      }
      if (parsed.data.status !== 'pending') return parsed.data;
      interval = parsed.data.pollAfterMs;
    }
  }

  private assertActive(signal: AbortSignal | undefined, deadline: number): void {
    if (signal?.aborted) {
      throw diagnostic(
        'E-CONNECT-CANCELLED',
        'Platform pairing was cancelled.',
        'restart-browser-pairing',
      );
    }
    if ((this.options.now ?? Date.now)() >= deadline) {
      throw diagnostic(
        'E-CONNECT-TIMEOUT',
        'Platform pairing timed out.',
        'restart-browser-pairing',
      );
    }
  }

  private async request(
    suffix: '' | '/token',
    body: unknown,
    signal?: AbortSignal,
  ): Promise<unknown> {
    let response: Response;
    try {
      response = await (this.options.fetchImpl ?? fetch)(
        `${this.baseUrl}/v1/runtime-connect/pairings${suffix}`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
          signal,
        },
      );
    } catch {
      if (signal?.aborted) {
        throw diagnostic(
          'E-CONNECT-CANCELLED',
          'Platform pairing was cancelled.',
          'restart-browser-pairing',
        );
      }
      throw diagnostic(
        'E-CONNECT-NETWORK',
        'The Control Plane pairing request failed.',
        'check-control-plane-connection',
      );
    }
    if (!response.ok) {
      throw diagnostic(
        'E-CONNECT-REQUEST',
        `The Control Plane pairing request failed (${response.status}).`,
        'retry-browser-pairing',
      );
    }
    try {
      return await response.json();
    } catch {
      throw diagnostic(
        'E-CONNECT-RESPONSE-INVALID',
        'The Control Plane returned invalid pairing data.',
        'retry-browser-pairing',
      );
    }
  }
}
