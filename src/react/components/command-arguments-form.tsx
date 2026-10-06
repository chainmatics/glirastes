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

interface EntityFieldProps {
  id: string;
  label: string;
  arg: ChatInteractionArg;
  value: string;
  valueLabel: string;
  onChange: (value: string, label: string) => void;
}

/** ARIA 1.2 combobox over one entity type's search. */
function EntityField({ id, label, arg, value, valueLabel, onChange }: EntityFieldProps) {
  const { interactions, locale } = useChatContext();
  const [query, setQuery] = useState(valueLabel || value);
  const [items, setItems] = useState<ChatEntityItem[]>([]);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const listId = `${id}-list`;

  useEffect(() => {
    if (!open || !interactions || !arg.entity) return undefined;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      void interactions.searchEntity(arg.entity!, query.trim(), controller.signal).then((found) => {
        if (controller.signal.aborted) return;
        setItems(found);
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
    if (event.key === 'Enter' && open && items[active]) {
      event.preventDefault();
      pick(items[active]!);
      return;
    }
    if (event.key === 'Escape' && open) {
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
    }
  };

  const expanded = open && items.length > 0;
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
        value={query}
        onChange={(event) => {
          setQuery(event.target.value);
          setOpen(true);
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
      {open && query.trim() && items.length === 0 && (
        <span data-element="empty">{locale.commandArgumentsNoMatches}</span>
      )}
    </div>
  );
}

/**
 * Asks for the arguments a `/` command or entity action still needs, then
 * runs it without the model. Entity arguments search like `@`; closed sets
 * are a select; everything else is text. Escape cancels.
 */
export function CommandArgumentsForm({ pending, onSubmit, onCancel }: CommandArgumentsFormProps) {
  const { interactions, locale } = useChatContext();
  const formId = useId();
  const formRef = useRef<HTMLFormElement>(null);
  const [values, setValues] = useState<Record<string, string>>(() => ({ ...pending.values }));
  const [labels, setLabels] = useState<Record<string, string>>(() => ({ ...pending.valueLabels }));
  const language = interactions?.locale ?? 'en';

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
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    onSubmit(values, labels);
  };

  return (
    <form
      ref={formRef}
      data-component="command-arguments"
      aria-label={locale.commandArgumentsLabel.replace('{command}', pending.label)}
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
      {pending.args.map((arg, index) => {
        const id = `${formId}-${index}`;
        const label = chatText(arg.label, language);
        if (arg.entity) {
          return (
            <EntityField
              key={arg.name}
              id={id}
              label={label}
              arg={arg}
              value={values[arg.name] ?? ''}
              valueLabel={labels[arg.name] ?? ''}
              onChange={(value, valueLabel) => set(arg.name, value, valueLabel)}
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
