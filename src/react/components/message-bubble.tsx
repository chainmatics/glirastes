import ReactMarkdown from 'react-markdown';
import { MentionChip as DefaultMentionChip } from './mention-chip.js';
import { useChatContext } from '../provider/chat-context.js';
import { parseMentionSegments, stripContextBlocks } from '../utils/mention-markup.js';
import type { MessageBubbleProps, TextPart } from '../types.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function shouldRenderToolResult(
  toolName: string,
  mode: 'default' | 'hidden' | 'allowlist',
  allowlist: string[],
): boolean {
  if (mode === 'hidden') return false;
  if (mode === 'allowlist') return allowlist.includes(toolName);
  return true;
}

function isTextPart(part: unknown): part is TextPart {
  return isRecord(part) && part.type === 'text' && typeof part.text === 'string';
}

/**
 * Single message bubble.
 *
 * Renders text parts via Markdown component, mention markers as chips,
 * tool results via ToolResultBlock, and handles AI SDK 5.x/6.x tool part
 * format (`type: 'tool-{name}'`).
 *
 * Uses `data-role` attribute for styling (user/assistant/system).
 */
export function MessageBubble({ message, className }: MessageBubbleProps) {
  const { classNames, components, toolResults } = useChatContext();
  const MarkdownComponent = components.Markdown ?? DefaultMarkdown;
  const ToolResultComponent = components.ToolResultBlock ?? DefaultToolResult;
  const MentionChipComponent = components.MentionChip ?? DefaultMentionChip;

  const mode = toolResults.mode ?? 'default';
  const allowlist = toolResults.allowlist ?? [];

  // Extract tool result summaries as fallback text when no text parts exist
  const cleanTextParts = message.parts
    .filter(isTextPart)
    .filter((p) => p.text.trim())
    .map((p) => stripContextBlocks(p.text));
  const hasTextContent = cleanTextParts.some((text) => text.trim().length > 0);

  // Build fallback summary from tool outputs
  let fallbackSummary = '';
  if (!hasTextContent && message.role === 'assistant') {
    const summaries: string[] = [];
    for (const part of message.parts) {
      if (!isRecord(part)) continue;
      const partType = typeof part.type === 'string' ? part.type : '';

      // Handle tool-{name} parts (AI SDK 5.x/6.x format)
      if (partType.startsWith('tool-') && part.state === 'output-available' && isRecord(part.output)) {
        if (typeof part.output.message === 'string') {
          summaries.push(part.output.message);
        }
      }

      // Handle tool-result parts
      if (partType === 'tool-result' && isRecord(part.result)) {
        if (typeof part.result.message === 'string') {
          summaries.push(part.result.message);
        }
      }
    }
    fallbackSummary = summaries[0] ?? '';
  }

  // Skip truly empty assistant messages
  if (message.role === 'assistant' && !hasTextContent && !fallbackSummary) {
    const hasToolOutput = message.parts.some(p => {
      if (!isRecord(p)) return false;
      const t = typeof p.type === 'string' ? p.type : '';
      return (t.startsWith('tool-') && p.state === 'output-available') || t === 'tool-result';
    });
    if (!hasToolOutput) return null;
  }

  return (
    <div
      className={className ?? classNames.messageBubble}
      data-component="message-bubble"
      data-role={message.role}
    >
      {/* Render text parts */}
      {cleanTextParts.map((text, i) => {
        const segments = parseMentionSegments(text);
        const hasMention = segments.some((segment) => segment.kind === 'mention');

        if (!hasMention) {
          if (!text.trim()) return null;
          return (
            <MarkdownComponent
              key={`text-${i}`}
              content={text}
            />
          );
        }

        return (
          <div key={`mention-text-${i}`} data-component="message-rich-text">
            {segments.map((segment, index) => {
              if (segment.kind === 'text') {
                if (!segment.text) return null;
                return (
                  <span key={`segment-text-${index}`} data-component="message-rich-text-part">
                    {segment.text}
                  </span>
                );
              }

              return (
                <MentionChipComponent
                  key={`segment-mention-${index}`}
                  mention={segment.mention}
                  inline
                />
              );
            })}
          </div>
        );
      })}

      {/* Render fallback summary if no text parts */}
      {!hasTextContent && fallbackSummary && (
        <MarkdownComponent content={fallbackSummary} />
      )}

      {/* Render tool results via ToolResultBlock */}
      {message.parts.map((part, i) => {
        // Standard ToolResultPart
        if ('toolName' in part && 'result' in part && part.result !== undefined) {
          if (!shouldRenderToolResult(part.toolName, mode, allowlist)) return null;
          return (
            <ToolResultComponent
              key={`tool-${i}`}
              toolName={part.toolName}
              result={part.result}
            />
          );
        }

        // AI SDK 5.x/6.x tool-{name} parts with output
        if (isRecord(part)) {
          const partType = typeof part.type === 'string' ? part.type : '';
          if (partType.startsWith('tool-') && part.state === 'output-available' && part.output !== undefined) {
            const toolName = partType.replace('tool-', '');
            // Skip suggest_followups — handled by suggestion system
            if (toolName === 'suggest_followups') return null;
            if (!shouldRenderToolResult(toolName, mode, allowlist)) return null;
            return (
              <ToolResultComponent
                key={`tool-${i}`}
                toolName={toolName}
                result={part.output}
              />
            );
          }
        }

        return null;
      })}
    </div>
  );
}

function DefaultMarkdown({ content, className }: { content: string; className?: string }) {
  return (
    <div className={className} data-component="markdown">
      <ReactMarkdown>{content}</ReactMarkdown>
    </div>
  );
}

function DefaultToolResult({
  toolName,
  result,
  className,
}: {
  toolName: string;
  result: unknown;
  className?: string;
}) {
  if (isRecord(result) && typeof result.message === 'string' && result.message.trim().length > 0) {
    return (
      <div className={className} data-component="tool-result" data-tool={toolName}>
        {result.message}
      </div>
    );
  }

  return (
    <details className={className} data-component="tool-result" data-tool={toolName}>
      <summary>{toolName}</summary>
      <pre>{JSON.stringify(result, null, 2)}</pre>
    </details>
  );
}
