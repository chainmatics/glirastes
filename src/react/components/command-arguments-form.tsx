import {
  useEffect,
  useId,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
} from 'react';
import { chatText, type ChatInteractionArg } from '../../contracts/chat-interactions.js';
import type { ChatEntityItem } from '../interactions/definitions.js';
import { useChatContext } from '../provider/chat-context.js';
import type { CommandArgumentsFormProps } from '../types.js';

const SEARCH_DEBOUNCE_MS = 120;
const NO_ITEMS: ChatEntityItem[] = [];

interface EntityFieldProps {
  id: string;
  label: string;
  arg: ChatInteractionArg;
  value: string;
  valueLabel: string;
  invalid: boolean;
  describedBy: string | undefined;
  onChange: (value: string, label: string) => void;
  /** The text in the box, so the form can tell typed-but-unpicked text from no input. */
  onText: (text: string) => void;
}

/** ARIA 1.2 combobox over one entity type's search. */
function EntityField({ id, label, arg, value, valueLabel, invalid, describedBy, onChange, onText }: EntityFieldProps) {
  const { interactions, locale } = useChatContext();
  const [query, setQuery] = useState(valueLabel || value);
  // The hits are only valid for the query they were searched with: while a newer
  // query is still being searched nothing may be shown or picked from the old list.
  const [results, setResults] = useState<{ query: string; items: ChatEntityItem[] } | undefined>();
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const listId = `${id}-list`;
  const trimmed = query.trim();
  const settled = results !== undefined && results.query === trimmed;
  const items = settled ? results.items : NO_ITEMS;

  useEffect(() => {
    if (!open || !interactions || !arg.entity) return undefined;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      void interactions.searchEntity(arg.entity!, query.trim(), controller.signal).then((found) => {
        if (controller.signal.aborted) return;
        setResults({ query: query.trim(), items: found });
        setActive(0);
      });
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [open, query, interactions, arg.entity]);

  const pick = (item: ChatEntityItem) => {
    onChange(item.id, item.label);
    setQuery(item.label);
    setOpen(false);
  };

  const expanded = open && items.length > 0;

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      if (!open) setOpen(true);
      else if (items.length > 0) setActive((previous) => (previous + 1) % items.length);
      return;
    }
    if (event.key === 'ArrowUp' && open && items.length > 0) {
      event.preventDefault();
      setActive((previous) => (previous - 1 + items.length) % items.length);
      return;
    }
    if (event.key === 'Enter' && expanded && items[active]) {
      event.preventDefault();
      pick(items[active]!);
      return;
    }
    // The list for what was just typed is still loading: Enter neither picks nor submits the form.
    if (event.key === 'Enter' && open && interactions && trimmed && !settled) {
      event.preventDefault();
      return;
    }
    if (event.key === 'Escape' && expanded) {
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
    }
  };

  return (
    <div data-element="field" data-kind="entity">
      <label htmlFor={id}>{label}{arg.required ? ' *' : ''}</label>
      <input
        id={id}
        type="text"
        role="combobox"
        autoComplete="off"
        aria-autocomplete="list"
        aria-expanded={expanded}
        aria-controls={listId}
        aria-activedescendant={expanded ? `${listId}-${active}` : undefined}
        aria-required={arg.required ? true : undefined}
        aria-invalid={invalid ? true : undefined}
        aria-describedby={describedBy}
        data-argument={arg.name}
        value={query}
        onChange={(event) => {
          setQuery(event.target.value);
          setActive(0);
          setOpen(true);
          onText(event.target.value);
          if (value) onChange('', '');
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onKeyDown={onKeyDown}
      />
      <ul id={listId} role="listbox" aria-label={label} hidden={!expanded} data-element="options">
        {items.map((item, index) => (
          <li
            key={item.id}
            id={`${listId}-${index}`}
            role="option"
            aria-selected={index === active}
            data-selected={index === active ? 'true' : 'false'}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => pick(item)}
          >
            {item.label}
            {item.description && <span data-element="description">{item.description}</span>}
          </li>
        ))}
      </ul>
      {open && settled && trimmed && items.length === 0 && (
        <span data-element="empty">{locale.commandArgumentsNoMatches}</span>
      )}
    </div>
  );
}

/**
 * Asks for the arguments a `/` command or entity action still needs, then
 * runs it without the model. Entity arguments search like `@`; closed sets
 * are a select; everything else is text. Escape cancels. Run checks the
 * required values itself: it names what is missing, focuses the first such
 * field and keeps what was typed, and it refuses text typed into a person
 * field that was never picked (the command would silently run without it).
 */
export function CommandArgumentsForm({ pending, onSubmit, onCancel }: CommandArgumentsFormProps) {
  const { interactions, locale } = useChatContext();
  const formId = useId();
  const formRef = useRef<HTMLFormElement>(null);
  const [values, setValues] = useState<Record<string, string>>(() => ({ ...pending.values }));
  const [labels, setLabels] = useState<Record<string, string>>(() => ({ ...pending.valueLabels }));
  const [texts, setTexts] = useState<Record<string, string>>({});
  const [incomplete, setIncomplete] = useState<string[]>([]);
  const language = interactions?.locale ?? 'en';
  const errorId = `${formId}-incomplete`;

  // Start at the first required field still empty (e.g. the person when the task came from `@`).
  useEffect(() => {
    const fields = [...(formRef.current?.querySelectorAll<HTMLInputElement | HTMLSelectElement>('input, select') ?? [])];
    const required = (field: HTMLInputElement | HTMLSelectElement) => field.required || field.getAttribute('aria-required') === 'true';
    (fields.find((field) => field.value === '' && required(field))
      ?? fields.find((field) => field.value === '')
      ?? fields[0])?.focus();
  }, []);

  const set = (name: string, value: string, label?: string) => {
    setValues((previous) => ({ ...previous, [name]: value }));
    if (label !== undefined) setLabels((previous) => ({ ...previous, [name]: label }));
    if (value.trim()) setIncomplete((previous) => (previous.includes(name) ? previous.filter((other) => other !== name) : previous));
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const missing = pending.args.filter((arg) => !values[arg.name]?.trim()
      && (arg.required || (arg.entity !== undefined && Boolean(texts[arg.name]?.trim()))));
    if (missing.length > 0) {
      setIncomplete(missing.map((arg) => arg.name));
      [...(formRef.current?.querySelectorAll<HTMLElement>('[data-argument]') ?? [])]
        .find((field) => field.dataset.argument === missing[0]!.name)
        ?.focus();
      return;
    }
    setIncomplete([]);
    onSubmit(values, labels);
  };

  const incompleteLabels = pending.args
    .filter((arg) => incomplete.includes(arg.name))
    .map((arg) => chatText(arg.label, language));

  return (
    <form
      ref={formRef}
      data-component="command-arguments"
      aria-label={locale.commandArgumentsLabel.replace('{command}', () => pending.label)}
      noValidate
      onSubmit={submit}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.preventDefault();
          onCancel();
        }
      }}
    >
      <p data-element="title">{`/${pending.label}`}</p>
      {pending.error && <p role="alert" data-element="error">{locale.commandArgumentsInvalid}</p>}
      {incompleteLabels.length > 0 && (
        <p id={errorId} role="alert" data-element="error">
          {locale.commandArgumentsIncomplete.replace('{fields}', () => incompleteLabels.join(', '))}
        </p>
      )}
      {pending.args.map((arg, index) => {
        const id = `${formId}-${index}`;
        const label = chatText(arg.label, language);
        const invalid = incomplete.includes(arg.name);
        const describedBy = invalid ? errorId : undefined;
        if (arg.entity) {
          return (
            <EntityField
              key={arg.name}
              id={id}
              label={label}
              arg={arg}
              value={values[arg.name] ?? ''}
              valueLabel={labels[arg.name] ?? ''}
              invalid={invalid}
              describedBy={describedBy}
              onChange={(value, valueLabel) => set(arg.name, value, valueLabel)}
              onText={(text) => setTexts((previous) => ({ ...previous, [arg.name]: text }))}
            />
          );
        }
        if (arg.options) {
          return (
            <div key={arg.name} data-element="field" data-kind="options">
              <label htmlFor={id}>{label}{arg.required ? ' *' : ''}</label>
              <select
                id={id}
                value={values[arg.name] ?? ''}
                required={arg.required}
                aria-invalid={invalid ? true : undefined}
                aria-describedby={describedBy}
                data-argument={arg.name}
                onChange={(event) => set(arg.name, event.target.value)}
              >
                {!arg.required || !values[arg.name] ? <option value="">{locale.commandArgumentsAnyOption}</option> : null}
                {arg.options.map((option) => <option key={option} value={option}>{option}</option>)}
              </select>
            </div>
          );
        }
        return (
          <div key={arg.name} data-element="field" data-kind="text">
            <label htmlFor={id}>{label}{arg.required ? ' *' : ''}</label>
            <input
              id={id}
              type="text"
              value={values[arg.name] ?? ''}
              required={arg.required}
              aria-invalid={invalid ? true : undefined}
              aria-describedby={describedBy}
              data-argument={arg.name}
              maxLength={500}
              onChange={(event) => set(arg.name, event.target.value)}
            />
          </div>
        );
      })}
      <div data-element="actions">
        <button type="submit" data-action="run">{locale.commandArgumentsSubmit}</button>
        <button type="button" data-action="cancel" onClick={onCancel}>{locale.cancelButton}</button>
      </div>
    </form>
  );
}
