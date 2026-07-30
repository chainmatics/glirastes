import { createHash } from 'node:crypto';
import type { EndpointMethod } from '../types.js';

export function createRouteSourceFingerprint(
  source: string,
  method: EndpointMethod,
  path: string,
): string {
  const normalized = source.replace(/\r\n/g, '\n');
  const hash = createHash('sha256')
    .update(`${method}\n${path}\n${normalized}`)
    .digest('base64url');
  return `sha256:${hash}`;
}
