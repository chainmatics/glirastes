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
  /** `pass`: served or copied by a script; `unverifiable`: an absolute URL; `missing`: neither. */
  status: 'pass' | 'unverifiable' | 'missing';
}

/**
 * Offline: voice input is in use and the audio worklet is served, either as
 * `public/audio-worklet-processor.js` (or a configured `workletUrl` path under
 * `public/`) or through a package.json script that copies it.
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

  const scripts = files.find((file) => file.path === 'package.json')?.text ?? '';
  if (scripts.includes(AUDIO_WORKLET_COMMAND) || scripts.includes(AUDIO_WORKLET_FILE)) {
    return { voice, status: 'pass' };
  }

  const urls = new Set<string>();
  for (const file of glirastesFiles) {
    for (const match of file.text.matchAll(WORKLET_URL_LITERAL)) urls.add(match[2]!);
  }
  const publicDir = join(root, 'public');
  const servedAt = (url: string) => {
    const path = resolve(publicDir, `.${url.split(/[?#]/)[0]}`);
    return (path === publicDir || path.startsWith(`${publicDir}${sep}`)) && existsSync(path);
  };
  if (servedAt(`/${AUDIO_WORKLET_FILE}`)) return { voice, status: 'pass' };
  const own = [...urls];
  if (own.some((url) => url.startsWith('/') && !url.startsWith('//') && servedAt(url))) {
    return { voice, status: 'pass' };
  }
  if (own.some((url) => /^(?:[a-z][a-z0-9+.-]*:)?\/\//i.test(url))) return { voice, status: 'unverifiable' };
  return { voice, status: 'missing' };
}
