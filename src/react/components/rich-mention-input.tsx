import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from 'react';
import type {
  MentionData,
  MentionDropdownItemProps,
  MentionResult,
  RichMentionInputHandle,
  RichMentionInputProps,
} from '../types.js';
import { inferMentionPrefix, normalizeMentionSlug } from '../utils/mention-markup.js';

const DEFAULT_TRIGGERS = ['@', '/'];
const SEARCH_DEBOUNCE_MS = 100;

function normalizeInputValue(text: string): string {
  return text.replace(/\u00A0/g, ' ');
}

// ---------------------------------------------------------------------------
// Default dropdown item (data-attribute driven, no hardcoded styles)
// ---------------------------------------------------------------------------

function DefaultDropdownItem({ result, isSelected, onClick }: MentionDropdownItemProps) {
  const itemRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (isSelected && itemRef.current) {
      itemRef.current.scrollIntoView({ block: 'nearest' });
    }
  }, [isSelected]);

  return (
    <button
      ref={itemRef}
      type="button"
      onClick={onClick}
      data-component="mention-dropdown-item"
      data-mention-type={result.type}
      data-selected={isSelected ? 'true' : 'false'}
    >
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
      onChange,
      onSubmit,
      onSearch,
      initialMentions,
      triggers = DEFAULT_TRIGGERS,
      components,
    },
    ref,
  ) {
    const hasMentionSupport = typeof onSearch === 'function';
    const isControlled = value !== undefined;
    const [internalValue, setInternalValue] = useState(defaultValue);
    const editableRef = useRef<HTMLDivElement>(null);
    const dropdownRef = useRef<HTMLDivElement>(null);

    // Mention autocomplete state
    const [mentions, setMentions] = useState<MentionData[]>([]);
    const [dropdownOpen, setDropdownOpen] = useState(false);
    const [searchResults, setSearchResults] = useState<MentionResult[]>([]);
    const [selectedIndex, setSelectedIndex] = useState(0);
    const [isSearching, setIsSearching] = useState(false);
    const [isFocused, setIsFocused] = useState(false);

    // Refs for stale-closure avoidance and debounce
    const searchTimeoutRef = useRef<ReturnType<typeof setTimeout>>(undefined);
    const searchVersionRef = useRef(0);
    const isInitializedRef = useRef(false);

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
      chip.dataset.size = 'inline';

      const prefixSpan = document.createElement('span');
      prefixSpan.dataset.element = 'prefix';
      prefixSpan.textContent = prefix;

      const nameSpan = document.createElement('span');
      nameSpan.dataset.element = 'display-name';
      nameSpan.textContent = displayName;

      const removeBtn = document.createElement('span');
      removeBtn.dataset.action = 'remove-mention';
      removeBtn.dataset.mentionId = mention.id;
      removeBtn.textContent = '\u00D7';
      removeBtn.style.cursor = 'pointer';

      chip.appendChild(prefixSpan);
      chip.appendChild(nameSpan);
      chip.appendChild(removeBtn);

      return chip;
    }, []);

    // -----------------------------------------------------------------------
    // Dropdown helpers
    // -----------------------------------------------------------------------

    const closeDropdown = useCallback(() => {
      searchVersionRef.current++;
      setDropdownOpen(false);
      setSearchResults([]);
      setSelectedIndex(0);
    }, []);

    const performSearch = useCallback(
      async (query: string, trigger: string) => {
        if (!onSearch) return;
        const version = ++searchVersionRef.current;
        setIsSearching(true);
        try {
          const results = await onSearch(query, trigger);
          if (searchVersionRef.current !== version) return;
          setSearchResults(results);
          setSelectedIndex(0);
          setDropdownOpen(results.length > 0);
        } catch {
          if (searchVersionRef.current !== version) return;
          setSearchResults([]);
          setDropdownOpen(false);
        } finally {
          if (searchVersionRef.current === version) {
            setIsSearching(false);
          }
        }
      },
      [onSearch],
    );

    /**
     * Detect a trigger character before the cursor in the current text node.
     * Returns trigger, query, and position, or null if no trigger is active.
     */
    const detectTrigger = useCallback((): {
      trigger: string;
      query: string;
      triggerPos: number;
    } | null => {
      const selection = window.getSelection();
      if (!selection || selection.rangeCount === 0) return null;

      const range = selection.getRangeAt(0);
      if (!range.collapsed || range.startContainer.nodeType !== Node.TEXT_NODE) return null;

      const textNode = range.startContainer as Text;
      const text = textNode.textContent || '';
      const cursorPos = range.startOffset;
      const before = text.slice(0, cursorPos);

      for (let i = before.length - 1; i >= 0; i--) {
        const char = before[i];
        if (char === ' ' || char === '\n') break;
        if (triggers.includes(char)) {
          if (i === 0 || before[i - 1] === ' ' || before[i - 1] === '\n') {
            return { trigger: char, query: before.slice(i + 1), triggerPos: i };
          }
        }
      }
      return null;
    }, [triggers]);

    // -----------------------------------------------------------------------
    // Mention insertion
    // -----------------------------------------------------------------------

    const insertMention = useCallback(
      (result: MentionResult) => {
        if (!editableRef.current) return;

        const selection = window.getSelection();
        if (!selection || selection.rangeCount === 0) return;

        const range = selection.getRangeAt(0);
        if (range.startContainer.nodeType !== Node.TEXT_NODE) return;

        const textNode = range.startContainer as Text;
        const text = textNode.textContent || '';
        const cursorPos = range.startOffset;

        // Find the trigger position backward from cursor
        let triggerPos = -1;
        for (let i = cursorPos - 1; i >= 0; i--) {
          const char = text[i];
          if (char === ' ' || char === '\n') break;
          if (triggers.includes(char)) {
            if (i === 0 || text[i - 1] === ' ' || text[i - 1] === '\n') {
              triggerPos = i;
              break;
            }
          }
        }
        if (triggerPos === -1) return;

        const prefix = inferMentionPrefix(result.type);
        const slug = normalizeMentionSlug(result.label);

        const mentionData: MentionData = {
          id: result.id,
          type: result.type,
          label: result.label,
          displayName: result.label,
          slug,
          prefix,
        };

        // For command type: insert as text, no chip
        if (result.type === 'command') {
          const beforeText = text.slice(0, triggerPos);
          const afterText = text.slice(cursorPos);
          const token = `${prefix}${slug} `;
          textNode.textContent = beforeText + token + afterText;

          requestAnimationFrame(() => {
            const newRange = document.createRange();
            newRange.setStart(textNode, (beforeText + token).length);
            newRange.collapse(true);
            selection.removeAllRanges();
            selection.addRange(newRange);
          });

          setMentions((prev) => [...prev, mentionData]);
          closeDropdown();
          requestAnimationFrame(() => {
            onChange?.(getFullValue());
          });
          return;
        }

        // Non-command: insert chip element
        const chip = createChipElement(mentionData);

        const beforeText = text.slice(0, triggerPos);
        const afterText = text.slice(cursorPos);

        const parent = textNode.parentNode;
        if (!parent) return;

        const beforeNode = document.createTextNode(beforeText);
        const afterNode = document.createTextNode(' ' + afterText);

        parent.insertBefore(beforeNode, textNode);
        parent.insertBefore(chip, textNode);
        parent.insertBefore(afterNode, textNode);
        parent.removeChild(textNode);

        requestAnimationFrame(() => {
          const newRange = document.createRange();
          newRange.setStart(afterNode, 1);
          newRange.collapse(true);
          selection.removeAllRanges();
          selection.addRange(newRange);
          editableRef.current?.focus();
        });

        setMentions((prev) => [...prev, mentionData]);
        closeDropdown();
        requestAnimationFrame(() => {
          onChange?.(getFullValue());
        });
      },
      [triggers, createChipElement, closeDropdown, onChange, getFullValue],
    );

    // -----------------------------------------------------------------------
    // Event handlers
    // -----------------------------------------------------------------------

    const handleInput = useCallback(() => {
      if (!hasMentionSupport) {
        const nextValue = normalizeInputValue(editableRef.current?.innerText ?? '');
        setValue(nextValue);
        return;
      }

      // Mention mode: detect trigger and schedule search
      const triggerState = detectTrigger();
      if (triggerState) {
        clearTimeout(searchTimeoutRef.current);
        searchTimeoutRef.current = setTimeout(() => {
          void performSearch(triggerState.query, triggerState.trigger);
        }, SEARCH_DEBOUNCE_MS);
      } else {
        clearTimeout(searchTimeoutRef.current);
        closeDropdown();
      }

      onChange?.(getFullValue());
    }, [hasMentionSupport, setValue, detectTrigger, performSearch, closeDropdown, onChange, getFullValue]);

    const submit = useCallback(() => {
      if (disabled) return;

      const text = hasMentionSupport
        ? getFullValue()
        : normalizeInputValue((editableRef.current?.innerText ?? '').trim());

      if (!text) return;

      onSubmit?.(text);
      setValue('');
      if (hasMentionSupport) {
        setMentions([]);
      }
      if (editableRef.current) {
        editableRef.current.innerHTML = '';
      }
    }, [disabled, hasMentionSupport, getFullValue, onSubmit, setValue]);

    const handleKeyDown = useCallback(
      (event: KeyboardEvent<HTMLDivElement>) => {
        // Dropdown navigation (mention mode only)
        if (hasMentionSupport && dropdownOpen && searchResults.length > 0) {
          if (event.key === 'ArrowDown') {
            event.preventDefault();
            setSelectedIndex((prev) => (prev + 1) % searchResults.length);
            return;
          }
          if (event.key === 'ArrowUp') {
            event.preventDefault();
            setSelectedIndex(
              (prev) => (prev - 1 + searchResults.length) % searchResults.length,
            );
            return;
          }
          if (event.key === 'Tab' || (event.key === 'Enter' && !event.shiftKey)) {
            event.preventDefault();
            const selected = searchResults[selectedIndex];
            if (selected) {
              insertMention(selected);
            }
            return;
          }
          if (event.key === 'Escape') {
            event.preventDefault();
            closeDropdown();
            return;
          }
        }

        // Submit on Enter (both modes)
        if (event.key === 'Enter' && !event.shiftKey) {
          event.preventDefault();
          submit();
          return;
        }

        // Backspace: delete chip at cursor boundary (mention mode)
        if (hasMentionSupport && event.key === 'Backspace') {
          const selection = window.getSelection();
          if (selection && selection.rangeCount > 0) {
            const range = selection.getRangeAt(0);
            if (range.collapsed && range.startOffset === 0) {
              let prevNode: Node | null = range.startContainer;
              if (prevNode.nodeType === Node.TEXT_NODE) {
                prevNode = prevNode.previousSibling;
              }
              if (prevNode && (prevNode as HTMLElement).dataset?.mentionId) {
                event.preventDefault();
                const mentionId = (prevNode as HTMLElement).dataset.mentionId!;
                setMentions((prev) => prev.filter((m) => m.id !== mentionId));
                prevNode.parentNode?.removeChild(prevNode);
                onChange?.(getFullValue());
              }
            }
          }
        }
      },
      [
        hasMentionSupport,
        dropdownOpen,
        searchResults,
        selectedIndex,
        insertMention,
        closeDropdown,
        submit,
        onChange,
        getFullValue,
      ],
    );

    /** Strip formatting on paste — insert plain text only. */
    const handlePaste = useCallback(
      (e: React.ClipboardEvent<HTMLDivElement>) => {
        e.preventDefault();
        const plainText = e.clipboardData.getData('text/plain');
        if (!plainText) return;

        const selection = window.getSelection();
        if (!selection || selection.rangeCount === 0) return;

        const range = selection.getRangeAt(0);
        range.deleteContents();
        const textNode = document.createTextNode(plainText);
        range.insertNode(textNode);
        range.setStartAfter(textNode);
        range.collapse(true);
        selection.removeAllRanges();
        selection.addRange(range);

        onChange?.(getFullValue());
      },
      [onChange, getFullValue],
    );

    // -----------------------------------------------------------------------
    // Side effects (mention mode)
    // -----------------------------------------------------------------------

    // Close dropdown on outside click
    useEffect(() => {
      if (!dropdownOpen) return;

      const handleClickOutside = (e: MouseEvent) => {
        if (
          dropdownRef.current &&
          !dropdownRef.current.contains(e.target as Node) &&
          editableRef.current &&
          !editableRef.current.contains(e.target as Node)
        ) {
          closeDropdown();
        }
      };

      document.addEventListener('mousedown', handleClickOutside);
      return () => document.removeEventListener('mousedown', handleClickOutside);
    }, [dropdownOpen, closeDropdown]);

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
          const selection = window.getSelection();
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

    // -----------------------------------------------------------------------
    // Imperative handle
    // -----------------------------------------------------------------------

    useImperativeHandle(
      ref,
      () => ({
        focus: () => editableRef.current?.focus(),
        clear: () => {
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
        setValue: (nextValue: string) => {
          if (!editableRef.current) return;
          if (hasMentionSupport) {
            editableRef.current.innerHTML = '';
            setMentions([]);
          }
          editableRef.current.textContent = nextValue;
          setValue(nextValue);
        },
        getMentions: () => (hasMentionSupport ? getMentionsFromDOM() : []),
        addMention: (mention: MentionData) => {
          if (!hasMentionSupport || !editableRef.current) return;
          const chip = createChipElement(mention);
          editableRef.current.insertBefore(chip, editableRef.current.firstChild);
          const space = document.createTextNode(' ');
          chip.after(space);
          setMentions((prev) => [...prev, mention]);
        },
      }),
      [hasMentionSupport, setValue, getFullValue, getMentionsFromDOM, createChipElement, closeDropdown],
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
          aria-disabled={disabled}
          aria-label={placeholder ?? 'Message input'}
          onInput={handleInput}
          onKeyDown={handleKeyDown}
          suppressContentEditableWarning
        />
      );
    }

    // Mention mode — wrapper with editor + dropdown
    const isEmpty = !isFocused && getTextContent() === '' && mentions.length === 0;

    return (
      <div
        data-component="rich-mention-input"
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
          contentEditable={!disabled}
          role="textbox"
          tabIndex={0}
          data-element="editor"
          aria-disabled={disabled}
          aria-label={placeholder ?? 'Message input'}
          onInput={handleInput}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          onFocus={() => setIsFocused(true)}
          onBlur={() => setIsFocused(false)}
          suppressContentEditableWarning
        />

        {isEmpty && placeholder && (
          <div data-element="placeholder" aria-hidden>
            {placeholder}
          </div>
        )}

        {dropdownOpen && searchResults.length > 0 && (
          <div
            ref={dropdownRef}
            data-component="mention-dropdown"
            data-state={isSearching ? 'searching' : 'idle'}
          >
            {searchResults.map((result, index) => (
              <DropdownItem
                key={result.id}
                result={result}
                isSelected={index === selectedIndex}
                onClick={() => insertMention(result)}
              />
            ))}
          </div>
        )}
      </div>
    );
  },
);
