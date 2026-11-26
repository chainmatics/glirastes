import type { ComponentType } from 'react';
import { starterChatComponents } from '../../chat-views/starter-catalog.js';
import { EntityLinkChip } from '../entity-links/entity-links-react.js';
import { useOptionalMessageChat } from '../provider/message-chat-context.js';
import { bindChatComponent, type ChatComponentBinding, type ChatComponentProps } from './registry.js';

/**
 * The SDK's bindings of the starter catalog: semantic markup, no visual
 * props. Each element's root carries `data-element="<component-id-kebab>"`;
 * the shipped styles (off with `unstyled`) target those attributes.
 */

type Props = ChatComponentProps & { props: Record<string, unknown> };

function text(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value) ?? '';
}

function numberText(value: unknown, locale: string): string {
  if (typeof value !== 'number') return text(value);
  try {
    return new Intl.NumberFormat(locale).format(value);
  } catch {
    return String(value);
  }
}

function moneyText(amount: unknown, currency: unknown, locale: string): string {
  if (typeof amount !== 'number' || typeof currency !== 'string') return text(amount);
  try {
    return new Intl.NumberFormat(locale, { style: 'currency', currency }).format(amount);
  } catch {
    return `${amount} ${currency}`;
  }
}

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

function dateTimeText(value: unknown, mode: unknown, locale: string): string {
  if (typeof value !== 'string') return text(value);
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  try {
    // A plain date is a calendar day: formatted in UTC so it never shifts by the page's time zone.
    const options: Intl.DateTimeFormatOptions = mode === 'datetime' && !DATE_ONLY.test(value)
      ? { dateStyle: 'medium', timeStyle: 'short' }
      : { dateStyle: 'medium', ...(DATE_ONLY.test(value) ? { timeZone: 'UTC' } : {}) };
    return new Intl.DateTimeFormat(locale, options).format(date);
  } catch {
    return value;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function Group({ props, children }: Props) {
  const emphasis = typeof props.emphasis === 'string' ? props.emphasis : undefined;
  return <div data-element="group" data-emphasis={emphasis}>{children}</div>;
}

function Card({ props, children }: Props) {
  const title = text(props.title);
  return (
    <section data-element="card" aria-label={title || undefined}>
      <div data-element="card-title">{title}</div>
      {children ? <div data-element="card-body">{children}</div> : null}
    </section>
  );
}

function Text({ props }: Props) {
  return <p data-element="text">{text(props.text)}</p>;
}

function KeyValue({ props, locale }: Props) {
  const items = Array.isArray(props.items) ? props.items.filter(isRecord) : [];
  return (
    <dl data-element="key-value">
      {items.map((item, index) => (
        <div key={index} data-element="key-value-item">
          <dt>{text(item.label)}</dt>
          <dd>{numberText(item.value, locale)}</dd>
        </div>
      ))}
    </dl>
  );
}

function Table({ props, rows, renderCell }: Props) {
  const columns = (Array.isArray(props.columns) ? props.columns : [])
    .filter(isRecord)
    .map((column) => ({ header: text(column.header), cell: text(column.cell) }));
  return (
    <div data-element="table">
      <table>
        <thead>
          <tr>{columns.map((column, index) => <th key={index} scope="col">{column.header}</th>)}</tr>
        </thead>
        <tbody>
          {(rows ?? []).map((_, rowIndex) => (
            <tr key={rowIndex}>
              {columns.map((column, index) => <td key={index}>{renderCell(rowIndex, column.cell)}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function StatusBadge({ props }: Props) {
  const tone = typeof props.tone === 'string' ? props.tone : 'neutral';
  return <span data-element="status-badge" data-tone={tone}>{text(props.label)}</span>;
}

function EntityLink({ props }: Props) {
  // Outside a chat (a view rendered on its own) there is no entity-link context: the label only.
  const chat = useOptionalMessageChat();
  const label = text(props.label);
  const record = props.record;
  const id = typeof record === 'string' || typeof record === 'number' ? String(record) : undefined;
  if (!chat || id === undefined || typeof props.entity !== 'string') {
    return <span data-element="entity-link">{label}</span>;
  }
  return (
    <span data-element="entity-link">
      <EntityLinkChip reference={{ type: props.entity, id, label: label || id }} text={label || id} />
    </span>
  );
}

function Money({ props, locale }: Props) {
  return <span data-element="money">{moneyText(props.amount, props.currency, locale)}</span>;
}

function DateTime({ props, locale }: Props) {
  const value = text(props.value);
  return <time data-element="date-time" dateTime={value}>{dateTimeText(props.value, props.mode, locale)}</time>;
}

function Stat({ props, locale }: Props) {
  return (
    <div data-element="stat">
      <span data-element="stat-label">{text(props.label)}</span>
      <span data-element="stat-value">{numberText(props.value, locale)}</span>
    </div>
  );
}

function Action({ props, dispatch }: Props) {
  const label = text(props.label);
  const prompt = typeof props.prompt === 'string' ? props.prompt : undefined;
  const uiAction = isRecord(props.uiAction) && typeof props.uiAction.id === 'string' ? props.uiAction : undefined;
  const onClick = () => {
    if (prompt !== undefined) dispatch.prompt(prompt);
    else if (uiAction) {
      dispatch.uiAction(uiAction.id as string, isRecord(uiAction.args) ? uiAction.args : undefined);
    }
  };
  return (
    <button type="button" data-element="action" onClick={onClick} disabled={prompt === undefined && !uiAction}>
      {label}
    </button>
  );
}

const COMPONENTS: Record<string, ComponentType<Props>> = {
  Group,
  Card,
  Text,
  KeyValue,
  Table,
  StatusBadge,
  EntityLink,
  Money,
  DateTime,
  Stat,
  Action,
};

/** Bindings of the whole starter catalog; the default of `chatViews`. */
export const starterChatBindings: ReadonlyArray<ChatComponentBinding> = Object.freeze(
  starterChatComponents.map((definition) => {
    const component = COMPONENTS[definition.id];
    if (!component) throw new Error(`no starter binding for chat component ${definition.id}`);
    return bindChatComponent(definition, component as ComponentType<ChatComponentProps>);
  }),
);
