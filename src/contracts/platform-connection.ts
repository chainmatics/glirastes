import { z } from 'zod';

const uuid = z.uuid();
const digest = z.string().regex(
  /^sha256:(?:[A-Za-z0-9_-]{43}|[A-Za-z0-9+/]{43}=)$/,
);

const SafeControlPlaneUrlSchema = z.url().max(2_048).superRefine(
  (value, context) => {
    const url = new URL(value);
    if (url.username || url.password) {
      context.addIssue({
        code: 'custom',
        message: 'Control-plane URL must not contain credentials',
      });
      return;
    }

    const loopbackHosts = new Set(['localhost', '127.0.0.1', '[::1]']);
    if (
      url.protocol !== 'https:'
      && !(url.protocol === 'http:' && loopbackHosts.has(url.hostname))
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Control-plane URL must use HTTPS or loopback HTTP',
      });
    }
  },
);

export const PlatformConnectionDescriptorSchema = z.object({
  schemaVersion: z.literal(1),
  baseUrl: SafeControlPlaneUrlSchema,
  appId: uuid,
  environmentId: uuid,
  runnerKey: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/),
}).strict();

export const PairingStartRequestSchema = z.object({
  schemaVersion: z.literal(1),
  localAppId: uuid,
  localAppName: z.string().trim().min(1).max(100),
  artifactDigest: digest,
}).strict();

export const PairingStartResponseSchema = z.object({
  schemaVersion: z.literal(1),
  deviceCode: z.string().min(32).max(256),
  userCode: z.string().regex(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/),
  verificationUri: SafeControlPlaneUrlSchema,
  expiresInSeconds: z.number().int().min(60).max(900),
  pollIntervalMs: z.number().int().min(1_000).max(30_000),
}).strict();

const PairingPendingResultSchema = z.object({
  status: z.literal('pending'),
  pollAfterMs: z.number().int().min(1_000).max(30_000),
}).strict();

const PairingDeniedResultSchema = z.object({
  status: z.literal('denied'),
}).strict();

const PairingExpiredResultSchema = z.object({
  status: z.literal('expired'),
}).strict();

const PairingConnectedResultSchema = z.object({
  status: z.literal('connected'),
  connection: PlatformConnectionDescriptorSchema,
  apiKey: z.string().regex(/^gl_[A-Za-z0-9]{32,128}$/),
}).strict();

export const PairingTokenResultSchema = z.discriminatedUnion('status', [
  PairingPendingResultSchema,
  PairingDeniedResultSchema,
  PairingExpiredResultSchema,
  PairingConnectedResultSchema,
]);

export type PlatformConnectionDescriptor = z.infer<
  typeof PlatformConnectionDescriptorSchema
>;
export type PairingStartRequest = z.infer<typeof PairingStartRequestSchema>;
export type PairingStartResponse = z.infer<typeof PairingStartResponseSchema>;
export type PairingTokenResult = z.infer<typeof PairingTokenResultSchema>;
