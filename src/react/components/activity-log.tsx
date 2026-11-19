import { useState, type SyntheticEvent } from 'react';
import { useChatContext } from '../provider/chat-context.js';
import type { TurnNoticeProps, TurnNoticeStatus } from '../types.js';
import type { ActivityStep, ActivityStepStatus } from '../utils/activity.js';
import { StatusIcon, type StatusIconKind } from './status-icon.js';

export interface ActivityLogProps {
  steps: ActivityStep[];
  /** True while this message's turn still runs. */
  active: boolean;
  /** Pipeline stop or error text shown as the last line. */
  notice?: string;
  /** Status behind `notice`, handed to a `components.TurnNotice` slot (default `'error'`). */
  noticeStatus?: TurnNoticeStatus;
  className?: string;
}

/** Replaces every `{name}` in a locale text. */
export function fillLocaleText(template: string, values: Readonly<Record<string, string | number>>): string {
  return template.replace(/\{(\w+)\}/g, (match, name: string) => (name in values ? String(values[name]) : match));
}

/**
 * Default turn notice: the last line of the log (`data-element="activity-notice"`)
 * or, outside it, its own element (`data-component="turn-notice"`).
 */
export function TurnNotice({ text, status, placement }: TurnNoticeProps) {
  if (placement === 'log') return <p data-element="activity-notice">{text}</p>;
  return <p data-component="turn-notice" data-status={status}>{text}</p>;
}

const STEP_ICONS: Record<ActivityStepStatus, StatusIconKind> = {
  done: 'check',
  error: 'error',
  running: 'spinner',
  waiting: 'pending',
  declined: 'declined',
  expected: 'notice',
};

/**
 * The same tool run several times in a row with the same outcome reads as
 * one line with its count. A step with its own detail text stays a line.
 */
function foldRepeatedSteps(steps: ActivityStep[]): Array<{ step: ActivityStep; count: number }> {
  const lines: Array<{ step: ActivityStep; count: number }> = [];
  for (const step of steps) {
    const last = lines.at(-1);
    if (
      last
      && last.step.toolName === step.toolName
      && last.step.status === step.status
      && last.step.declinedBy === step.declinedBy
      && !last.step.detail
      && !step.detail
    ) {
      last.count += 1;
    } else {
      lines.push({ step, count: 1 });
    }
  }
  return lines;
}

/**
 * Collapsible work log of one assistant turn, modelled on how Claude Code
 * shows tool calls: one line with a spinner while the turn runs, then a
 * summary that expands to the steps in the order they ran.
 *
 * Keeps styling neutral via `data-*` attributes.
 */
export function ActivityLog({ steps, active, notice, noticeStatus, className }: ActivityLogProps) {
  const { locale, toolLabels, components, activityLog } = useChatContext();
  // The user's own toggle wins over expandWhileRunning; null until the user toggles.
  const [userOpen, setUserOpen] = useState<boolean | null>(null);
  if (steps.length === 0) return null;

  const label = (toolName: string) => toolLabels.labels?.[toolName]?.singular ?? toolName;
  const running = steps.find((step) => step.status === 'running');
  const failed = steps.filter((step) => step.status === 'error').length;
  // A declined call is not a failure: counted on its own, never turns the summary to error.
  const declined = steps.filter((step) => step.status === 'declined').length;
  // An expected failure (classifyToolFailure) is a normal answer: counted on its own as well.
  const expected = steps.filter((step) => step.status === 'expected').length;
  const waiting = steps.some((step) => step.status === 'waiting');
  // Counted on their own too, so the summary is true for every mix ("1 step done, 1 declined", "2 declined").
  const done = steps.filter((step) => step.status === 'done').length;

  const state = running || active ? 'running' : waiting ? 'waiting' : failed > 0 ? 'error' : 'done';

  const separator = locale.activitySummarySeparator ?? ', ';

  let summaryIcon: StatusIconKind;
  let summaryText: string;
  if (state === 'running') {
    summaryIcon = 'spinner';
    const current = running ? label(running.toolName) : locale.activityWorkingLabel;
    summaryText = activityLog?.runningProgress && done > 0
      ? fillLocaleText(locale.activityRunningProgressLabel ?? '{count} done, {label}…', { count: done, label: current })
      : fillLocaleText(locale.activityRunningLabel ?? '{label}…', { label: current });
  } else if (state === 'waiting') {
    summaryIcon = 'pending';
    summaryText = locale.activityWaitingLabel;
  } else {
    summaryIcon = failed > 0 ? 'error' : 'check';
    const counts: string[] = [];
    if (done > 0) {
      counts.push(done === 1 ? locale.activityDoneOneLabel : fillLocaleText(locale.activityDoneLabel, { count: done }));
    }
    if (failed > 0) counts.push(fillLocaleText(locale.activityFailedLabel, { count: failed }));
    if (declined > 0) counts.push(fillLocaleText(locale.activityDeclinedLabel, { count: declined }));
    if (expected > 0) counts.push(fillLocaleText(locale.activityExpectedLabel, { count: expected }));
    summaryText = counts.join(separator);
  }

  const NoticeComponent = components?.TurnNotice ?? TurnNotice;
  // Only with expandWhileRunning is `open` controlled; otherwise the element stays as before.
  const controlled = activityLog?.expandWhileRunning === true;
  const open = userOpen ?? state === 'running';
  const openProps = controlled
    ? {
      open,
      onToggle: (event: SyntheticEvent<HTMLDetailsElement>) => {
        // The browser also fires `toggle` for the `open` React sets: only a change of the user counts.
        if (event.currentTarget.open !== open) setUserOpen(event.currentTarget.open);
      },
    }
    : {};

  return (
    <details className={className} data-component="activity-log" data-state={state} {...openProps}>
      <summary data-element="activity-summary">
        <StatusIcon icon={summaryIcon} />
        <span data-element="label">{summaryText}</span>
      </summary>
      <ol data-element="activity-steps">
        {foldRepeatedSteps(steps).map(({ step, count }) => (
          <li key={step.id} data-element="activity-step" data-status={step.status}>
            <StatusIcon icon={STEP_ICONS[step.status]} />
            <span data-element="label">
              {count > 1 ? toolLabels.labels?.[step.toolName]?.plural ?? label(step.toolName) : label(step.toolName)}
            </span>
            {count > 1 && (
              <span data-element="count">{fillLocaleText(locale.activityStepCountLabel ?? '×{count}', { count })}</span>
            )}
            {step.detail && <span data-element="detail">{step.detail}</span>}
          </li>
        ))}
      </ol>
      {notice && <NoticeComponent text={notice} status={noticeStatus ?? 'error'} placement="log" />}
    </details>
  );
}
