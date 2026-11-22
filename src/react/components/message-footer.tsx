import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { useComposerContext } from '../provider/composer-context.js';
import { fillTemplate } from '../utils/fill-template.js';
import { readMessageSources } from '../utils/message-sources.js';
import { copyMessageToClipboard } from '../utils/copy-message.js';
import type { ChatMessage, TurnOutcome } from '../types.js';

const COPY_RESET_MS = 2000;
const TICK_MS = 100;

function numberFormat(language: string | undefined): Intl.NumberFormat {
  const options = { minimumFractionDigits: 1, maximumFractionDigits: 1 };
  try {
    // Without a chat language the texts are English, so is the number.
    return new Intl.NumberFormat(language ?? 'en', options);
  } catch {
    return new Intl.NumberFormat('en', options);
  }
}

/**
 * A duration for the footer: under a minute in tenths of a second, floored
 * (`3.2 s`, German `3,2 s`), from a minute on in whole seconds (`1 min 5 s`).
 */
export function formatDuration(ms: number, language?: string): string {
  const safe = Number.isFinite(ms) && ms > 0 ? ms : 0;
  if (safe < 60_000) return `${numberFormat(language).format(Math.floor(safe / 100) / 10)} s`;
  const minutes = Math.floor(safe / 60_000);
  const seconds = Math.floor((safe % 60_000) / 1000);
  return `${minutes} min ${seconds} s`;
}

/** The running turn's elapsed time; ticks on its own, so only it re-renders. */
function Elapsed({ language }: { language: string | undefined }) {
  const { turnWorkedMs } = useComposerContext();
  const read = () => turnWorkedMs?.() ?? null;
  const [ms, setMs] = useState<number>(() => read() ?? 0);
  useEffect(() => {
    const tick = () => {
      const worked = turnWorkedMs?.() ?? null;
      // Between two runs of the turn (a UI action outcome awaited) the last value stays.
      if (worked !== null) setMs(worked);
    };
    tick();
    const interval = setInterval(tick, TICK_MS);
    return () => clearInterval(interval);
  }, [turnWorkedMs]);
  return <span data-element="elapsed" aria-hidden="true">{formatDuration(ms, language)}</span>;
}

type CopyState = 'idle' | 'copied' | 'failed';

function CopyButton({ text }: { text: string }) {
  const { locale } = useComposerContext();
  const [state, setState] = useState<CopyState>('idle');
  const mounted = useRef(true);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);
  const settle = (next: CopyState) => {
    if (!mounted.current) return;
    setState(next);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      timer.current = null;
      if (mounted.current) setState('idle');
    }, COPY_RESET_MS);
  };
  const label = state === 'copied'
    ? locale.copiedMessageLabel ?? 'Copied'
    : state === 'failed'
      ? locale.copyMessageFailedLabel ?? 'Copy failed'
      : locale.copyMessageLabel ?? 'Copy';
  return (
    <button
      type="button"
      data-action="copy"
      data-state={state}
      onClick={(event) => {
        const button = event.currentTarget;
        const root = button.closest('[data-component="message-bubble"]')
          ?? button.closest('[data-component="message-footer"]')?.parentElement
          ?? null;
        let copying: Promise<void>;
        try {
          copying = copyMessageToClipboard(root, text);
        } catch {
          copying = Promise.reject(new Error('copy failed'));
        }
        copying.then(() => settle('copied'), () => settle('failed'));
      }}
    >
      <span aria-live="polite">{label}</span>
    </button>
  );
}

export interface MessageFooterProps {
  message: ChatMessage;
  /** The answer's text (its cleaned text parts, else the fallback summary): what copy writes without rendered Markdown. */
  text: string;
  /** Whether the answer renders text (copy is offered then). */
  hasText: boolean;
  /** The next message is a user message, or there is none. */
  isLastOfTurn: boolean;
  turnOutcome: TurnOutcome | null;
  /** The answer of the running request (latest message while loading). */
  active: boolean;
}

/**
 * Internal: the footer under an assistant answer (`messageFooter`). Running:
 * elapsed time and stop. Done: copy, sources, the turn's working time.
 * Renders nothing when no part applies.
 */
export function MessageFooter({ message, text, hasText, isLastOfTurn, turnOutcome, active }: MessageFooterProps): ReactNode {
  const { messageFooter, locale, language, stop } = useComposerContext();
  const sourcesId = useId();
  const [sourcesOpen, setSourcesOpen] = useState(false);
  const sources = useMemo(
    () => (messageFooter?.sources && !active ? readMessageSources(message.parts) : []),
    [messageFooter?.sources, active, message.parts],
  );
  if (!messageFooter || message.role !== 'assistant') return null;

  if (active) {
    if (!messageFooter.duration && !messageFooter.stop) return null;
    return (
      <div data-component="message-footer" data-state="running">
        <div data-element="footer-actions">
          {messageFooter.duration && <Elapsed language={language} />}
          {messageFooter.stop && (
            <button type="button" data-action="stop" onClick={() => stop()}>{locale.stopButton}</button>
          )}
        </div>
      </div>
    );
  }

  const showCopy = messageFooter.copy && hasText;
  const showSources = sources.length > 0;
  const showDuration = messageFooter.duration && isLastOfTurn && turnOutcome?.status === 'completed'
    && typeof turnOutcome.durationMs === 'number';
  if (!showCopy && !showSources && !showDuration) return null;
  const sourcesLabel = sources.length === 1
    ? locale.messageSourceOneLabel ?? '1 source'
    : fillTemplate(locale.messageSourcesLabel ?? '{count} sources', { count: String(sources.length) });
  return (
    <div data-component="message-footer" data-state="done">
      <div data-element="footer-actions">
        {showCopy && <CopyButton text={text} />}
        {showSources && (
          <button
            type="button"
            data-action="sources"
            aria-expanded={sourcesOpen}
            aria-controls={sourcesId}
            onClick={() => setSourcesOpen((open) => !open)}
          >
            {sourcesLabel}
          </button>
        )}
        {showDuration && (
          <span data-element="duration">
            {fillTemplate(locale.messageDurationLabel ?? 'Done in {duration}', {
              duration: formatDuration(turnOutcome!.durationMs!, language),
            })}
          </span>
        )}
      </div>
      {showSources && (
        <ul id={sourcesId} data-element="sources" hidden={!sourcesOpen}>
          {sources.map((source) => (
            <li key={source.href}>
              <a data-element="source" href={source.href} target="_blank" rel="noopener noreferrer">
                <span data-element="source-label">{source.label}</span>
                {' '}
                <span data-element="source-domain">{source.domain}</span>
              </a>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
