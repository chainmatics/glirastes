import {
  createContext,
  forwardRef,
  useCallback,
  useContext,
  useEffect,
  useId,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type MouseEvent as ReactMouseEvent,
} from 'react';
import type {
  MentionData,
  MentionDropdownItemProps,
  MentionDropdownOptionProps,
  MentionResult,
  OpenCompletionOptions,
  RichMentionInputHandle,
  RichMentionInputProps,
} from '../types.js';
import { normalizeTrigger } from '../completions/triggers.js';
import { ChatContext } from '../provider/chat-context.js';
import { composerContextOf } from '../provider/composer-context.js';
import { sourceSearchOf } from '../completions/completion-search.js';
import {
  inferMentionPrefix,
  mentionDataFromResult,
  normalizeMentionSlug,
  toolReferenceFromDataset,
  toolReferenceToDataset,
} from '../utils/mention-markup.js';
import { fillTemplate } from '../utils/fill-template.js';
import { isImeKeyDown } from '../utils/ime.js';

const DEFAULT_TRIGGERS: ReadonlyArray<string> = ['@', '/'];
const SEARCH_DEBOUNCE_MS = 100;

/**
 * Picking a command leaves `/slug ` in the editor and picking a chip leaves a
 * text node that starts with a space. Under the default `white-space: normal`
 * the browser collapses that separator, so the next typed word merges into the
 * token and its structured id is lost. This is behaviour, not theming: it is
 * set inline so it also holds for BYOS and shadow-DOM consumers that do not
 * load styles.css.
 */
const EDITOR_STYLE: CSSProperties = { whiteSpace: 'pre-wrap' };

/** Announcements for screen readers only; behaviour, so it holds without styles.css. */
const VISUALLY_HIDDEN: CSSProperties = {
  position: 'absolute', width: 1, height: 1, margin: -1, padding: 0, overflow: 'hidden',
  clip: 'rect(0 0 0 0)', whiteSpace: 'nowrap', border: 0,
};

/**
 * The selection inside the editor's own tree. In a shadow root (the
 * `<glirastes-chat>` element) Chromium retargets `window.getSelection()` to
 * the host, so the caret position would be lost; its `ShadowRoot.getSelection()`
 * keeps the real nodes.
 */
function editorSelection(editor: HTMLElement | null): Selection | null {
  const root = editor?.getRootNode() as (Node & { getSelection?: () => Selection | null }) | undefined;
  if (root && root !== editor?.ownerDocument && typeof root.getSelection === 'function') {
    return root.getSelection() ?? window.getSelection();
  }
  return window.getSelection();
}

function normalizeInputValue(text: string): string {
  return text.replace(/\u00A0/g, ' ');
}

/** Any whitespace ends a word; Chrome types a trailing space as U+00A0 in contentEditable. */
function isSpace(char: string | undefined): boolean {
  return char !== undefined && /\s/.test(char);
}

/** `command` pills and `entity` pills are styled apart (`data-mention-kind`). */
function mentionKind(type: string): 'command' | 'entity' {
  return type === 'command' ? 'command' : 'entity';
}

/**
 * What `openCompletion` inserted and nobody touched since: closing the list
 * removes exactly this range again. `created`: the text node was made for it.
 */
interface ArmedCompletion {
  node: Text;
  start: number;
  text: string;
  created: boolean;
}

/** Text `completionPreset` put behind a trigger, untouched since: Backspace right behind it removes all of it. */
interface PresetText {
  node: Text;
  start: number;
  text: string;
}

/**
 * Internal: the handle `RichMentionInput` really has. `pickCompletion` applies
 * an entry as if it was picked from the `trigger` list at the caret
 * (`onCompletionSelect` first, then its `select` behavior); the composer's "+"
 * menu uses it. Not part of the public `RichMentionInputHandle`.
 */
export interface InternalRichMentionInputHandle extends RichMentionInputHandle {
  pickCompletion: (item: MentionResult, options: { trigger: string }) => void;
}

/** `pickCompletion` of a handle when it is the built-in editor's. */
export function pickCompletionOf(handle: RichMentionInputHandle | null | undefined): InternalRichMentionInputHandle['pickCompletion'] | undefined {
  const pick = (handle as Partial<InternalRichMentionInputHandle> | null | undefined)?.pickCompletion;
  return typeof pick === 'function' ? pick : undefined;
}

/**
 * The typed trigger and query, so they can be found again after an app
 * handler rebuilt the nodes (`setText`, `appendText`) or split them
 * (`insertMention`).
 */
interface TextSnapshot {
  text: string;
  /** A live range over the text: it follows text a handler inserts before it. */
  range?: Range;
}

function textNodesOf(editor: HTMLElement): Text[] {
  const walker = editor.ownerDocument.createTreeWalker(editor, NodeFilter.SHOW_TEXT);
  const nodes: Text[] = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) nodes.push(node as Text);
  return nodes;
}

function inChip(node: Node): boolean {
  return !!node.parentElement?.closest('[data-component="mention-chip"]');
}

/** Deletes `length` characters at `local` and one of two spaces that then meet. */
function deleteTextAt(node: Text, local: number, length: number): { node: Text; offset: number } {
  node.deleteData(local, length);
  if (local > 0 && isSpace(node.data[local - 1]) && isSpace(node.data[local])) node.deleteData(local, 1);
  return { node, offset: local };
}

/**
 * Removes the typed trigger and query after a handled pick, wherever the
 * app's handler moved them: (1) the live range when it still spans exactly
 * the text (handlers that insert before it), else (2) the text when it occurs
 * exactly once outside pills as a whole word (a space, the start or the end
 * of a text node on both sides). Zero or several matches delete nothing, so
 * text the handler put in (`#bug-7` for `#bu`) is never cut.
 */
function removeTypedTrigger(editor: HTMLElement, snapshot: TextSnapshot): { node: Text; offset: number } | null {
  const { range } = snapshot;
  if (
    range && !range.collapsed
    && range.startContainer === range.endContainer
    && range.startContainer.nodeType === Node.TEXT_NODE
    && editor.contains(range.startContainer)
    && range.toString() === snapshot.text
    && !inChip(range.startContainer)
  ) {
    return deleteTextAt(range.startContainer as Text, range.startOffset, snapshot.text.length);
  }
  let found: { node: Text; local: number } | null = null;
  for (const node of textNodesOf(editor)) {
    if (inChip(node)) continue;
    for (let local = node.data.indexOf(snapshot.text); local >= 0; local = node.data.indexOf(snapshot.text, local + 1)) {
      const end = local + snapshot.text.length;
      if (local > 0 && !isSpace(node.data[local - 1])) continue;
      if (end < node.length && !isSpace(node.data[end])) continue;
      if (found) return null;
      found = { node, local };
    }
  }
  return found ? deleteTextAt(found.node, found.local, snapshot.text.length) : null;
}

function liveRange(node: Text, start: number, end: number): Range {
  const range = node.ownerDocument.createRange();
  range.setStart(node, start);
  range.setEnd(node, end);
  return range;
}

function isChip(node: Node | null | undefined): node is HTMLElement {
  return !!node && node.nodeType === Node.ELEMENT_NODE && !!(node as HTMLElement).dataset?.mentionId;
}

function isBlankText(node: Node): boolean {
  return node.nodeType === Node.TEXT_NODE && (node.textContent ?? '').replace(/\u200B/g, '') === '';
}

/** The pill directly before or after a collapsed caret, skipping empty text nodes. */
function adjacentChip(range: Range, editor: HTMLElement, side: 'before' | 'after'): HTMLElement | null {
  const { startContainer: node, startOffset: offset } = range;
  let sibling: Node | null = null;
  if (node.nodeType === Node.TEXT_NODE) {
    const text = (node.textContent ?? '');
    const atEdge = side === 'before'
      ? text.slice(0, offset).replace(/\u200B/g, '') === ''
      : text.slice(offset).replace(/\u200B/g, '') === '';
    if (!atEdge) return null;
    sibling = side === 'before' ? node.previousSibling : node.nextSibling;
  } else if (node === editor) {
    sibling = side === 'before' ? editor.childNodes[offset - 1] ?? null : editor.childNodes[offset] ?? null;
  } else {
    return null;
  }
  while (sibling && isBlankText(sibling)) {
    sibling = side === 'before' ? sibling.previousSibling : sibling.nextSibling;
  }
  return isChip(sibling) && editor.contains(sibling) ? sibling : null;
}

function charBefore(range: Range, editor: HTMLElement): string {
  const probe = document.createRange();
  probe.selectNodeContents(editor);
  probe.setEnd(range.startContainer, range.startOffset);
  const fragment = probe.cloneContents();
  const last = fragment.lastChild;
  if (!last) return '';
  if (last.nodeType === Node.ELEMENT_NODE) return isChip(last) ? 'x' : (last.textContent ?? '').slice(-1);
  return (last.textContent ?? '').slice(-1);
}

function charAfter(range: Range, editor: HTMLElement): string {
  const probe = document.createRange();
  probe.selectNodeContents(editor);
  probe.setStart(range.endContainer, range.endOffset);
  const first = probe.cloneContents().firstChild;
  if (!first) return '';
  if (first.nodeType === Node.ELEMENT_NODE) return isChip(first) ? 'x' : (first.textContent ?? '').slice(0, 1);
  return (first.textContent ?? '').slice(0, 1);
}

// ---------------------------------------------------------------------------
// Default dropdown item (data-attribute driven, no hardcoded styles)
// ---------------------------------------------------------------------------

/** True while the active entry was set by the pointer: the default item does not scroll it into view. */
const PointerActiveContext = createContext(false);

/** Index and action (-1: the result itself) of an option id of this list, or null. */
function parseOptionId(id: string, prefix: string): { index: number; action: number } | null {
  if (!id.startsWith(prefix)) return null;
  const match = /^(\d+)(?:-action-(\d+))?$/.exec(id.slice(prefix.length));
  if (!match) return null;
  return { index: Number(match[1]), action: match[2] === undefined ? -1 : Number(match[2]) };
}

function DefaultDropdownItem({ result, isSelected, onClick, optionProps }: MentionDropdownItemProps) {
  const itemRef = useRef<HTMLButtonElement>(null);
  // Standalone (outside a provider) there is no `composer.renderIcon`: no icon, as before.
  const renderIcon = composerContextOf(useContext(ChatContext)).composer?.renderIcon;
  const icon = result.icon && renderIcon ? renderIcon(result.icon, { type: result.type }) : null;
  const pointerActive = useContext(PointerActiveContext);

  useEffect(() => {
    // The row under the pointer is visible already; scrolling it would move the list under the pointer.
    if (isSelected && !pointerActive && itemRef.current) {
      itemRef.current.scrollIntoView({ block: 'nearest' });
    }
  }, [isSelected]);

  return (
    <button
      ref={itemRef}
      type="button"
      {...optionProps}
      onClick={onClick}
      data-component="mention-dropdown-item"
      data-mention-type={result.type}
      data-mention-select={result.select === 'query' ? 'query' : undefined}
      data-selected={isSelected ? 'true' : 'false'}
    >
      {icon !== null && icon !== undefined && <span data-element="icon" aria-hidden="true">{icon}</span>}
      <span data-element="label">{result.label}</span>
      {result.description && (
        <span data-element="description">{result.description}</span>
      )}
    </button>
  );
}

// ---------------------------------------------------------------------------
// RichMentionInput
// ---------------------------------------------------------------------------

export const RichMentionInput = forwardRef<RichMentionInputHandle, RichMentionInputProps>(
  function RichMentionInput(
    {
      value,
      defaultValue = '',
      placeholder,
      disabled = false,
      className,
      wrapperClassName,
      onChange,
      onSubmit,
      onSearch,
      initialMentions,
      triggers: triggerConfig = DEFAULT_TRIGGERS,
      components,
      onEntityAction,
      onCompletionSelect,
      listLabel = 'Suggestions',
      resultsLabel = '{count} suggestions',
      commandPills = true,
      removeMentionLabel = 'Remove {label}',
      emptyLabel,
      onFiles,
      onBackspaceEmpty,
      allowEmptySubmit = false,
      onListOpenChange,
      completionPreset,
      placeholderOnFocus = true,
    },
    ref,
  ) {
    const [dragOver, setDragOver] = useState(false);
    // Each trigger char with its pill prefix; `select` is kept for the pick behavior.
    // An invalid entry throws, as on the provider.
    const triggers = useMemo(
      () => new Map(triggerConfig.map((trigger) => {
        const resolved = normalizeTrigger(trigger);
        return [resolved.char, resolved] as const;
      })),
      [triggerConfig],
    );
    const hasMentionSupport = typeof onSearch === 'function';
    const isControlled = value !== undefined;
    const [internalValue, setInternalValue] = useState(defaultValue);
    const editableRef = useRef<HTMLDivElement>(null);
    const dropdownRef = useRef<HTMLDivElement>(null);

    // Mention autocomplete state
    const [mentions, setMentions] = useState<MentionData[]>([]);
    const [dropdownOpen, setDropdownOpen] = useState(false);
    const [searchResults, setSearchResults] = useState<MentionResult[]>([]);
    const [noMatches, setNoMatches] = useState(false);
    const [selectedIndex, setSelectedIndex] = useState(0);
    // -1: the result itself; 0..n: one of its entity actions.
    const [selectedAction, setSelectedAction] = useState(-1);
    // Who set the active entry: the pointer (real movement over a row) or the keyboard (and resets).
    const [activeSource, setActiveSource] = useState<'keyboard' | 'pointer'>('keyboard');
    // Last pointer position seen over the list, with the results it was seen over: a position from
    // another result list (the list reopened or its results changed) counts as none, so the next event
    // only records it (a list appearing under a resting pointer activates nothing).
    const lastPointRef = useRef<{ x: number; y: number; results: MentionResult[] } | null>(null);
    // Set by the first `pointermove`: from then on mouse moves are compatibility events and skipped.
    const pointerEventsSeenRef = useRef(false);
    const [isSearching, setIsSearching] = useState(false);

    // `onListOpenChange` on every change of the shown list, not on mount (closed).
    const listShown = hasMentionSupport && dropdownOpen && searchResults.length > 0;
    const listShownRef = useRef(false);
    const onListOpenChangeRef = useRef(onListOpenChange);
    onListOpenChangeRef.current = onListOpenChange;
    useEffect(() => {
      if (listShownRef.current === listShown) return;
      listShownRef.current = listShown;
      onListOpenChangeRef.current?.(listShown);
    }, [listShown]);
    const listboxId = useId();
    const [isFocused, setIsFocused] = useState(false);

    // Refs for stale-closure avoidance and debounce
    const searchTimeoutRef = useRef<ReturnType<typeof setTimeout>>(undefined);
    const searchVersionRef = useRef(0);
    // Set by `openCompletion({ source })`: the providers searched until the list closes.
    const sourceRef = useRef<string | ReadonlyArray<string> | undefined>(undefined);
    const lastSearchRef = useRef<{ query: string; trigger: string }>({ query: '', trigger: '' });
    // Set by `openCompletion` until the user types or picks.
    const armedRef = useRef<ArmedCompletion | null>(null);
    // Set while `onCompletionSelect` runs: `openCompletion` calls wait here until the pick cleaned up.
    const pickQueueRef = useRef<OpenCompletionOptions[] | null>(null);
    const openCompletionRef = useRef<((options: OpenCompletionOptions) => void) | null>(null);
    const warnedTriggersRef = useRef(new Set<string>());
    const isInitializedRef = useRef(false);
    // `completionPreset`: read when a trigger is typed; the untouched preset text; the trigger occurrence
    // already decided (preset or declined), so a trigger left bare by Backspace is not preset again.
    const completionPresetRef = useRef(completionPreset);
    completionPresetRef.current = completionPreset;
    const presetRef = useRef<PresetText | null>(null);
    const presetSeenRef = useRef<{ node: Text; pos: number } | null>(null);

    const DropdownItem = components?.DropdownItem ?? DefaultDropdownItem;
    const currentValue = isControlled ? value : internalValue;

    // -----------------------------------------------------------------------
    // Shared helpers
    // -----------------------------------------------------------------------

    const setValue = useCallback(
      (nextValue: string) => {
        if (!isControlled) {
          setInternalValue(nextValue);
        }
        onChange?.(nextValue);
      },
      [isControlled, onChange],
    );

    // -----------------------------------------------------------------------
    // Plain-mode: sync controlled value to DOM
    // -----------------------------------------------------------------------

    useEffect(() => {
      if (hasMentionSupport) return;
      if (!editableRef.current) return;
      const nextText = currentValue ?? '';
      if (editableRef.current.textContent !== nextText) {
        editableRef.current.textContent = nextText;
      }
    }, [currentValue, hasMentionSupport]);

    // -----------------------------------------------------------------------
    // Mention-mode helpers
    // -----------------------------------------------------------------------

    /** Extract plain text from contentEditable, skipping chip elements. */
    const getTextContent = useCallback((): string => {
      if (!editableRef.current) return '';
      let text = '';
      for (const node of editableRef.current.childNodes) {
        if (node.nodeType === Node.TEXT_NODE) {
          text += node.textContent || '';
        } else if (node.nodeType === Node.ELEMENT_NODE) {
          const el = node as HTMLElement;
          if (!el.dataset.mentionId) {
            text += el.textContent || '';
          }
        }
      }
      return text.replace(/\u200B/g, '');
    }, []);

    // The placeholder shows while the editor is empty, also with focus: typing, a pick or `setValue`
    // change the DOM without a render, so a change of emptiness renders again.
    const [, renderEmptiness] = useState(true);
    useEffect(() => {
      const editor = editableRef.current;
      if (!hasMentionSupport || !editor || typeof MutationObserver === 'undefined') return;
      const observer = new MutationObserver(() => {
        renderEmptiness(getTextContent() === '' && !editor.querySelector('[data-mention-id]'));
      });
      observer.observe(editor, { childList: true, characterData: true, subtree: true });
      return () => observer.disconnect();
    }, [hasMentionSupport, getTextContent]);

    /** Build full value including `prefix+slug` tokens for each chip. */
    const getFullValue = useCallback((): string => {
      if (!editableRef.current) return '';
      let result = '';
      for (const node of editableRef.current.childNodes) {
        if (node.nodeType === Node.TEXT_NODE) {
          result += node.textContent || '';
        } else if (node.nodeType === Node.ELEMENT_NODE) {
          const el = node as HTMLElement;
          if (el.dataset.mentionId && el.dataset.mentionPrefix && el.dataset.mentionSlug) {
            result += `${el.dataset.mentionPrefix}${el.dataset.mentionSlug}`;
          } else {
            result += el.textContent || '';
          }
        }
      }
      return result.replace(/\u200B/g, '').replace(/\s+/g, ' ').trim();
    }, []);

    /** Read structured mention data from DOM chip elements. */
    const getMentionsFromDOM = useCallback((): MentionData[] => {
      if (!editableRef.current) return [];
      const result: MentionData[] = [];
      for (const node of editableRef.current.childNodes) {
        if (node.nodeType === Node.ELEMENT_NODE) {
          const el = node as HTMLElement;
          if (el.dataset.mentionId && el.dataset.mentionType) {
            result.push({
              id: el.dataset.mentionId,
              type: el.dataset.mentionType,
              label: el.dataset.mentionLabel || el.dataset.mentionId,
              slug: el.dataset.mentionSlug,
              prefix: el.dataset.mentionPrefix,
              displayName: el.dataset.mentionLabel,
              ...toolReferenceFromDataset(el.dataset),
            });
          }
        }
      }
      return result;
    }, []);

    /**
     * Create a DOM `<span>` chip element for a mention.
     *
     * The element mirrors the data-attribute structure of `<MentionChip>`
     * so the same CSS selectors work for both inline and standalone chips.
     */
    const createChipElement = useCallback((mention: MentionData): HTMLSpanElement => {
      const prefix =
        typeof mention.prefix === 'string'
          ? mention.prefix
          : inferMentionPrefix(mention.type);
      const slug =
        typeof mention.slug === 'string' && mention.slug.trim().length > 0
          ? mention.slug.trim()
          : normalizeMentionSlug(mention.label);
      const displayName =
        typeof mention.displayName === 'string'
          ? mention.displayName
          : mention.label;

      const chip = document.createElement('span');
      chip.contentEditable = 'false';
      chip.dataset.component = 'mention-chip';
      chip.dataset.mentionType = mention.type;
      chip.dataset.mentionId = mention.id;
      chip.dataset.mentionSlug = slug;
      chip.dataset.mentionLabel = displayName;
      chip.dataset.mentionPrefix = prefix;
      chip.dataset.mentionKind = mentionKind(mention.type);
      chip.dataset.size = 'inline';
      // A command's definition id and arguments stay on its chip, so the
      // entry read back from the editor (getMentions, drafts) still has them.
      const toolReference = toolReferenceToDataset(mention);
      if (toolReference) {
        chip.dataset.mentionDefinitionId = toolReference.definitionId;
        if (toolReference.args !== undefined) chip.dataset.mentionArgs = toolReference.args;
      }

      const prefixSpan = document.createElement('span');
      prefixSpan.dataset.element = 'prefix';
      prefixSpan.textContent = prefix;

      const nameSpan = document.createElement('span');
      nameSpan.dataset.element = 'display-name';
      nameSpan.textContent = displayName;

      const removeBtn = document.createElement('span');
      removeBtn.dataset.action = 'remove-mention';
      removeBtn.dataset.mentionId = mention.id;
      removeBtn.setAttribute('role', 'button');
      removeBtn.setAttribute('aria-label', fillTemplate(removeMentionLabel, { label: displayName }));
      removeBtn.textContent = '\u00D7';
      removeBtn.style.cursor = 'pointer';

      chip.appendChild(prefixSpan);
      chip.appendChild(nameSpan);
      chip.appendChild(removeBtn);

      return chip;
    }, [removeMentionLabel]);

    // -----------------------------------------------------------------------
    // Dropdown helpers
    // -----------------------------------------------------------------------

    const closeDropdown = useCallback(() => {
      // A debounced search still pending must not reopen the list.
      clearTimeout(searchTimeoutRef.current);
      searchVersionRef.current++;
      sourceRef.current = undefined;
      setDropdownOpen(false);
      setSearchResults([]);
      setNoMatches(false);
      setSelectedIndex(0);
      setSelectedAction(-1);
      setActiveSource('keyboard');
    }, []);

    /**
     * Removes the untouched text of `openCompletion` and puts the caret back
     * where it was (only while the editor has focus). True when removed.
     */
    const removeArmed = useCallback((): boolean => {
      const armed = armedRef.current;
      armedRef.current = null;
      const editor = editableRef.current;
      if (!armed || !editor || !editor.contains(armed.node)) return false;
      const { node, start, text, created } = armed;
      if (node.data.slice(start, start + text.length) !== text) return false;
      node.deleteData(start, text.length);
      const caret = document.createRange();
      const parent = node.parentNode!;
      if (created && node.length === 0) {
        caret.setStart(parent, Array.prototype.indexOf.call(parent.childNodes, node));
        node.remove();
      } else {
        caret.setStart(node, start);
      }
      caret.collapse(true);
      const root = editor.getRootNode() as Document | ShadowRoot;
      if (root.activeElement === editor) {
        const selection = editorSelection(editor);
        selection?.removeAllRanges();
        selection?.addRange(caret);
      }
      onChange?.(getFullValue());
      return true;
    }, [onChange, getFullValue]);

    /** Closing the list without a pick (Escape, outside click, blur) also removes untouched `openCompletion` text. */
    const dismissDropdown = useCallback(() => {
      removeArmed();
      closeDropdown();
    }, [removeArmed, closeDropdown]);

    const performSearch = useCallback(
      async (query: string, trigger: string, source?: string | ReadonlyArray<string>) => {
        if (!onSearch) return;
        const version = ++searchVersionRef.current;
        lastSearchRef.current = { query, trigger };
        setIsSearching(true);
        try {
          // A source narrows only a search from `createCompletionSearch` (the composer's); any other `onSearch` gets all entries.
          const narrowed = source === undefined ? undefined : sourceSearchOf(onSearch);
          if (source !== undefined && !narrowed && !warnedTriggersRef.current.has('\u0000source')) {
            warnedTriggersRef.current.add('\u0000source');
            console.warn('[glirastes] openCompletion: source narrows only a search from createCompletionSearch; listing all entries.');
          }
          const results = await (narrowed ? narrowed(query, trigger, source) : onSearch(query, trigger));
          if (searchVersionRef.current !== version) return;
          // A list opened by `openCompletion` that finds nothing goes away with its text.
          const removed = results.length === 0 && removeArmed();
          if (removed) sourceRef.current = undefined;
          setSearchResults(results);
          setSelectedIndex(0);
          setSelectedAction(-1);
          setActiveSource('keyboard');
          setDropdownOpen(results.length > 0);
          setNoMatches(results.length === 0 && !removed);
        } catch {
          if (searchVersionRef.current !== version) return;
          if (removeArmed()) sourceRef.current = undefined;
          setSearchResults([]);
          setActiveSource('keyboard');
          setDropdownOpen(false);
          setNoMatches(false);
        } finally {
          if (searchVersionRef.current === version) {
            setIsSearching(false);
          }
        }
      },
      [onSearch, removeArmed],
    );

    /**
     * Detect a trigger character before the cursor in the current text node.
     * Returns trigger, query, and position, or null if no trigger is active.
     */
    const detectTrigger = useCallback((): {
      trigger: string;
      query: string;
      triggerPos: number;
      node: Text;
    } | null => {
      const selection = editorSelection(editableRef.current);
      if (!selection || selection.rangeCount === 0) return null;

      const range = selection.getRangeAt(0);
      if (!range.collapsed || range.startContainer.nodeType !== Node.TEXT_NODE) return null;

      const textNode = range.startContainer as Text;
      const text = textNode.textContent || '';
      const cursorPos = range.startOffset;
      const before = text.slice(0, cursorPos);

      for (let i = before.length - 1; i >= 0; i--) {
        const char = before[i];
        if (isSpace(char)) break;
        if (triggers.has(char)) {
          if (i === 0 || isSpace(before[i - 1])) {
            return { trigger: char, query: before.slice(i + 1), triggerPos: i, node: textNode };
          }
        }
      }
      return null;
    }, [triggers]);

    // -----------------------------------------------------------------------
    // Mention insertion
    // -----------------------------------------------------------------------

    const insertMention = useCallback(
      (result: MentionResult): MentionData | null => {
        if (!editableRef.current) return null;

        const selection = editorSelection(editableRef.current);
        if (!selection || selection.rangeCount === 0) return null;

        const range = selection.getRangeAt(0);
        if (range.startContainer.nodeType !== Node.TEXT_NODE) return null;

        const textNode = range.startContainer as Text;
        const text = textNode.textContent || '';
        const cursorPos = range.startOffset;

        // Find the trigger position backward from cursor
        let triggerPos = -1;
        for (let i = cursorPos - 1; i >= 0; i--) {
          const char = text[i];
          if (isSpace(char)) break;
          if (triggers.has(char)) {
            if (i === 0 || isSpace(text[i - 1])) {
              triggerPos = i;
              break;
            }
          }
        }
        if (triggerPos === -1) return null;

        // The trigger the user typed: an entity found with `@` stays `@` whatever its type.
        const char = text[triggerPos]!;
        const prefix = result.type === 'command' ? '/' : triggers.get(char)?.prefix ?? char;
        const slug = typeof result.slug === 'string' && result.slug.trim().length > 0
          ? normalizeMentionSlug(result.slug)
          : normalizeMentionSlug(result.label);

        const mentionData = mentionDataFromResult(result, { prefix, slug });

        // Without command pills a command stays text, so arguments can be typed right behind it.
        if (result.type === 'command' && !commandPills) {
          const beforeText = text.slice(0, triggerPos);
          const afterText = text.slice(cursorPos);
          const token = `${prefix}${slug} `;
          textNode.textContent = beforeText + token + afterText;

          // The caret moves at once: keys typed right after the pick must land behind the token.
          const newRange = document.createRange();
          newRange.setStart(textNode, (beforeText + token).length);
          newRange.collapse(true);
          selection.removeAllRanges();
          selection.addRange(newRange);

          setMentions((prev) => [...prev, mentionData]);
          closeDropdown();
          requestAnimationFrame(() => {
            onChange?.(getFullValue());
          });
          return mentionData;
        }

        // Non-command: insert chip element
        const chip = createChipElement(mentionData);

        const beforeText = text.slice(0, triggerPos);
        const afterText = text.slice(cursorPos);

        const parent = textNode.parentNode;
        if (!parent) return null;

        const beforeNode = document.createTextNode(beforeText);
        const afterNode = document.createTextNode(' ' + afterText);

        parent.insertBefore(beforeNode, textNode);
        parent.insertBefore(chip, textNode);
        parent.insertBefore(afterNode, textNode);
        parent.removeChild(textNode);

        const newRange = document.createRange();
        newRange.setStart(afterNode, 1);
        newRange.collapse(true);
        selection.removeAllRanges();
        selection.addRange(newRange);
        editableRef.current?.focus();

        setMentions((prev) => [...prev, mentionData]);
        closeDropdown();
        requestAnimationFrame(() => {
          onChange?.(getFullValue());
        });
        return mentionData;
      },
      [triggers, commandPills, createChipElement, closeDropdown, onChange, getFullValue],
    );

    /**
     * The trigger and query before the caret are replaced by `replacement`
     * (plain text); the caret lands behind it. Null when no trigger is active.
     */
    const replaceQuery = useCallback((replacement: (char: string) => string): string | null => {
      const selection = editorSelection(editableRef.current);
      if (!selection || selection.rangeCount === 0) return null;
      const range = selection.getRangeAt(0);
      if (range.startContainer.nodeType !== Node.TEXT_NODE) return null;
      const textNode = range.startContainer as Text;
      const text = textNode.textContent || '';
      const cursorPos = range.startOffset;
      for (let i = cursorPos - 1; i >= 0; i--) {
        const char = text[i]!;
        if (isSpace(char)) break;
        if (triggers.has(char) && (i === 0 || isSpace(text[i - 1]))) {
          const inserted = replacement(char);
          textNode.textContent = text.slice(0, i) + inserted + text.slice(cursorPos);
          const caret = document.createRange();
          caret.setStart(textNode, i + inserted.length);
          caret.collapse(true);
          selection.removeAllRanges();
          selection.addRange(caret);
          return char;
        }
      }
      return null;
    }, [triggers]);

    /**
     * Puts a pill at the caret (or at the end when the caret is elsewhere),
     * with a space on both sides, and leaves the caret behind it.
     */
    const insertPill = useCallback((mention: MentionData) => {
      const editor = editableRef.current;
      if (!editor) return;
      // An `openCompletion` trigger nobody typed after gives way to the pill (else blur or send would act on it later).
      removeArmed();
      const selection = editorSelection(editor);
      let range: Range | null = null;
      if (selection && selection.rangeCount > 0 && editor.contains(selection.getRangeAt(0).startContainer)) {
        range = selection.getRangeAt(0).cloneRange();
      }
      if (!range) {
        range = document.createRange();
        range.selectNodeContents(editor);
        range.collapse(false);
      }
      const container = range.startContainer;
      const inChip = (container instanceof Element ? container : container.parentElement)?.closest('[data-component="mention-chip"]');
      if (inChip && editor.contains(inChip)) {
        range.setStartAfter(inChip);
        range.collapse(true);
      }
      range.deleteContents();
      const before = charBefore(range, editor);
      const after = charAfter(range, editor);
      const chip = createChipElement(mention);
      const trailing = document.createTextNode(after && /\s/.test(after) ? '' : ' ');
      const fragment = document.createDocumentFragment();
      if (before && !/\s/.test(before)) fragment.append(document.createTextNode(' '));
      fragment.append(chip, trailing);
      range.insertNode(fragment);
      const caret = document.createRange();
      caret.setStart(trailing, trailing.length);
      caret.collapse(true);
      selection?.removeAllRanges();
      selection?.addRange(caret);
      setMentions((prev) => [...prev, mention]);
      closeDropdown();
      onChange?.(getFullValue());
    }, [createChipElement, closeDropdown, onChange, getFullValue, removeArmed]);

    /** Removes the `@query` being typed and runs one of the result's entity actions instead. */
    const runAction = useCallback(
      (result: MentionResult, actionId: string) => {
        armedRef.current = null;
        const selection = editorSelection(editableRef.current);
        const range = selection && selection.rangeCount > 0 ? selection.getRangeAt(0) : null;
        if (range && range.startContainer.nodeType === Node.TEXT_NODE) {
          const textNode = range.startContainer as Text;
          const text = textNode.textContent || '';
          const cursorPos = range.startOffset;
          for (let i = cursorPos - 1; i >= 0; i--) {
            const char = text[i];
            if (isSpace(char)) break;
            if (triggers.has(char) && (i === 0 || isSpace(text[i - 1]))) {
              textNode.textContent = text.slice(0, i) + text.slice(cursorPos);
              // Replacing the data pulls the live range to offset 0: put the caret back where the `@query` was.
              range.setStart(textNode, i);
              range.collapse(true);
              selection?.removeAllRanges();
              selection?.addRange(range);
              break;
            }
          }
        }
        closeDropdown();
        onChange?.(getFullValue());
        onEntityAction?.(result, actionId);
      },
      [triggers, closeDropdown, onChange, getFullValue, onEntityAction],
    );

    // -----------------------------------------------------------------------
    // Event handlers
    // -----------------------------------------------------------------------

    /** The text `completionPreset` gives a bare trigger: no whitespace, else nothing. */
    const presetFor = useCallback((trigger: string): string | undefined => {
      const preset = completionPresetRef.current;
      if (typeof preset !== 'function') return undefined;
      try {
        const text = preset(trigger);
        return typeof text === 'string' && text.length > 0 && !/\s/.test(text) ? text : undefined;
      } catch {
        return undefined;
      }
    }, []);

    /**
     * A trigger just typed bare: puts its preset behind it (caret at the end)
     * and returns the query to search. Each trigger occurrence is preset once.
     */
    const applyPreset = useCallback((state: { trigger: string; triggerPos: number; node: Text }): string | null => {
      const seen = presetSeenRef.current;
      if (seen && seen.node === state.node && seen.pos === state.triggerPos) return null;
      presetSeenRef.current = { node: state.node, pos: state.triggerPos };
      const text = presetFor(state.trigger);
      if (!text) return null;
      const start = state.triggerPos + 1;
      state.node.insertData(start, text);
      const selection = editorSelection(editableRef.current);
      const caret = document.createRange();
      caret.setStart(state.node, start + text.length);
      caret.collapse(true);
      selection?.removeAllRanges();
      selection?.addRange(caret);
      presetRef.current = { node: state.node, start, text };
      return text;
    }, [presetFor]);

    // An IME composition is open (compositionstart … compositionend): no preset is put into it.
    const composingRef = useRef(false);

    const handleInput = useCallback((event?: { nativeEvent?: Event }) => {
      if (!hasMentionSupport) {
        const nextValue = normalizeInputValue(editableRef.current?.innerText ?? '');
        setValue(nextValue);
        return;
      }

      // Mention mode: what the user types keeps `openCompletion` text and a preset.
      armedRef.current = null;
      // The input event that ends an IME composition follows `compositionend`, which may have set
      // the preset: it stays untouched while its text and the caret behind it are unchanged.
      const kept = presetRef.current;
      const keptRange = kept ? editorSelection(editableRef.current) : null;
      const caret = keptRange && keptRange.rangeCount > 0 ? keptRange.getRangeAt(0) : null;
      const untouched = kept !== null && caret !== null && caret.collapsed && caret.startContainer === kept.node
        && caret.startOffset === kept.start + kept.text.length
        && kept.node.data.slice(kept.start, kept.start + kept.text.length) === kept.text;
      presetRef.current = untouched ? kept : null;
      const triggerState = detectTrigger();
      if (triggerState) {
        // Not under `openCompletion({ source })`: the preset searches the registry's types, not that source.
        // While an IME composes, the preset waits for compositionend.
        const composing = composingRef.current || (event?.nativeEvent as { isComposing?: boolean } | undefined)?.isComposing === true;
        const query = triggerState.query === '' && sourceRef.current === undefined && !composing
          ? applyPreset(triggerState) ?? ''
          : triggerState.query;
        clearTimeout(searchTimeoutRef.current);
        searchTimeoutRef.current = setTimeout(() => {
          void performSearch(query, triggerState.trigger, sourceRef.current);
        }, SEARCH_DEBOUNCE_MS);
      } else {
        presetSeenRef.current = null;
        clearTimeout(searchTimeoutRef.current);
        closeDropdown();
      }

      onChange?.(getFullValue());
    }, [hasMentionSupport, setValue, detectTrigger, applyPreset, performSearch, closeDropdown, onChange, getFullValue]);

    const handleCompositionStart = useCallback(() => {
      composingRef.current = true;
    }, []);

    /** The composition is committed: a trigger it left bare gets its preset now. */
    const handleCompositionEnd = useCallback(() => {
      composingRef.current = false;
      if (!hasMentionSupport || sourceRef.current !== undefined) return;
      const triggerState = detectTrigger();
      if (!triggerState || triggerState.query !== '') return;
      const query = applyPreset(triggerState);
      if (query === null) return;
      clearTimeout(searchTimeoutRef.current);
      searchTimeoutRef.current = setTimeout(() => {
        void performSearch(query, triggerState.trigger, sourceRef.current);
      }, SEARCH_DEBOUNCE_MS);
      onChange?.(getFullValue());
    }, [hasMentionSupport, detectTrigger, applyPreset, performSearch, onChange, getFullValue]);

    /** Backspace right behind an untouched preset: removes all of it, the bare trigger searches again. */
    const removePreset = useCallback((): boolean => {
      const preset = presetRef.current;
      presetRef.current = null;
      const editor = editableRef.current;
      if (!preset || !editor || !editor.contains(preset.node)) return false;
      const { node, start, text } = preset;
      const selection = editorSelection(editor);
      const range = selection && selection.rangeCount > 0 ? selection.getRangeAt(0) : null;
      if (
        !range || !range.collapsed || range.startContainer !== node || range.startOffset !== start + text.length
        || node.data.slice(start, start + text.length) !== text || !triggers.has(node.data[start - 1] ?? '')
      ) {
        return false;
      }
      node.deleteData(start, text.length);
      const armed = armedRef.current;
      if (armed && armed.node === node && armed.start + armed.text.length === start + text.length && armed.text.endsWith(text)) {
        armed.text = armed.text.slice(0, -text.length);
      }
      const caret = document.createRange();
      caret.setStart(node, start);
      caret.collapse(true);
      selection!.removeAllRanges();
      selection!.addRange(caret);
      clearTimeout(searchTimeoutRef.current);
      onChange?.(getFullValue());
      void performSearch('', node.data[start - 1]!, sourceRef.current);
      return true;
    }, [triggers, onChange, getFullValue, performSearch]);

    /**
     * Chips in the DOM plus text-inserted commands whose token is still
     * present. A command that was restored as a chip (setValue) is still in
     * the state too; the chip is its entry, so it is not listed twice.
     */
    const collectMentions = useCallback((text: string, inserted: ReadonlyArray<MentionData> = []): MentionData[] => {
      if (!hasMentionSupport) return [];
      const chips = getMentionsFromDOM();
      const chipped = new Set(chips.map((chip) => `${chip.type}\u0000${chip.id}`));
      const tokens = new Set(text.split(/\s+/));
      const commands = [...mentions, ...inserted].filter((mention) =>
        mention.type === 'command'
        && !chipped.has(`${mention.type}\u0000${mention.id}`)
        && typeof mention.prefix === 'string'
        && typeof mention.slug === 'string'
        && tokens.has(`${mention.prefix}${mention.slug}`));
      return [...chips, ...commands];
    }, [hasMentionSupport, mentions, getMentionsFromDOM]);

    /** `inserted`: mentions added in this tick, not yet in the `mentions` state (a `run` pick). */
    const submit = useCallback((inserted: ReadonlyArray<MentionData> = []) => {
      if (disabled) return;

      const text = hasMentionSupport
        ? getFullValue()
        : normalizeInputValue((editableRef.current?.innerText ?? '').trim());

      if (!text && !allowEmptySubmit) return;

      if (onSubmit?.(text, text ? collectMentions(text, inserted) : []) === false) return;
      armedRef.current = null;
      setValue('');
      if (hasMentionSupport) {
        setMentions([]);
      }
      if (editableRef.current) {
        editableRef.current.innerHTML = '';
      }
    }, [disabled, hasMentionSupport, getFullValue, onSubmit, setValue, collectMentions, allowEmptySubmit]);

    /**
     * The trigger and query before the caret (or the untouched `openCompletion`
     * text) as a snapshot, taken before the app's handler can change the editor.
     */
    const snapshotTrigger = useCallback((armed: ArmedCompletion | null): TextSnapshot | null => {
      const editor = editableRef.current;
      if (!editor) return null;
      if (armed && editor.contains(armed.node) && armed.node.data.slice(armed.start, armed.start + armed.text.length) === armed.text) {
        return { text: armed.text, range: liveRange(armed.node, armed.start, armed.start + armed.text.length) };
      }
      const selection = editorSelection(editor);
      if (!selection || selection.rangeCount === 0) return null;
      const range = selection.getRangeAt(0);
      if (range.startContainer.nodeType !== Node.TEXT_NODE || !editor.contains(range.startContainer)) return null;
      const node = range.startContainer as Text;
      const text = node.data;
      for (let i = range.startOffset - 1; i >= 0; i--) {
        const char = text[i]!;
        if (isSpace(char)) break;
        if (triggers.has(char) && (i === 0 || isSpace(text[i - 1]))) {
          return { text: text.slice(i, range.startOffset), range: liveRange(node, i, range.startOffset) };
        }
      }
      return null;
    }, [triggers]);

    /**
     * One entry of the list was picked: the app's handler first, then the
     * entry's `select` behavior. `fromCode` (`pickCompletion`): the trigger was
     * inserted armed for this pick; when nothing replaces it, it goes again.
     */
    const pickResult = useCallback((result: MentionResult, fromCode = false) => {
      const armed = armedRef.current;
      armedRef.current = null;
      const dropArmed = () => {
        if (!fromCode) return;
        armedRef.current = armed;
        removeArmed();
      };
      const active = detectTrigger() ?? lastSearchRef.current;
      const typed = onCompletionSelect ? snapshotTrigger(armed) : null;
      let handled = false;
      let deferred: OpenCompletionOptions[] = [];
      if (onCompletionSelect) {
        // `openCompletion` called inside the handler (a sub-list) runs once the pick has cleaned up.
        pickQueueRef.current = deferred;
        try {
          handled = onCompletionSelect(result, { trigger: active.trigger, query: active.query }) === true;
        } finally {
          deferred = pickQueueRef.current ?? [];
          pickQueueRef.current = null;
        }
      }
      const openDeferred = () => {
        for (const options of deferred) openCompletionRef.current?.(options);
      };
      if (handled) {
        // The app handled it: trigger and query (or the untouched `openCompletion` text) leave the
        // editor, found by the snapshot from before the handler (it may have rebuilt the text).
        const editor = editableRef.current;
        const removed = editor && typed ? removeTypedTrigger(editor, typed) : null;
        if (removed) {
          const selection = editorSelection(editor);
          const caret = document.createRange();
          caret.setStart(removed.node, removed.offset);
          caret.collapse(true);
          selection?.removeAllRanges();
          selection?.addRange(caret);
          onChange?.(getFullValue());
        }
        closeDropdown();
        openDeferred();
        return;
      }
      // Any other value (an own `onSearch` may return one) picks as `chip`.
      const kind = result.select ?? triggers.get(active.trigger)?.select ?? 'chip';
      if (kind === 'query') {
        // A refinement (`@<type>:`): the new query behind the trigger, no space, and the list searches it.
        const query = result.insertText ?? result.label;
        const char = replaceQuery((trigger) => `${trigger}${query}`);
        if (char === null) dropArmed();
        else {
          presetRef.current = null;
          clearTimeout(searchTimeoutRef.current);
          setSelectedIndex(0);
          setSelectedAction(-1);
          setActiveSource('keyboard');
          onChange?.(getFullValue());
          void performSearch(query, char, sourceRef.current);
        }
      } else if (kind === 'text') {
        if (replaceQuery(() => result.insertText ?? result.label) === null) dropArmed();
        else {
          closeDropdown();
          onChange?.(getFullValue());
        }
      } else {
        // `run` sends through the same path as Enter, so a disabled (streaming) composer sends nothing.
        const inserted = insertMention(result);
        if (!inserted) dropArmed();
        else if (kind === 'run') submit([inserted]);
      }
      openDeferred();
    }, [detectTrigger, snapshotTrigger, onCompletionSelect, closeDropdown, triggers, replaceQuery, onChange, getFullValue, insertMention, submit, removeArmed, performSearch]);

    const handleKeyDown = useCallback(
      (event: KeyboardEvent<HTMLDivElement>) => {
        // Keys of an IME composition belong to the IME: Enter commits the text and Tab or the arrows
        // pick a candidate, they neither send nor pick a list entry. Safari fires the committing
        // keydown after `compositionend`, flagged only by keyCode 229.
        if (isImeKeyDown(event) || composingRef.current) return;

        // Dropdown navigation (mention mode only)
        if (hasMentionSupport && dropdownOpen && searchResults.length > 0) {
          const actions = (onEntityAction && searchResults[selectedIndex]?.actions) || [];
          if (event.key === 'ArrowDown') {
            event.preventDefault();
            setSelectedIndex((prev) => (prev + 1) % searchResults.length);
            setSelectedAction(-1);
            setActiveSource('keyboard');
            return;
          }
          if (event.key === 'ArrowUp') {
            event.preventDefault();
            setSelectedIndex(
              (prev) => (prev - 1 + searchResults.length) % searchResults.length,
            );
            setSelectedAction(-1);
            setActiveSource('keyboard');
            return;
          }
          // Left/right move between a result and its actions; elsewhere they move the caret.
          if (event.key === 'ArrowRight' && selectedAction < actions.length - 1) {
            event.preventDefault();
            setSelectedAction((prev) => prev + 1);
            setActiveSource('keyboard');
            return;
          }
          if (event.key === 'ArrowLeft' && selectedAction >= 0) {
            event.preventDefault();
            setSelectedAction((prev) => prev - 1);
            setActiveSource('keyboard');
            return;
          }
          if (event.key === 'Tab' || (event.key === 'Enter' && !event.shiftKey)) {
            event.preventDefault();
            const selected = searchResults[selectedIndex];
            const action = selectedAction >= 0 ? actions[selectedAction] : undefined;
            if (selected && action) {
              runAction(selected, action.id);
            } else if (selected) {
              pickResult(selected);
            }
            return;
          }
          if (event.key === 'Escape') {
            event.preventDefault();
            dismissDropdown();
            return;
          }
        }

        if (event.key === 'Escape' && (noMatches || armedRef.current)) {
          event.preventDefault();
          dismissDropdown();
          return;
        }

        // Submit on Enter (both modes)
        if (event.key === 'Enter' && !event.shiftKey) {
          event.preventDefault();
          // A list opened by `openCompletion` whose results are not there yet: Enter
          // dismisses the untouched trigger instead of sending it bare.
          if (armedRef.current && removeArmed()) {
            closeDropdown();
            return;
          }
          submit();
          return;
        }

        if (event.key === 'Backspace' && hasMentionSupport && presetRef.current && removePreset()) {
          event.preventDefault();
          return;
        }

        if (event.key === 'Backspace' && onBackspaceEmpty) {
          const empty = hasMentionSupport
            ? getFullValue() === ''
            : (editableRef.current?.textContent ?? '') === '';
          if (empty) {
            event.preventDefault();
            onBackspaceEmpty();
            return;
          }
        }

        // Backspace and Delete remove a whole pill next to the caret (mention mode).
        if (hasMentionSupport && (event.key === 'Backspace' || event.key === 'Delete')) {
          const editor = editableRef.current;
          const selection = editorSelection(editor);
          if (editor && selection && selection.rangeCount > 0) {
            const range = selection.getRangeAt(0);
            const chip = range.collapsed
              ? adjacentChip(range, editor, event.key === 'Backspace' ? 'before' : 'after')
              : null;
            if (chip) {
              event.preventDefault();
              const mentionId = chip.dataset.mentionId!;
              const caret = document.createRange();
              if (event.key === 'Backspace') caret.setStartBefore(chip);
              else caret.setStartAfter(chip);
              caret.collapse(true);
              chip.remove();
              selection.removeAllRanges();
              selection.addRange(caret);
              setMentions((prev) => prev.filter((m) => m.id !== mentionId));
              onChange?.(getFullValue());
            }
          }
        }
      },
      [
        hasMentionSupport,
        dropdownOpen,
        searchResults,
        selectedIndex,
        selectedAction,
        onEntityAction,
        runAction,
        pickResult,
        dismissDropdown,
        removeArmed,
        closeDropdown,
        noMatches,
        submit,
        onChange,
        getFullValue,
        onBackspaceEmpty,
        removePreset,
      ],
    );

    /** Strip formatting on paste — insert plain text only; files go to `onFiles`. */
    const handlePaste = useCallback(
      (e: React.ClipboardEvent<HTMLDivElement>) => {
        const files = onFiles ? Array.from(e.clipboardData.files ?? []) : [];
        // Plain mode keeps the browser's own text paste unless files must stay out of the editor.
        if (!hasMentionSupport && files.length === 0) return;
        e.preventDefault();
        if (files.length > 0) onFiles!(files);
        const plainText = e.clipboardData.getData('text/plain');
        if (!plainText) return;

        const selection = editorSelection(editableRef.current);
        if (!selection || selection.rangeCount === 0) return;

        const range = selection.getRangeAt(0);
        range.deleteContents();
        const textNode = document.createTextNode(plainText);
        range.insertNode(textNode);
        range.setStartAfter(textNode);
        range.collapse(true);
        selection.removeAllRanges();
        selection.addRange(range);

        onChange?.(hasMentionSupport ? getFullValue() : normalizeInputValue(editableRef.current?.innerText ?? ''));
      },
      [onChange, getFullValue, onFiles, hasMentionSupport],
    );

    const fileDrag = (event: React.DragEvent) =>
      Boolean(onFiles) && Array.from(event.dataTransfer?.types ?? []).includes('Files');
    const handleDragOver = useCallback((event: React.DragEvent<HTMLDivElement>) => {
      if (!fileDrag(event) || disabled) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = 'copy';
      setDragOver(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [onFiles, disabled]);
    const handleDragLeave = useCallback(() => setDragOver(false), []);
    const handleDrop = useCallback((event: React.DragEvent<HTMLDivElement>) => {
      setDragOver(false);
      if (!fileDrag(event) || disabled) return;
      event.preventDefault();
      const files = Array.from(event.dataTransfer.files ?? []);
      if (files.length > 0) onFiles!(files);
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [onFiles, disabled]);

    // -----------------------------------------------------------------------
    // Side effects (mention mode)
    // -----------------------------------------------------------------------

    // Close dropdown on outside click. A layout effect, so the listener is in place in the same commit
    // that shows the list: a passive effect can run a frame later, and a press outside in between was lost.
    useLayoutEffect(() => {
      if (!dropdownOpen) return;

      const handleClickOutside = (e: MouseEvent) => {
        // Inside a shadow root (the `<glirastes-chat>` element) a document-level listener sees the host as
        // `e.target`, so the composed path is what tells a click on the list or the editor from an outside one.
        const path = e.composedPath();
        if (
          dropdownRef.current &&
          !path.includes(dropdownRef.current) &&
          editableRef.current &&
          !path.includes(editableRef.current)
        ) {
          dismissDropdown();
        }
      };

      document.addEventListener('mousedown', handleClickOutside);
      return () => document.removeEventListener('mousedown', handleClickOutside);
    }, [dropdownOpen, dismissDropdown]);

    // Chip removal via click delegation on the editable
    useEffect(() => {
      if (!hasMentionSupport) return;
      const el = editableRef.current;
      if (!el) return;

      const handleClick = (e: MouseEvent) => {
        const target = e.target as HTMLElement;
        const removeBtn = target.closest(
          '[data-action="remove-mention"]',
        ) as HTMLElement | null;
        if (removeBtn?.dataset.mentionId) {
          e.preventDefault();
          e.stopPropagation();
          const mentionId = removeBtn.dataset.mentionId;
          setMentions((prev) => prev.filter((m) => m.id !== mentionId));
          el.querySelector(`[data-mention-id="${CSS.escape(mentionId)}"]`)?.remove();
          onChange?.(getFullValue());
        }
      };

      el.addEventListener('click', handleClick);
      return () => el.removeEventListener('click', handleClick);
    }, [hasMentionSupport, onChange, getFullValue]);

    // Initialise with pre-filled mentions
    useEffect(() => {
      if (
        !hasMentionSupport ||
        isInitializedRef.current ||
        !editableRef.current ||
        !initialMentions?.length
      )
        return;
      isInitializedRef.current = true;

      const batch: MentionData[] = [];
      for (const mention of initialMentions) {
        const chip = createChipElement(mention);
        editableRef.current.appendChild(chip);
        batch.push(mention);
      }
      setMentions((prev) => [...prev, ...batch]);

      const space = document.createTextNode(' ');
      editableRef.current.appendChild(space);

      requestAnimationFrame(() => {
        if (editableRef.current) {
          const range = document.createRange();
          const selection = editorSelection(editableRef.current);
          range.selectNodeContents(editableRef.current);
          range.collapse(false);
          selection?.removeAllRanges();
          selection?.addRange(range);
        }
      });
      // eslint-disable-next-line react-hooks/exhaustive-deps -- createChipElement is stable
    }, [hasMentionSupport, initialMentions, createChipElement]);

    // Cleanup debounce timer on unmount
    useEffect(
      () => () => {
        clearTimeout(searchTimeoutRef.current);
      },
      [],
    );

    /**
     * Inserts `trigger` + `query` like typed (caret kept when the editor has
     * focus, else at the end; a space first after a non-space) and searches
     * at once. The text stays armed until the user types or picks.
     */
    const armTrigger = useCallback((trigger: unknown, query: string, caller: 'open' | 'pick'): string | null => {
      const editor = editableRef.current;
      // A locked editor (e.g. a turn without queue) takes no trigger text from code either.
      if (!hasMentionSupport || !editor || disabled) return null;
      if (typeof trigger !== 'string' || !triggers.has(trigger)) {
        const key = String(trigger);
        if (!warnedTriggersRef.current.has(key)) {
          warnedTriggersRef.current.add(key);
          // Static text only: the argument may come from app data (React diagnostics rule).
          if (caller === 'pick') console.warn('[glirastes] pickCompletion: the trigger is not one of this composer; nothing was picked.');
          else console.warn('[glirastes] openCompletion: the trigger is not one of this composer; nothing was opened.');
        }
        return null;
      }
      // A second call replaces the text of the first.
      removeArmed();
      const root = editor.getRootNode() as Document | ShadowRoot;
      const hadFocus = root.activeElement === editor;
      if (!hadFocus) editor.focus();
      const selection = editorSelection(editor);
      let range: Range | null = null;
      if (hadFocus && selection && selection.rangeCount > 0 && editor.contains(selection.getRangeAt(0).startContainer)) {
        range = selection.getRangeAt(0).cloneRange();
        range.collapse(false);
      }
      if (!range) {
        range = document.createRange();
        range.selectNodeContents(editor);
        range.collapse(false);
      }
      const container = range.startContainer;
      const inChip = (container instanceof Element ? container : container.parentElement)?.closest('[data-component="mention-chip"]');
      if (inChip && editor.contains(inChip)) {
        range.setStartAfter(inChip);
        range.collapse(true);
      }
      const before = charBefore(range, editor);
      const text = `${before && !isSpace(before) ? ' ' : ''}${trigger}${query}`;

      // Into a text node, so typing on and trigger detection work as if typed.
      let node: Text;
      let offset: number;
      let created = false;
      if (range.startContainer.nodeType === Node.TEXT_NODE) {
        node = range.startContainer as Text;
        offset = range.startOffset;
      } else {
        const parent = range.startContainer;
        const previous = parent.childNodes[range.startOffset - 1];
        const next = parent.childNodes[range.startOffset] ?? null;
        if (previous?.nodeType === Node.TEXT_NODE) {
          node = previous as Text;
          offset = node.length;
        } else if (next?.nodeType === Node.TEXT_NODE) {
          node = next as Text;
          offset = 0;
        } else {
          node = document.createTextNode('');
          parent.insertBefore(node, next);
          offset = 0;
          created = true;
        }
      }
      node.insertData(offset, text);
      const caret = document.createRange();
      caret.setStart(node, offset + text.length);
      caret.collapse(true);
      selection?.removeAllRanges();
      selection?.addRange(caret);
      armedRef.current = { node, start: offset, text, created };
      return trigger;
    }, [hasMentionSupport, disabled, triggers, removeArmed]);

    const openCompletion = useCallback((options: OpenCompletionOptions) => {
      if (pickQueueRef.current) {
        pickQueueRef.current.push(options);
        return;
      }
      // A bare trigger without a narrowed source starts with its preset, as if typed.
      const preset = !options?.query && options?.source === undefined && typeof options?.trigger === 'string'
        && triggers.has(options.trigger) && hasMentionSupport && !disabled
        ? presetFor(options.trigger)
        : undefined;
      const query = preset ?? options?.query ?? '';
      const trigger = armTrigger(
        options?.trigger,
        query,
        'open',
      );
      if (trigger === null) return;
      const armed = armedRef.current;
      if (armed) {
        // This trigger is decided: typing back to it bare later does not preset it (also not under a `source`).
        const start = armed.start + armed.text.length - query.length;
        presetSeenRef.current = { node: armed.node, pos: start - 1 };
        if (preset) presetRef.current = { node: armed.node, start, text: preset };
      }
      clearTimeout(searchTimeoutRef.current);
      sourceRef.current = options.source;
      setSelectedIndex(0);
      setSelectedAction(-1);
      setActiveSource('keyboard');
      onChange?.(getFullValue());
      void performSearch(query, trigger, options.source);
    }, [armTrigger, onChange, getFullValue, performSearch, triggers, hasMentionSupport, disabled, presetFor]);

    openCompletionRef.current = openCompletion;

    /** A pick from outside the list (the "+" menu): the trigger goes in at the caret, then the normal pick runs. */
    const pickCompletion = useCallback((item: MentionResult, options: { trigger: string }) => {
      const trigger = armTrigger(
        options?.trigger,
        '',
        'pick',
      );
      if (trigger === null) return;
      clearTimeout(searchTimeoutRef.current);
      closeDropdown();
      lastSearchRef.current = { query: '', trigger };
      pickResult(item, true);
    }, [armTrigger, closeDropdown, pickResult]);

    // -----------------------------------------------------------------------
    // Imperative handle
    // -----------------------------------------------------------------------

    useImperativeHandle(
      ref,
      (): InternalRichMentionInputHandle => ({
        focus: () => {
          const editor = editableRef.current;
          if (!editor) return;
          editor.focus();
          const selection = editorSelection(editor);
          if (selection && (selection.rangeCount === 0 || !editor.contains(selection.getRangeAt(0).startContainer))) {
            const end = document.createRange();
            end.selectNodeContents(editor);
            end.collapse(false);
            selection.removeAllRanges();
            selection.addRange(end);
          }
        },
        clear: () => {
          armedRef.current = null;
          if (editableRef.current) {
            editableRef.current.innerHTML = '';
          }
          if (hasMentionSupport) {
            setMentions([]);
            closeDropdown();
          }
          setValue('');
        },
        getValue: () =>
          hasMentionSupport
            ? getFullValue()
            : normalizeInputValue(editableRef.current?.innerText ?? ''),
        setValue: (nextValue: string, draftMentions: MentionData[] = []) => {
          if (!editableRef.current) return;
          const editor = editableRef.current;
          armedRef.current = null;
          editor.textContent = '';
          if (hasMentionSupport) {
            const remaining = [...draftMentions];
            const restored: MentionData[] = [];
            let offset = 0;
            while (remaining.length) {
              let selected = -1;
              let position = nextValue.length;
              let tokenLength = 0;
              remaining.forEach((mention, index) => {
                if (!mention.prefix || !mention.slug) return;
                const token = `${mention.prefix}${mention.slug}`;
                let found = nextValue.indexOf(token, offset);
                while (found >= 0 && /[\p{L}\p{N}_-]/u.test(nextValue[found + token.length] ?? '')) {
                  found = nextValue.indexOf(token, found + token.length);
                }
                if (found >= 0 && (selected < 0 || found < position)) {
                  selected = index;
                  position = found;
                  tokenLength = token.length;
                }
              });
              if (selected < 0) break;
              const [mention] = remaining.splice(selected, 1);
              editor.append(document.createTextNode(nextValue.slice(offset, position)), createChipElement(mention));
              restored.push(mention);
              offset = position + tokenLength;
            }
            editor.append(document.createTextNode(nextValue.slice(offset)));
            setMentions(restored);
            closeDropdown();
          } else {
            editor.textContent = nextValue;
          }
          setValue(nextValue);
        },
        getMentions: () => (hasMentionSupport ? collectMentions(getFullValue()) : []),
        insertMention: (mention: MentionData) => {
          if (!hasMentionSupport) return;
          insertPill(mention);
        },
        addMention: (mention: MentionData) => {
          if (!hasMentionSupport || !editableRef.current) return;
          const chip = createChipElement(mention);
          editableRef.current.insertBefore(chip, editableRef.current.firstChild);
          const space = document.createTextNode(' ');
          chip.after(space);
          setMentions((prev) => [...prev, mention]);
        },
        openCompletion,
        pickCompletion,
      }),
      [hasMentionSupport, setValue, getFullValue, collectMentions, createChipElement, closeDropdown, insertPill, openCompletion, pickCompletion],
    );

    // -----------------------------------------------------------------------
    // Render
    // -----------------------------------------------------------------------

    const dataPlaceholder = useMemo(() => placeholder ?? '', [placeholder]);

    // Plain mode — render exactly the same DOM as before
    if (!hasMentionSupport) {
      return (
        <div
          ref={editableRef}
          className={className}
          contentEditable={!disabled}
          role="textbox"
          tabIndex={0}
          data-component="rich-mention-input"
          data-placeholder={dataPlaceholder}
          data-state={disabled ? 'disabled' : 'idle'}
          data-drag-over={dragOver ? 'true' : undefined}
          aria-disabled={disabled}
          aria-label={placeholder ?? 'Message input'}
          onInput={handleInput}
          onCompositionStart={handleCompositionStart}
          onCompositionEnd={handleCompositionEnd}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
          suppressContentEditableWarning
        />
      );
    }

    // Mention mode — wrapper with editor + dropdown
    const isEmpty = (placeholderOnFocus || !isFocused) && getTextContent() === ''
      && mentions.length === 0 && !editableRef.current?.querySelector('[data-mention-id]');
    const optionId = (index: number, action = -1) => (
      action >= 0 ? `${listboxId}-option-${index}-action-${action}` : `${listboxId}-option-${index}`
    );
    const listOpen = dropdownOpen && searchResults.length > 0;
    /** Pointer activation: the entry becomes the active one (Enter/Tab pick it); the list does not scroll. */
    const activateEntry = (index: number, action: number) => {
      if (!searchResults[index]) return;
      setSelectedIndex(index);
      setSelectedAction(action);
      setActiveSource('pointer');
    };
    /** The entry under `target`: from the option ids, else from the row order of the list. */
    const entryAt = (target: EventTarget | null): { index: number; action: number } | null => {
      const list = dropdownRef.current;
      // `nodeType`, not `instanceof Element`: the list may render into another window (an iframe).
      if (!list || !target || (target as Node).nodeType !== 1 || !list.contains(target as Node)) return null;
      const prefix = `${listboxId}-option-`;
      for (let node: Element | null = target as Element; node && node !== list; node = node.parentElement) {
        const entry = node.id ? parseOptionId(node.id, prefix) : null;
        if (entry) return entry;
      }
      // A custom item without `optionProps`: its row is the n-th direct child (headings aside),
      // used only when every result has exactly one such child.
      let row: Element | null = target as Element;
      while (row && row.parentElement !== list) row = row.parentElement;
      if (!row || row.getAttribute('data-element') === 'group-heading') return null;
      const rows = Array.from(list.children).filter((child) => child.getAttribute('data-element') !== 'group-heading');
      if (rows.length !== searchResults.length) return null;
      return { index: rows.indexOf(row), action: -1 };
    };
    /**
     * Real pointer movement over the list activates the entry under it. Browsers also fire enter/over
     * and sometimes move events without movement (the list opens, scrolls or re-renders under a resting
     * pointer): an event at the last seen coordinates, or the first one after the list opened or its
     * results changed, only records the position.
     */
    const handleListPointerMove = (event: ReactMouseEvent<HTMLDivElement>) => {
      // One physical movement counts once: where pointer events fire, the compatibility mouse event
      // that follows each one (integer coordinates where the pointer event may carry 10.5) is skipped.
      // Mouse events count only where no pointer event was ever seen.
      if (event.type === 'pointermove') pointerEventsSeenRef.current = true;
      else if (pointerEventsSeenRef.current) return;
      // A finger dragging the list scrolls it; it does not choose an entry.
      if ((event.nativeEvent as PointerEvent).pointerType === 'touch') return;
      const point = { x: event.clientX, y: event.clientY, results: searchResults };
      if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) return;
      const last = lastPointRef.current;
      if (!last || last.results !== searchResults) {
        lastPointRef.current = point;
        return;
      }
      // Movement is at least 1 CSS pixel on an axis. A smaller difference neither activates nor
      // replaces the stored position, so slow real movement still adds up.
      if (Math.abs(point.x - last.x) < 1 && Math.abs(point.y - last.y) < 1) return;
      lastPointRef.current = point;
      const entry = entryAt(event.target);
      if (entry && (entry.index !== selectedIndex || entry.action !== selectedAction || activeSource !== 'pointer')) {
        activateEntry(entry.index, entry.action);
      }
    };
    const showEmpty = !listOpen && noMatches && Boolean(emptyLabel);
    const showHeadings = new Set(searchResults.map((result) => result.group ?? '')).size > 1;
    const optionProps = (index: number, action = -1): MentionDropdownOptionProps => {
      const result = searchResults[index];
      // A refinement (`Task:`) is named with its description, so a screen reader hears that it filters.
      const refinement = action < 0 && result?.select === 'query' && result.description;
      return {
        id: optionId(index, action),
        role: 'option',
        'aria-selected': index === selectedIndex && action === selectedAction,
        tabIndex: -1,
        ...(refinement ? { 'aria-label': `${result.label} ${result.description}` } : {}),
      };
    };

    const renderRow = (result: MentionResult, index: number, key: string) => {
      const item = (
        <DropdownItem
          key={key}
          result={result}
          isSelected={index === selectedIndex && selectedAction === -1}
          onClick={() => pickResult(result)}
          optionProps={optionProps(index)}
          onActivate={() => activateEntry(index, -1)}
        />
      );
      if (!onEntityAction || !result.actions?.length) return item;
      return (
        <div key={key} role="group" aria-label={result.label} data-element="result-row">
          {item}
          <span data-element="entity-actions">
            {result.actions.map((action, actionIndex) => (
              <button
                key={action.id}
                type="button"
                {...optionProps(index, actionIndex)}
                aria-label={`${action.label}: ${result.label}`}
                data-component="mention-action"
                data-selected={index === selectedIndex && actionIndex === selectedAction ? 'true' : 'false'}
                onClick={() => runAction(result, action.id)}
              >
                {action.label}
              </button>
            ))}
          </span>
        </div>
      );
    };

    return (
      <div
        className={wrapperClassName}
        data-component="rich-mention-input"
        data-drag-over={dragOver ? 'true' : undefined}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        data-state={
          disabled
            ? 'disabled'
            : dropdownOpen
              ? 'dropdown-open'
              : 'idle'
        }
      >
        <div
          ref={editableRef}
          className={className}
          style={EDITOR_STYLE}
          contentEditable={!disabled}
          role="textbox"
          tabIndex={0}
          data-element="editor"
          aria-disabled={disabled}
          aria-label={placeholder ?? 'Message input'}
          aria-autocomplete="list"
          aria-controls={listOpen ? listboxId : undefined}
          aria-activedescendant={listOpen ? optionId(selectedIndex, selectedAction) : undefined}
          onInput={handleInput}
          onCompositionStart={handleCompositionStart}
          onCompositionEnd={handleCompositionEnd}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          onFocus={() => setIsFocused(true)}
          onBlur={() => {
            setIsFocused(false);
            if (armedRef.current) dismissDropdown();
          }}
          suppressContentEditableWarning
        />

        {isEmpty && placeholder && (
          <div data-element="placeholder" aria-hidden>
            {placeholder}
          </div>
        )}

        <div data-element="completion-status" role="status" aria-live="polite" style={VISUALLY_HIDDEN}>
          {listOpen ? resultsLabel.replace('{count}', String(searchResults.length)) : showEmpty ? emptyLabel : ''}
        </div>

        {showEmpty && (
          <div data-component="mention-dropdown" data-state="empty">{emptyLabel}</div>
        )}

        {listOpen && (
          <div
            ref={dropdownRef}
            id={listboxId}
            role="listbox"
            aria-label={listLabel}
            data-component="mention-dropdown"
            data-state={isSearching ? 'searching' : 'idle'}
            data-active-source={activeSource}
            // Keep the caret in the editor while the list is clicked.
            onMouseDown={(event) => event.preventDefault()}
            onPointerMove={handleListPointerMove}
            onMouseMove={handleListPointerMove}
            // `pointer` means "the active entry is the one under the pointer". After a scroll (wheel,
            // trackpad, keyboard) another row may be under it: back to `keyboard`; the stored position
            // stays, so a resting pointer re-activates nothing until it really moves.
            onScroll={() => { if (activeSource === 'pointer') setActiveSource('keyboard'); }}
          >
            <PointerActiveContext.Provider value={activeSource === 'pointer'}>
            {searchResults.map((result, index) => {
              const key = result.key ?? `${result.type}:${result.id}`;
              const heading = showHeadings && result.group && result.group !== searchResults[index - 1]?.group
                ? <div key={`heading:${result.group}`} role="presentation" data-element="group-heading">{result.group}</div>
                : null;
              const row = renderRow(result, index, key);
              return heading ? [heading, row] : row;
            })}
            </PointerActiveContext.Provider>
          </div>
        )}
      </div>
    );

  },
);
