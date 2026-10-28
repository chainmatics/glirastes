import { useChatContext } from '../provider/chat-context.js';
import type { ActivityStep, ActivityStepStatus } from '../utils/activity.js';
import { StatusIcon, type StatusIconKind } from './status-icon.js';

export interface ActivityLogProps {
  steps: ActivityStep[];
  /** True while this message's turn still runs. */
  active: boolean;
  /** Pipeline stop or error text shown as the last line. */
  notice?: string;
  className?: string;
}

const STEP_ICONS: Record<ActivityStepStatus, StatusIconKind> = {
  done: 'check',
  error: 'error',
  running: 'spinner',
  waiting: 'pending',
};

/**
 * Collapsible work log of one assistant turn, modelled on how Claude Code
 * shows tool calls: one line with a spinner while the turn runs, then a
 * summary that expands to the steps in the order they ran.
 *
 * Keeps styling neutral via `data-*` attributes.
 */
export function ActivityLog({ steps, active, notice, className }: ActivityLogProps) {
  const { locale, toolLabels } = useChatContext();
  if (steps.length === 0) return null;

  const label = (toolName: string) => toolLabels.labels?.[toolName]?.singular ?? toolName;
  const running = steps.find((step) => step.status === 'running');
  const failed = steps.filter((step) => step.status === 'error').length;
  const waiting = steps.some((step) => step.status === 'waiting');

  const state = running || active ? 'running' : waiting ? 'waiting' : failed > 0 ? 'error' : 'done';

  let summaryIcon: StatusIconKind;
  let summaryText: string;
  if (state === 'running') {
    summaryIcon = 'spinner';
    summaryText = `${running ? label(running.toolName) : locale.activityWorkingLabel}…`;
  } else if (state === 'waiting') {
    summaryIcon = 'pending';
    summaryText = locale.activityWaitingLabel;
  } else {
    summaryIcon = failed > 0 ? 'error' : 'check';
    summaryText = steps.length === 1
      ? locale.activityDoneOneLabel
      : locale.activityDoneLabel.replace('{count}', String(steps.length));
    if (failed > 0) {
      summaryText += `, ${locale.activityFailedLabel.replace('{count}', String(failed))}`;
    }
  }

  return (
    <details className={className} data-component="activity-log" data-state={state}>
      <summary data-element="activity-summary">
        <StatusIcon icon={summaryIcon} />
        <span data-element="label">{summaryText}</span>
      </summary>
      <ol data-element="activity-steps">
        {steps.map((step) => (
          <li key={step.id} data-element="activity-step" data-status={step.status}>
            <StatusIcon icon={STEP_ICONS[step.status]} />
            <span data-element="label">{label(step.toolName)}</span>
            {step.detail && <span data-element="detail">{step.detail}</span>}
          </li>
        ))}
      </ol>
      {notice && <p data-element="activity-notice">{notice}</p>}
    </details>
  );
}
