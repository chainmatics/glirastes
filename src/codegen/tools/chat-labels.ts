import type { ToolTitle } from './types.js';

export interface Label {
  en: string;
  de: string;
}

const verb = (en: string, de: string): Label => Object.freeze({ en, de });
const SHOW = verb('Show', 'Anzeigen');
const CREATE = verb('Create', 'Erstellen');
const EDIT = verb('Edit', 'Bearbeiten');
const DELETE = verb('Delete', 'Löschen');
const REFRESH = verb('Refresh', 'Aktualisieren');
const DUPLICATE = verb('Duplicate', 'Duplizieren');
const SEARCH = verb('Search', 'Suchen');

export const VERBS: Readonly<Record<string, Label>> = Object.freeze({
  get: SHOW, show: SHOW, view: SHOW, list: SHOW, read: SHOW,
  check: verb('Check', 'Prüfen'),
  open: verb('Open', 'Öffnen'),
  create: CREATE, new: CREATE,
  add: verb('Add', 'Hinzufügen'),
  update: EDIT, edit: EDIT, change: EDIT,
  set: verb('Set', 'Setzen'),
  delete: DELETE, destroy: DELETE,
  remove: verb('Remove', 'Entfernen'),
  complete: verb('Complete', 'Erledigen'),
  archive: verb('Archive', 'Archivieren'),
  assign: verb('Assign', 'Zuweisen'),
  close: verb('Close', 'Schließen'),
  reopen: verb('Reopen', 'Wieder öffnen'),
  apply: verb('Apply', 'Anwenden'),
  switch: verb('Switch', 'Wechseln'),
  refresh: REFRESH, reload: REFRESH,
  restore: verb('Restore', 'Wiederherstellen'),
  duplicate: DUPLICATE, copy: DUPLICATE, clone: DUPLICATE,
  convert: verb('Convert', 'Umwandeln'),
  move: verb('Move', 'Verschieben'),
  share: verb('Share', 'Teilen'),
  invite: verb('Invite', 'Einladen'),
  send: verb('Send', 'Senden'),
  save: verb('Save', 'Speichern'),
  import: verb('Import', 'Importieren'),
  export: verb('Export', 'Exportieren'),
  upload: verb('Upload', 'Hochladen'),
  download: verb('Download', 'Herunterladen'),
  search: SEARCH, find: SEARCH,
  filter: verb('Filter', 'Filtern'),
  select: verb('Select', 'Auswählen'),
  toggle: verb('Toggle', 'Umschalten'),
  start: verb('Start', 'Starten'),
  stop: verb('Stop', 'Stoppen'),
  cancel: verb('Cancel', 'Abbrechen'),
  approve: verb('Approve', 'Freigeben'),
  reject: verb('Reject', 'Ablehnen'),
  publish: verb('Publish', 'Veröffentlichen'),
  sync: verb('Sync', 'Synchronisieren'),
  reset: verb('Reset', 'Zurücksetzen'),
  rename: verb('Rename', 'Umbenennen'),
  pin: verb('Pin', 'Anheften'),
  unpin: verb('Unpin', 'Lösen'),
  highlight: verb('Highlight', 'Hervorheben'),
});

function verbOf(word: string | undefined): Label | undefined {
  return word !== undefined && Object.hasOwn(VERBS, word) ? VERBS[word] : undefined;
}

const capitalize = (text: string) => (text ? text[0]!.toUpperCase() + text.slice(1) : text);

/** `taskCreateDialog.open` → `['task', 'create', 'dialog', 'open']`. */
export function identifierWords(value: string): string[] {
  return value
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[\s._/-]+/)
    .filter(Boolean)
    .map((word) => word.toLowerCase());
}

/** `my-tasks`, `myTasks`, `my_tasks` → `My tasks`. */
export function humanizeIdentifier(value: string): string {
  return capitalize(identifierWords(value).join(' '));
}

const IRREGULAR: Readonly<Record<string, string>> = Object.freeze({ people: 'person', children: 'child', men: 'man', women: 'woman' });

/** `tasks` → `task`, `categories` → `category`, `people` → `person`. */
export function singular(segment: string): string {
  const lower = segment.toLowerCase();
  if (Object.hasOwn(IRREGULAR, lower)) return IRREGULAR[lower]!;
  if (/ies$/i.test(segment)) return `${segment.slice(0, -3)}y`;
  if (/(?:ss|us|is)$/i.test(segment)) return segment;
  if (/(?:sses|xes|ches|shes)$/i.test(segment)) return segment.slice(0, -2);
  if (/s$/i.test(segment)) return segment.slice(0, -1);
  return segment;
}

/** English "Verb object", German "Object verb"; `undefined` without a known verb or fallback. */
export function phraseLabel(words: ReadonlyArray<string>, fallbackVerb?: string): Label | undefined {
  let object = [...words];
  let found = verbOf(object.at(-1));
  if (found) object = object.slice(0, -1);
  else if ((found = verbOf(object[0]))) object = object.slice(1);
  else found = verbOf(fallbackVerb);
  if (!found) return undefined;
  if (object.length === 0) return { en: found.en, de: found.de };
  const text = object.join(' ');
  return { en: `${found.en} ${text}`, de: `${capitalize(text)} ${found.de.toLowerCase()}` };
}

function withTitle(derived: Label, title: ToolTitle | undefined): Label {
  return { en: title?.en ?? derived.en, de: title?.de ?? derived.de };
}

const both = (text: string): Label => ({ en: text, de: text });

/** Label of a client-action command. */
export function commandLabel(id: string, title?: ToolTitle): Label {
  return withTitle(phraseLabel(identifierWords(id)) ?? both(humanizeIdentifier(id)), title);
}

const hasVerbAtEdge = (words: ReadonlyArray<string>) => verbOf(words.at(-1)) !== undefined || verbOf(words[0]) !== undefined;

function derivedActionLabel(definitionId: string, method: string | undefined, segment: string | undefined): Label {
  const tail = definitionId.split('.').at(-1)!;
  const tailWords = identifierWords(tail);
  if (tailWords.length > 1 && hasVerbAtEdge(tailWords)) return phraseLabel(tailWords)!;
  if (segment === undefined) return verbOf(tail) ?? both(humanizeIdentifier(tail));
  const words = identifierWords(segment);
  const verb = (name: string, list: ReadonlyArray<string> = words) => phraseLabel(list, name)!;
  if (words.length > 0 && hasVerbAtEdge(words)) return phraseLabel(words)!;
  const upper = method?.toUpperCase();
  if (upper === 'GET' || upper === 'HEAD') return verb('show');
  if (upper === 'DELETE') return verb('delete');
  const last = words.at(-1);
  const plural = last !== undefined && singular(last) !== last;
  if (plural && upper === 'POST') return verb('add', [...words.slice(0, -1), singular(last)]);
  if (plural && (upper === 'PUT' || upper === 'PATCH')) return verb('update');
  return both(humanizeIdentifier(segment));
}

/** Label of an entity action: the title per language, else a phrase from the id, the path and the method. */
export function actionLabel(input: { definitionId: string; method?: string; trailingSegment?: string; title?: ToolTitle }): Label {
  return withTitle(derivedActionLabel(input.definitionId, input.method, input.trailingSegment), input.title);
}
