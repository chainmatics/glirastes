import { useMemo } from 'react';
import { useChatContext } from '../provider/chat-context.js';
import type { PipelineTimelineProps, PipelineState, PipelineStepReport } from '../types.js';

/** A single tool call is not worth a checklist; two or more are. */
const MIN_TOOL_CALLS = 2;

type ChecklistStatus = 'completed' | 'running' | 'pending';

interface ChecklistItem {
  key: string;
  toolName: string;
  status: ChecklistStatus;
  step: PipelineStepReport;
}

function statusLabel(status: PipelineState['status'], labels: {
  running: string;
  completed: string;
  safetyStop: string;
  aborted: string;
  error: string;
}) {
  switch (status) {
    case 'running':
      return labels.running;
    case 'completed':
      return labels.completed;
    case 'safety-stop':
      return labels.safetyStop;
    case 'aborted':
      return labels.aborted;
    case 'error':
      return labels.error;
    default:
      return labels.running;
  }
}

/** One row per tool call; calls that wait for approval have not run yet. */
function toChecklist(steps: PipelineStepReport[]): ChecklistItem[] {
  return steps.flatMap((step) =>
    step.toolCalls.map((toolName, index): ChecklistItem => ({
      key: `step-${step.stepNumber}-${index}`,
      toolName,
      status: step.requiresApproval ? 'pending' : 'completed',
      step,
    })),
  );
}

/**
 * Inline icons carry their own shape and motion (SMIL), so the checklist
 * reads correctly in unstyled mode without any stylesheet.
 */
function StatusIcon({ status }: { status: ChecklistStatus }) {
  const icon = status === 'completed' ? 'check' : status === 'running' ? 'spinner' : 'pending';
  return (
    <svg
      data-element="icon"
      data-icon={icon}
      viewBox="0 0 16 16"
      width="14"
      height="14"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {icon === 'check' && <path d="M3 8.5l3.5 3.5L13 4.5" />}
      {icon === 'pending' && <circle cx="8" cy="8" r="5.5" strokeWidth="1.5" opacity="0.5" />}
      {icon === 'spinner' && (
        <path d="M8 2.5a5.5 5.5 0 1 1-5.5 5.5">
          <animateTransform
            attributeName="transform"
            type="rotate"
            from="0 8 8"
            to="360 8 8"
            dur="0.9s"
            repeatCount="indefinite"
          />
        </path>
      )}
    </svg>
  );
}

/**
 * Compact step checklist for multi-step requests: a check for done tool
 * calls, a spinner while the pipeline still works, dimmed rows for calls
 * waiting on approval. Each row expands to its step summary. Renders
 * nothing for fewer than two tool calls.
 *
 * Keeps styling neutral via `data-*` attributes.
 */
export function PipelineTimeline({
  steps,
  pipelineState,
  isLoading,
  onStop,
  className,
}: PipelineTimelineProps) {
  const { classNames, locale, toolLabels, pipelineMessageTranslator, stepSummaryFormatter } = useChatContext();

  const translateTool = (name: string): string =>
    toolLabels.labels?.[name]?.singular ?? name;

  const currentStatus = pipelineState?.status ?? (isLoading ? 'running' : null);

  const labels = useMemo(() => ({
    running: locale.pipelineRunningLabel ?? 'Running',
    completed: locale.pipelineCompletedLabel ?? 'Completed',
    safetyStop: locale.pipelineSafetyStopLabel ?? 'Safety stop',
    aborted: locale.pipelineAbortedLabel ?? 'Stopped',
    error: locale.pipelineErrorLabel ?? 'Error',
    step: locale.pipelineStepLabel ?? 'Step',
    approvalPending: locale.pipelineApprovalPendingLabel ?? 'Approval pending',
  }), [locale]);

  const items = useMemo(() => toChecklist(steps), [steps]);
  if (items.length < MIN_TOOL_CALLS) return null;

  const awaitingApproval = items.some((item) => item.status === 'pending');
  const showRunning = isLoading && !awaitingApproval;

  return (
    <section
      className={className ?? classNames.pipelineTimeline}
      data-component="pipeline-timeline"
      data-state={currentStatus ?? 'idle'}
    >
      <div data-element="header">
        <div data-element="header-left">
          <strong>{locale.pipelineTitle ?? 'Pipeline'}</strong>
        </div>
        <div data-element="header-right">
          {currentStatus && (
            <span data-element="status">
              {statusLabel(currentStatus, labels)}
            </span>
          )}
          {isLoading && (
            <button type="button" onClick={() => onStop?.()} data-action="stop-pipeline">
              {locale.stopButton}
            </button>
          )}
        </div>
      </div>

      <ol data-element="steps">
        {items.map((item) => {
          const summary = stepSummaryFormatter ? stepSummaryFormatter(item.step) : item.step.summary;
          return (
            <li key={item.key} data-element="step" data-status={item.status}>
              <details>
                <summary data-element="step-summary">
                  <StatusIcon status={item.status} />
                  <span data-element="tools">{translateTool(item.toolName)}</span>
                  {item.status === 'pending' && (
                    <span data-element="approval">{labels.approvalPending}</span>
                  )}
                </summary>
                <div data-element="detail">
                  <span data-element="title">{`${labels.step} ${item.step.stepNumber + 1}`}</span>
                  {summary && <span data-element="summary">{summary}</span>}
                </div>
              </details>
            </li>
          );
        })}
        {showRunning && (
          <li data-element="step" data-status="running">
            <StatusIcon status="running" />
            <span data-element="tools">{labels.running}</span>
          </li>
        )}
      </ol>

      {pipelineState?.message && (
        <p data-element="message">
          {pipelineMessageTranslator
            ? pipelineMessageTranslator(pipelineState.message)
            : pipelineState.message}
        </p>
      )}
    </section>
  );
}
