import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { useMessageChat } from '../provider/message-chat-context.js';
import { fillTemplate } from '../utils/fill-template.js';
import { readMessageSources } from '../utils/message-sources.js';
import { readMessageFollowups } from '../utils/followup-suggestions.js';
import { findOpenClarification } from '../utils/clarification.js';
import { copyMessageToClipboard } from '../utils/copy-message.js';
import type { ChatMessage, TurnOutcome } from '../types.js';

const COPY_RESET_MS = 2000;
const TICK_MS = 100;

const numberFormats = new Map<string, Intl.NumberFormat>();

function numberFormat(language: string | undefined): Intl.NumberFormat {
  // Without a chat language the texts are English, so is the number.
  const key = language ?? 'en';
  let format = numberFormats.get(key);
  if (!format) {
    const options = { minimumFractionDigits: 1, maximumFractionDigits: 1 };
    try {
      format = new Intl.NumberFormat(key, options);
    } catch {
      format = new Intl.NumberFormat('en', options);
    }
    numberFormats.set(key, format);
  }
  return format;
}

/**
 * A duration for the footer: under a tenth of a second `< 0.1 s`, under a minute in tenths of a second,
 * floored (`3.2 s`, German `3,2 s`), from a minute on in whole seconds (`1 min 5 s`).
 */
export function formatDuration(ms: number, language?: string): string {
  const safe = Number.isFinite(ms) && ms > 0 ? ms : 0;
  const format = numberFormat(language);
  if (safe < 100) return `< ${format.format(0.1)} s`;
  if (safe < 60_000) return `${format.format(Math.floor(safe / 100) / 10)} s`;
  const minutes = Math.floor(safe / 60_000);
  const seconds = Math.floor((safe % 60_000) / 1000);
  return `${minutes} min ${seconds} s`;
}

/** The running turn's elapsed time; ticks on its own, so only it re-renders. */
function Elapsed({ language }: { language: string | undefined }) {
  const { turnWorkedMs } = useMessageChat();
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
  const { locale } = useMessageChat();
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
  /** The message is the last one of the chat. */
  isLatest: boolean;
  turnOutcome: TurnOutcome | null;
  /** The answer of the running request (latest message while loading). */
  active: boolean;
}

const ENDED_PIPELINE = new Set(['aborted', 'error', 'safety-stop']);

/**
 * The follow-ups shown under this answer (`suggestions.placement: 'message'`):
 * only under the latest answer of a completed turn while nothing runs and no
 * approval or clarification is open.
 */
function useFollowups(message: ChatMessage, isLatest: boolean, turnOutcome: TurnOutcome | null): string[] {
  const { suggestions, isLoading, isTurnRunning, pendingApprovals, messages, pipelineState } = useMessageChat();
  const count = suggestions?.count ?? 3;
  const candidates = useMemo(
    () => (suggestions?.placement === 'message' && message.role === 'assistant' ? readMessageFollowups(message, count) : []),
    [suggestions?.placement, message, count],
  );
  // A session change does not hide them (they are disabled while the composer is locked).
  if (candidates.length === 0 || suggestions?.enabled === false || !isLatest || (isTurnRunning ?? isLoading)) return [];
  if ((pendingApprovals?.length ?? 0) > 0) return [];
  if (findOpenClarification(messages ?? [message])) return [];
  if (turnOutcome && turnOutcome.status !== 'completed') return [];
  if (pipelineState && ENDED_PIPELINE.has(pipelineState.status)) return [];
  return candidates;
}

/**
 * Internal: the footer under an assistant answer. With `messageFooter`:
 * running, elapsed time and stop; done, copy, sources and the turn's working
 * time. With `suggestions.placement: 'message'` the follow-ups of the latest
 * answer. Renders nothing when no part applies.
 */
export function MessageFooter({ message, text, hasText, isLastOfTurn, isLatest, turnOutcome, active }: MessageFooterProps): ReactNode {
  const { messageFooter, locale, language, stop, canCompose, selectSuggestion } = useMessageChat();
  const sourcesId = useId();
  const followupsId = useId();
  const [sourcesOpen, setSourcesOpen] = useState(false);
  const sources = useMemo(
    () => (messageFooter?.sources && !active ? readMessageSources(message.parts) : []),
    [messageFooter?.sources, active, message.parts],
  );
  const followups = useFollowups(message, isLatest, turnOutcome);
  if (message.role !== 'assistant') return null;

  if (active) {
    if (!messageFooter || (!messageFooter.duration && !messageFooter.stop)) return null;
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

  const showCopy = Boolean(messageFooter?.copy) && hasText;
  const showSources = sources.length > 0;
  const showDuration = Boolean(messageFooter?.duration) && isLastOfTurn && turnOutcome?.status === 'completed'
    && typeof turnOutcome.durationMs === 'number';
  const showFollowups = followups.length > 0;
  if (!showCopy && !showSources && !showDuration && !showFollowups) return null;
  const sourcesLabel = sources.length === 1
    ? locale.messageSourceOneLabel ?? '1 source'
    : fillTemplate(locale.messageSourcesLabel ?? '{count} sources', { count: String(sources.length) });
  return (
    <div data-component="message-footer" data-state="done">
      {(showCopy || showSources || showDuration) && (
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
      )}
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
      {showFollowups && (
        <div data-element="follow-ups" role="group" aria-labelledby={followupsId}>
          <p id={followupsId} data-element="follow-ups-heading">{locale.followUpsLabel ?? 'Ask next'}</p>
          {followups.map((followup) => (
            <button
              key={followup}
              type="button"
              data-action="follow-up"
              disabled={canCompose === false}
              onClick={() => selectSuggestion(followup)}
            >
              {followup}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
