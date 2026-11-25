import { SDK_VERSION } from '../../../runtime/sdk-version.js';
import { readBaseline } from './baseline.js';
import { evaluateNote, scanApp, type AppScan } from './detect.js';
import { compareVersions, findPackageUpgradeNotesDir, loadUpgradeNoteSet } from './notes.js';

export interface OfferItem {
  id: string;
  version: string;
  summary: string;
  howTo: string;
  skill: string;
  /** The note names no `adoptedWhen`, so it stays listed even once the app uses it. */
  undetectable: boolean;
  deferred?: true;
}

export interface OffersList {
  to: string;
  since?: string;
  offers: OfferItem[];
}

export interface OffersOptions {
  rootDir: string;
  sdkVersion?: string;
  notesDir?: string;
  /** Only notes of versions after this one. */
  since?: string;
  scan?: (root: string) => Promise<AppScan>;
}

/**
 * Every optional feature up to the installed SDK that the app does not use
 * yet, newest first. Stateless: nothing is stored at ack, detection decides,
 * so the list never needs a merge and always matches the code.
 */
export async function createOffersList(options: OffersOptions): Promise<OffersList> {
  const to = options.sdkVersion ?? SDK_VERSION;
  const { notes } = await loadUpgradeNoteSet(options.notesDir ?? findPackageUpgradeNotesDir(), to);
  const candidates = notes.filter(
    (note) =>
      note.kind === 'optional' &&
      compareVersions(note.version, to) <= 0 &&
      (options.since === undefined || compareVersions(note.version, options.since) > 0),
  );
  const deferred = (await readBaseline(options.rootDir))?.decisions ?? {};
  const scan = candidates.length > 0 ? await (options.scan ?? scanApp)(options.rootDir) : undefined;
  const offers: OfferItem[] = [];
  for (const note of candidates) {
    if (evaluateNote(note, scan!).status === 'adopted') continue;
    offers.push({
      id: note.id,
      version: note.version,
      summary: note.summary,
      howTo: note.howTo,
      skill: note.skill,
      undetectable: note.adoptedWhen === undefined,
      ...(deferred[note.id] ? { deferred: true as const } : {}),
    });
  }
  offers.sort((a, b) => compareVersions(b.version, a.version) || a.id.localeCompare(b.id));
  return { to, ...(options.since ? { since: options.since } : {}), offers };
}

export function formatOffersList(list: OffersList): string {
  const range = list.since ? `after ${list.since} up to ${list.to}` : `up to ${list.to}`;
  if (list.offers.length === 0) return `No optional Glirastes features left to adopt (${range}).`;
  const lines = [`Optional Glirastes features this app does not use yet (${range}):`];
  let version = '';
  for (const offer of list.offers) {
    if (offer.version !== version) {
      version = offer.version;
      lines.push('', `${version}:`);
    }
    const marks = [offer.deferred ? 'deferred' : '', offer.undetectable ? 'use not detectable' : '']
      .filter(Boolean)
      .join(', ');
    lines.push(`- [${offer.id}] ${offer.summary}${marks ? ` [${marks}]` : ''} → ${offer.skill}`);
  }
  lines.push(
    '',
    'How to adopt one: --json (howTo) or the named skill. Listed until the app uses the feature;',
    '"use not detectable" ones stay listed. Nothing here blocks ack.',
  );
  return lines.join('\n');
}
