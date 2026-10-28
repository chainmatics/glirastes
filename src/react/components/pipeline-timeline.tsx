import { useMemo, useState, useRef, useEffect } from 'react';
import { useChatContext } from '../provider/chat-context.js';
import type { PipelineTimelineProps, PipelineState } from '../types.js';

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

/**
 * Vertical step timeline for the streamed pipeline report.
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

  /** Translate a raw tool name via toolLabels (singular/plural). */
  const translateToolCalls = (toolCalls: string[]): string => {
    const labelMap = toolLabels.labels;
    if (!labelMap) return toolCalls.join(', ');
    return toolCalls
      .map((name) => {
        const entry = labelMap[name];
        return entry ? entry.singular : name;
      })
      .join(', ');
  };

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

  const [collapsed, setCollapsed] = useState(true);
  const scrollRef = useRef<HTMLOListElement>(null);

  // Auto-scroll to bottom when new steps arrive
  useEffect(() => {
    if (!collapsed && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [steps.length, collapsed]);

  const hasContent = steps.length > 0 || currentStatus !== null;
  if (!hasContent) return null;

  return (
    <section
      className={className ?? classNames.pipelineTimeline}
      data-component="pipeline-timeline"
      data-state={currentStatus ?? 'idle'}
      data-collapsed={collapsed ? 'true' : 'false'}
    >
      <div data-element="header" onClick={() => setCollapsed(c => !c)} role="button" tabIndex={0} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setCollapsed(c => !c); } }}>
        <div data-element="header-left">
          <span data-element="chevron" aria-hidden="true" />
          <strong>{locale.pipelineTitle ?? 'Pipeline'}</strong>
          {collapsed && steps.length > 0 && (
            <span data-element="step-count">{steps.length}</span>
          )}
        </div>
        <div data-element="header-right">
          {currentStatus && (
            <span data-element="status">
              {statusLabel(currentStatus, labels)}
            </span>
          )}
          {isLoading && (
            <button type="button" onClick={(e) => { e.stopPropagation(); onStop?.(); }} data-action="stop-pipeline">
              {locale.stopButton}
            </button>
          )}
        </div>
      </div>

      {!collapsed && (
        <>
          <ol data-element="steps" ref={scrollRef}>
            {steps.map((step) => {
              const summary = stepSummaryFormatter ? stepSummaryFormatter(step) : step.summary;
              return (
                <li
                  key={`step-${step.stepNumber}`}
                  data-element="step"
                  data-status={step.requiresApproval ? 'approval-pending' : 'completed'}
                  title={summary}
                >
                  <span data-element="title">{step.stepNumber + 1}</span>
                  {step.toolCalls.length > 0 ? (
                    <span data-element="tools">{translateToolCalls(step.toolCalls)}</span>
                  ) : (
                    <span data-element="summary">{summary}</span>
                  )}
                  {step.requiresApproval && (
                    <span data-element="approval">{labels.approvalPending}</span>
                  )}
                </li>
              );
            })}
          </ol>

          {pipelineState?.message && (
            <p data-element="message">
              {pipelineMessageTranslator
                ? pipelineMessageTranslator(pipelineState.message)
                : pipelineState.message}
            </p>
          )}
        </>
      )}
    </section>
  );
}
