import { existsSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { scanApp, type AppScan } from './upgrade/detect.js';
import { AUDIO_WORKLET_COMMAND, AUDIO_WORKLET_FILE } from './stt/worklet.js';

/** Voice building blocks of glirastes; each one loads the audio worklet. */
const VOICE_SYMBOLS = /\b(?:VoiceInputAddon|VoiceInputButton|RecordedSttAdapter|DeepgramSttAdapter|useDeepgramTranscription|createPcmPipeline)\b/;
/** `voice={{ enabled: true }}` or `voice: { enabled: true }` on the chat. */
const VOICE_ENABLED = /\bvoice\s*[:=]\s*\{\{?[^{}]*\benabled\s*:\s*true\b/;
const WORKLET_URL_LITERAL = /\bworkletUrl\s*[:=]\s*\{?\s*(['"`])([^'"`\n]+)\1/g;

export interface VoiceWorkletInspection {
  /** A file that imports glirastes uses voice input. */
  voice: boolean;
  /**
   * `pass`: the file exists where the configured (or default) URL points;
   * `copy-pending`: a package.json script copies it into public/, but it is not there yet;
   * `unverifiable`: an absolute URL, or a copy step into another folder;
   * `missing`: none of these.
   */
  status: 'pass' | 'copy-pending' | 'unverifiable' | 'missing';
}

const ABSOLUTE_URL = /^(?:[a-z][a-z0-9+.-]*:)?\/\//i;

/** The package.json script values only; prose elsewhere in the manifest does not count. */
function scriptValues(manifest: string | undefined): string[] {
  if (!manifest) return [];
  try {
    const scripts = (JSON.parse(manifest) as { scripts?: unknown }).scripts;
    if (!scripts || typeof scripts !== 'object') return [];
    return Object.values(scripts).filter((value): value is string => typeof value === 'string');
  } catch {
    return [];
  }
}

/**
 * The folder a copy script writes to: the `--out` of `glirastes stt worklet`
 * (`public` without one), or `public` for an own copy command naming it.
 * `null` when the target is not known.
 */
function copyTarget(script: string): string | null {
  const at = script.indexOf(AUDIO_WORKLET_COMMAND);
  if (at < 0) return /(?:^|[\s/])public\/?(?:\s|$)/.test(script) ? 'public' : null;
  const call = script.slice(at + AUDIO_WORKLET_COMMAND.length).split(/&&|\|\||;|\|/)[0]!;
  const out = /(?:^|\s)--out(?:\s+|=)(['"]?)([^\s'"]+)\1/.exec(call);
  return out ? out[2]!.replace(/^\.\//, '').replace(/\/+$/, '') : 'public';
}

/**
 * Offline: voice input is in use and the audio worklet is served. It passes
 * only when the file exists under `public/` at every configured literal
 * `workletUrl` path, or at `/audio-worklet-processor.js` when none is set.
 */
export async function inspectVoiceWorklet(
  rootDir: string,
  scan?: AppScan,
): Promise<VoiceWorkletInspection> {
  const root = resolve(rootDir);
  const files = (scan ?? await scanApp(root)).files;
  const glirastesFiles = files.filter((file) => file.glirastesImports.length > 0);
  const voice = glirastesFiles.some((file) => VOICE_SYMBOLS.test(file.text) || VOICE_ENABLED.test(file.text));
  if (!voice) return { voice, status: 'missing' };

  const urls = new Set<string>();
  for (const file of glirastesFiles) {
    for (const match of file.text.matchAll(WORKLET_URL_LITERAL)) urls.add(match[2]!);
  }
  const configured = [...urls];
  if (configured.some((url) => ABSOLUTE_URL.test(url))) return { voice, status: 'unverifiable' };
  const targets = configured.filter((url) => url.startsWith('/'));
  if (targets.length === 0) targets.push(`/${AUDIO_WORKLET_FILE}`);

  const publicDir = join(root, 'public');
  const servedAt = (url: string) => {
    const path = resolve(publicDir, `.${url.split(/[?#]/)[0]}`);
    return (path === publicDir || path.startsWith(`${publicDir}${sep}`)) && existsSync(path);
  };
  if (targets.every(servedAt)) return { voice, status: 'pass' };

  const copies = scriptValues(files.find((file) => file.path === 'package.json')?.text)
    .filter((script) => script.includes(AUDIO_WORKLET_COMMAND) || script.includes(AUDIO_WORKLET_FILE));
  if (copies.length === 0) return { voice, status: 'missing' };
  const intoPublic = copies.some((script) => copyTarget(script) === 'public');
  return { voice, status: intoPublic ? 'copy-pending' : 'unverifiable' };
}
