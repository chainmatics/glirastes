import { parseExcludePattern } from '../../contracts/tool-exclude-pattern.js';
import type { ExcludedTool } from './types.js';

export interface ExclusionSubject {
  stableKey: string;
  method: string;
  path: string;
  chatHandler: boolean;
}

export interface PolicyExcludeRule {
  match: string;
  reason: string;
}

/** `createAiChatHandler` or an app wrapper such as `createGetItDoneChatHandler` from a Glirastes/agentic module. */
const CHAT_HANDLER_IMPORT = /import\s*\{[^}]*\b\w*ChatHandler\b[^}]*\}\s*from\s*['"][^'"]*(?:glirastes|agentic)[^'"]*['"]/;

export function importsChatHandler(source: string): boolean {
  return CHAT_HANDLER_IMPORT.test(source);
}

function apiSegments(path: string): string[] {
  const segments = path.split('/').filter(Boolean);
  return segments[0] === 'api' ? segments.slice(1) : segments;
}

const DEFAULT_RULES: ReadonlyArray<{
  reason: string;
  test(subject: ExclusionSubject, segments: ReadonlyArray<string>): boolean;
}> = [
  { reason: 'auth-route', test: (_subject, segments) => segments[0] === 'auth' },
  { reason: 'webhook', test: (_subject, segments) => segments.some((segment) => /webhook/i.test(segment)) },
  { reason: 'cron', test: (_subject, segments) => segments.some((segment) => /^crons?$/i.test(segment)) },
  { reason: 'callback', test: (_subject, segments) => segments.some((segment) => /callbacks?$/i.test(segment)) },
  {
    reason: 'health',
    test: (_subject, segments) => segments.some((segment) => /^(?:health|healthz|healthcheck|livez|readyz)$/i.test(segment)),
  },
  { reason: 'catch-all', test: (_subject, segments) => segments.some((segment) => segment.startsWith('*')) },
  // Any segment: chat and speech handlers often live under a namespace such as /api/ai/.
  {
    reason: 'chat-handler',
    test: (subject, segments) => subject.chatHandler || segments.some((segment) => /^chat(?:-v\d+)?$/i.test(segment)),
  },
  {
    reason: 'stt-handler',
    test: (_subject, segments) => segments.some((segment) => (
      /^(?:stt|speech(?:-[a-z]+)*|transcribe|transcriptions?)$/i.test(segment)
    )),
  },
];

function globMatches(pattern: ReadonlyArray<string>, path: ReadonlyArray<string>): boolean {
  if (pattern.length === 0) return path.length === 0;
  const [head, ...rest] = pattern;
  if (head === '**') {
    for (let index = 0; index <= path.length; index += 1) {
      if (globMatches(rest, path.slice(index))) return true;
    }
    return false;
  }
  if (path.length === 0) return false;
  return (head === '*' || head === path[0]) && globMatches(rest, path.slice(1));
}

/**
 * `[METHOD|*] /path/glob` with `*` for one segment and `**` for any number of
 * segments. A pattern outside the grammar (see `parseExcludePattern`, which
 * the policy file schema enforces) matches nothing.
 */
export function matchesExcludePattern(
  pattern: string,
  subject: Pick<ExclusionSubject, 'method' | 'path'>,
): boolean {
  const parsed = parseExcludePattern(pattern);
  if (!parsed) return false;
  if (parsed.method && parsed.method !== subject.method) return false;
  return globMatches(parsed.segments, subject.path.split('/').filter(Boolean));
}

export function findExclusion(
  subject: ExclusionSubject,
  policyExcludes: ReadonlyArray<PolicyExcludeRule>,
): ExcludedTool | undefined {
  const segments = apiSegments(subject.path);
  const rule = DEFAULT_RULES.find((candidate) => candidate.test(subject, segments));
  if (rule) return { stableKey: subject.stableKey, reason: rule.reason, origin: 'default' };
  const policy = policyExcludes.find((entry) => matchesExcludePattern(entry.match, subject));
  return policy ? { stableKey: subject.stableKey, reason: policy.reason, origin: 'policy' } : undefined;
}
