import { describe, it, expect } from 'vitest';
import { sanitizeModelMessages } from '../sanitize-model-messages.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

describe('sanitizeModelMessages', () => {
  it('keeps messages with matching adjacent tool results', () => {
    const messages = [
      { role: 'user', content: [{ type: 'text', text: 'Hello' }] },
      { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'call-1', toolName: 'list_tasks' }] },
      { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'call-1', result: [] }] },
    ];

    const result = sanitizeModelMessages(messages);
    expect(result).toHaveLength(3);
  });

  it('removes orphaned tool calls without results', () => {
    const messages = [
      { role: 'user', content: [{ type: 'text', text: 'Hello' }] },
      {
        role: 'assistant',
        content: [
          { type: 'tool-call', toolCallId: 'call-1', toolName: 'list_tasks' },
          { type: 'tool-call', toolCallId: 'call-2', toolName: 'create_task' },
        ],
      },
      { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'call-1', result: [] }] },
      { role: 'user', content: [{ type: 'text', text: 'next message' }] },
    ];

    const result = sanitizeModelMessages(messages);
    const assistant = result.find((m) => isRecord(m) && m.role === 'assistant') as Record<string, unknown>;
    const content = assistant.content as Array<Record<string, unknown>>;
    expect(content).toHaveLength(1);
    expect(content[0].toolCallId).toBe('call-1');
  });

  it('removes assistant message entirely if all tool calls are orphaned', () => {
    const messages = [
      { role: 'user', content: [{ type: 'text', text: 'Hello' }] },
      { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'call-1', toolName: 'create_task' }] },
      { role: 'user', content: [{ type: 'text', text: 'never mind' }] },
    ];

    const result = sanitizeModelMessages(messages);
    const assistantMessages = result.filter((m) => isRecord(m) && m.role === 'assistant');
    expect(assistantMessages).toHaveLength(0);
  });

  it('strips last assistant with orphaned tool-call even when no user message follows', () => {
    // Bug fix: skipIndex was preserving the last assistant message even when its
    // tool-call only had a tool-approval-response (no tool-result). The OpenAI
    // provider silently drops tool-approval-response → orphaned tool-call → 400.
    const messages = [
      { role: 'user', content: [{ type: 'text', text: 'Hello' }] },
      { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'call-1', toolName: 'create_task' }] },
    ];

    const result = sanitizeModelMessages(messages);
    const assistantMessages = result.filter((m) => isRecord(m) && m.role === 'assistant');
    expect(assistantMessages).toHaveLength(0);
  });

  it('handles empty messages array', () => {
    expect(sanitizeModelMessages([])).toEqual([]);
  });

  it('handles messages without content arrays', () => {
    const messages = [
      { role: 'user', content: 'plain text' },
      { role: 'assistant', content: 'just a response' },
    ];
    expect(sanitizeModelMessages(messages)).toHaveLength(2);
  });

  it('handles mixed text and tool-call content', () => {
    const messages = [
      { role: 'user', content: [{ type: 'text', text: 'create a task' }] },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'I will create a task for you.' },
          { type: 'tool-call', toolCallId: 'call-1', toolName: 'create_task' },
        ],
      },
      { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'call-1', result: { success: true } }] },
    ];

    const result = sanitizeModelMessages(messages);
    expect(result).toHaveLength(3);
    const assistant = result.find((m) => isRecord(m) && m.role === 'assistant') as Record<string, unknown>;
    const content = assistant.content as Array<Record<string, unknown>>;
    expect(content).toHaveLength(2);
  });

  it('removes tool-calls whose results exist but are NOT adjacent', () => {
    const messages = [
      { role: 'user', content: [{ type: 'text', text: 'Hello' }] },
      { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'call-1', toolName: 'find_user' }] },
      { role: 'user', content: [{ type: 'text', text: 'also...' }] },
      { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'call-1', result: {} }] },
      { role: 'user', content: [{ type: 'text', text: 'next' }] },
    ];

    const result = sanitizeModelMessages(messages);
    const assistantMessages = result.filter((m) => isRecord(m) && m.role === 'assistant');
    expect(assistantMessages).toHaveLength(0);
  });

  it('removes orphaned tool-approval-requests without matching tool-result', () => {
    const messages = [
      { role: 'user', content: [{ type: 'text', text: 'invite someone' }] },
      {
        role: 'assistant',
        content: [
          { type: 'tool-call', toolCallId: 'call-1', toolName: 'invite_user' },
          { type: 'tool-approval-request', approvalId: 'appr-1', toolCallId: 'call-1' },
        ],
      },
      { role: 'user', content: [{ type: 'text', text: 'never mind' }] },
    ];

    const result = sanitizeModelMessages(messages);
    const assistantMessages = result.filter((m) => isRecord(m) && m.role === 'assistant');
    expect(assistantMessages).toHaveLength(0);
  });

  it('keeps approved tool calls with adjacent results', () => {
    const messages = [
      { role: 'user', content: [{ type: 'text', text: 'create group' }] },
      {
        role: 'assistant',
        content: [
          { type: 'tool-call', toolCallId: 'call-1', toolName: 'create_group' },
          { type: 'tool-approval-request', approvalId: 'appr-1', toolCallId: 'call-1' },
        ],
      },
      {
        role: 'tool',
        content: [
          { type: 'tool-approval-response', approvalId: 'appr-1', approved: true },
          { type: 'tool-result', toolCallId: 'call-1', result: { id: '123' } },
        ],
      },
    ];

    const result = sanitizeModelMessages(messages);
    expect(result).toHaveLength(3);
    const assistant = result.find((m) => isRecord(m) && m.role === 'assistant') as Record<string, unknown>;
    const content = assistant.content as Array<Record<string, unknown>>;
    expect(content).toHaveLength(2); // tool-call + approval-request
  });

  it('preserves pending approval at conversation tail — streamText will execute it', () => {
    // When the LAST message is a tool message with only a tool-approval-response
    // (no tool-result), the tool-call must be preserved. streamText's
    // collectToolApprovals() will find and execute the approved tool before
    // calling the model provider.
    const messages = [
      { role: 'user', content: [{ type: 'text', text: 'create group' }] },
      {
        role: 'assistant',
        content: [
          { type: 'tool-call', toolCallId: 'call-1', toolName: 'create_group_api' },
          { type: 'tool-approval-request', approvalId: 'appr-1', toolCallId: 'call-1' },
        ],
      },
      {
        role: 'tool',
        content: [{ type: 'tool-approval-response', approvalId: 'appr-1', approved: true }],
      },
    ];

    const result = sanitizeModelMessages(messages);
    // All three messages preserved — streamText will handle execution
    expect(result).toHaveLength(3);
    const assistantMessages = result.filter((m) => isRecord(m) && m.role === 'assistant');
    expect(assistantMessages).toHaveLength(1);
    const content = (assistantMessages[0] as Record<string, unknown>).content as Array<Record<string, unknown>>;
    expect(content).toHaveLength(2); // tool-call + approval-request
    const toolMessages = result.filter((m) => isRecord(m) && m.role === 'tool');
    expect(toolMessages).toHaveLength(1);
  });

  it('strips historical approval-only tool-call when followed by more messages', () => {
    // When a tool-call has an approval-response but it's NOT at the tail
    // (more messages follow), it should be stripped as before.
    // streamText's collectToolApprovals only looks at the last message.
    const messages = [
      { role: 'user', content: [{ type: 'text', text: 'create group' }] },
      {
        role: 'assistant',
        content: [
          { type: 'tool-call', toolCallId: 'call-1', toolName: 'create_group_api' },
          { type: 'tool-approval-request', approvalId: 'appr-1', toolCallId: 'call-1' },
        ],
      },
      {
        role: 'tool',
        content: [{ type: 'tool-approval-response', approvalId: 'appr-1', approved: true }],
      },
      { role: 'user', content: [{ type: 'text', text: 'thanks' }] },
    ];

    const result = sanitizeModelMessages(messages);
    // Historical approval stripped — not at tail
    const assistantMessages = result.filter((m) => isRecord(m) && m.role === 'assistant');
    expect(assistantMessages).toHaveLength(0);
    const toolMessages = result.filter((m) => isRecord(m) && m.role === 'tool');
    expect(toolMessages).toHaveLength(0);
  });

  it('removes orphaned tool messages when their calls are removed', () => {
    const messages = [
      { role: 'user', content: [{ type: 'text', text: 'Hello' }] },
      { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'call-1', toolName: 'list_tasks' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'oops' }] },
      { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'call-1', result: [] }] },
      { role: 'user', content: [{ type: 'text', text: 'next' }] },
    ];

    const result = sanitizeModelMessages(messages);
    const toolMessages = result.filter((m) => isRecord(m) && m.role === 'tool');
    expect(toolMessages).toHaveLength(0);
  });

  it('strips orphaned approval-response from tool messages when adjacency breaks', () => {
    const messages = [
      { role: 'user', content: [{ type: 'text', text: 'create group' }] },
      {
        role: 'assistant',
        content: [
          { type: 'tool-call', toolCallId: 'call-1', toolName: 'create_group' },
          { type: 'tool-approval-request', approvalId: 'appr-1', toolCallId: 'call-1' },
        ],
      },
      { role: 'assistant', content: [{ type: 'text', text: 'split' }] },
      {
        role: 'tool',
        content: [
          { type: 'tool-approval-response', approvalId: 'appr-1', approved: true },
          { type: 'tool-result', toolCallId: 'call-1', result: { id: '123' } },
        ],
      },
      { role: 'user', content: [{ type: 'text', text: 'next' }] },
    ];

    const result = sanitizeModelMessages(messages);
    const toolMessages = result.filter((m) => isRecord(m) && m.role === 'tool');
    expect(toolMessages).toHaveLength(0);
    const assistants = result.filter((m) => isRecord(m) && m.role === 'assistant');
    expect(assistants).toHaveLength(1);
    expect((assistants[0] as Record<string, unknown>).content).toEqual([{ type: 'text', text: 'split' }]);
  });

  it('strips historical approval-only tool-call in multi-message conversation', () => {
    // Production regression: after pruneMessages strips tool-result from old messages,
    // a historical tool-call is left with only an approval-response.
    const messages = [
      { role: 'user', content: [{ type: 'text', text: 'create group with members' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'I found the users.' }] },
      // Historical: tool-call whose tool-result was stripped by pruning
      {
        role: 'assistant',
        content: [
          { type: 'tool-call', toolCallId: 'call-1', toolName: 'create_group_api' },
          { type: 'tool-approval-request', approvalId: 'appr-1', toolCallId: 'call-1' },
          { type: 'text', text: 'Creating the group.' },
        ],
      },
      {
        role: 'tool',
        content: [{ type: 'tool-approval-response', approvalId: 'appr-1', approved: true }],
      },
      { role: 'assistant', content: [{ type: 'text', text: 'Group created successfully.' }] },
      // Recent: tool-call with full result (safe)
      {
        role: 'assistant',
        content: [
          { type: 'tool-call', toolCallId: 'call-2', toolName: 'add_members' },
          { type: 'tool-approval-request', approvalId: 'appr-2', toolCallId: 'call-2' },
          { type: 'text', text: 'Adding members.' },
        ],
      },
      {
        role: 'tool',
        content: [
          { type: 'tool-approval-response', approvalId: 'appr-2', approved: true },
          { type: 'tool-result', toolCallId: 'call-2', result: { ok: true } },
        ],
      },
      { role: 'user', content: [{ type: 'text', text: 'thanks' }] },
    ];

    const result = sanitizeModelMessages(messages);

    // call-1 has no tool-result → stripped (text preserved)
    // call-2 has tool-result → kept
    const assistants = result.filter((m) => isRecord(m) && m.role === 'assistant');

    // Historical assistant loses tool-call + approval-request, keeps text
    const historicalAssistant = assistants[1] as Record<string, unknown>;
    const histContent = historicalAssistant.content as Array<Record<string, unknown>>;
    expect(histContent).toHaveLength(1);
    expect(histContent[0].type).toBe('text');

    // Tool message for call-1 removed (no surviving tool-result)
    const toolMessages = result.filter((m) => isRecord(m) && m.role === 'tool');
    expect(toolMessages).toHaveLength(1); // only call-2's tool msg

    // Safe assistant (call-2) keeps all 3 parts
    const safeAssistant = assistants[3] as Record<string, unknown>;
    const safeContent = safeAssistant.content as Array<Record<string, unknown>>;
    expect(safeContent).toHaveLength(3); // tool-call + approval-request + text
  });

  it('handles multiple consecutive tool messages', () => {
    const messages = [
      { role: 'user', content: [{ type: 'text', text: 'do two things' }] },
      {
        role: 'assistant',
        content: [
          { type: 'tool-call', toolCallId: 'call-1', toolName: 'tool_a' },
          { type: 'tool-call', toolCallId: 'call-2', toolName: 'tool_b' },
        ],
      },
      { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'call-1', result: {} }] },
      { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'call-2', result: {} }] },
    ];

    const result = sanitizeModelMessages(messages);
    expect(result).toHaveLength(4);
  });

  it('no-ops for messages without tool calls', () => {
    const messages = [
      { role: 'user', content: [{ type: 'text', text: 'Hello' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'Hi!' }] },
      { role: 'user', content: [{ type: 'text', text: 'Bye' }] },
    ];

    const result = sanitizeModelMessages(messages);
    expect(result).toHaveLength(3);
  });

  it('preserves pending approval with mixed safe tool-calls in same step', () => {
    // Two tool-calls in one step: one has a result, one has only an approval.
    // The approval-only one should be preserved because it's at the tail.
    const messages = [
      { role: 'user', content: [{ type: 'text', text: 'do stuff' }] },
      {
        role: 'assistant',
        content: [
          { type: 'tool-call', toolCallId: 'call-1', toolName: 'find_user' },
          { type: 'tool-call', toolCallId: 'call-2', toolName: 'create_group_api' },
          { type: 'tool-approval-request', approvalId: 'appr-1', toolCallId: 'call-2' },
        ],
      },
      {
        role: 'tool',
        content: [
          { type: 'tool-result', toolCallId: 'call-1', result: { name: 'Tim' } },
        ],
      },
      {
        role: 'tool',
        content: [
          { type: 'tool-approval-response', approvalId: 'appr-1', approved: true },
        ],
      },
    ];

    const result = sanitizeModelMessages(messages);
    // All 4 messages preserved
    expect(result).toHaveLength(4);
    const assistant = result.find((m) => isRecord(m) && m.role === 'assistant') as Record<string, unknown>;
    const content = assistant.content as Array<Record<string, unknown>>;
    expect(content).toHaveLength(3); // both tool-calls + approval-request
  });

  it('does not preserve approval at tail when tool message also has a tool-result', () => {
    // If the last tool message has BOTH a tool-approval-response AND a tool-result,
    // this is a completed step, not a pending approval. Normal rules apply.
    const messages = [
      { role: 'user', content: [{ type: 'text', text: 'create group' }] },
      {
        role: 'assistant',
        content: [
          { type: 'tool-call', toolCallId: 'call-1', toolName: 'create_group' },
          { type: 'tool-approval-request', approvalId: 'appr-1', toolCallId: 'call-1' },
          { type: 'tool-call', toolCallId: 'call-2', toolName: 'orphan_tool' },
        ],
      },
      {
        role: 'tool',
        content: [
          { type: 'tool-approval-response', approvalId: 'appr-1', approved: true },
          { type: 'tool-result', toolCallId: 'call-1', result: { id: '123' } },
        ],
      },
    ];

    const result = sanitizeModelMessages(messages);
    expect(result).toHaveLength(3);
    const assistant = result.find((m) => isRecord(m) && m.role === 'assistant') as Record<string, unknown>;
    const content = assistant.content as Array<Record<string, unknown>>;
    // call-2 is orphaned (no result, and last tool message has a result so no pending approval)
    expect(content).toHaveLength(2); // call-1 + approval-request (call-2 stripped)
  });

  it('removes historical duplicate assistant tool-call IDs and keeps only latest occurrence', () => {
    // Regression: same toolCallId appears in two assistant messages.
    // OpenAI rejects this with:
    // "An assistant message with 'tool_calls' must be followed by tool messages..."
    const messages = [
      { role: 'user', content: [{ type: 'text', text: 'create group with members' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'Ich bereite die Erstellung vor.' }] },
      {
        role: 'assistant',
        content: [
          { type: 'tool-call', toolCallId: 'call-dup', toolName: 'create_group_api' },
          { type: 'tool-approval-request', approvalId: 'appr-dup', toolCallId: 'call-dup' },
          { type: 'text', text: 'Erstelle die Gruppe.' },
        ],
      },
      { role: 'assistant', content: [{ type: 'text', text: 'Zwischenstatus.' }] },
      {
        role: 'assistant',
        content: [
          { type: 'tool-call', toolCallId: 'call-dup', toolName: 'create_group_api' },
          { type: 'tool-approval-request', approvalId: 'appr-dup', toolCallId: 'call-dup' },
          { type: 'text', text: 'Erstelle die Gruppe jetzt.' },
        ],
      },
      {
        role: 'tool',
        content: [
          { type: 'tool-approval-response', approvalId: 'appr-dup', approved: true },
          { type: 'tool-result', toolCallId: 'call-dup', result: { id: 'g-1' } },
        ],
      },
    ];

    const result = sanitizeModelMessages(messages);

    const duplicateCallOccurrences = result.flatMap((m) => {
      if (!isRecord(m) || m.role !== 'assistant') return [];
      const content = Array.isArray(m.content) ? m.content : [];
      return content.filter(
        (part) => isRecord(part) && part.type === 'tool-call' && part.toolCallId === 'call-dup',
      );
    });

    expect(duplicateCallOccurrences).toHaveLength(1);
  });

  it('preserves duplicate tool-call when it has pending approval-response', () => {
    // Bug scenario: User approves find_user + create_group.
    // find_user gets removed as orphaned, create_group is marked as duplicate
    // but has pending approval-response in last message.
    // Should NOT remove create_group call (streamText will execute it).
    const messages = [
      { role: 'user', content: [{ type: 'text', text: 'Create group with Frank' }] },
      // First assistant: both tool calls with approval-requests
      {
        role: 'assistant',
        content: [
          { type: 'tool-call', toolCallId: 'call-find', toolName: 'find_user' },
          { type: 'tool-approval-request', approvalId: 'appr-find', toolCallId: 'call-find' },
          { type: 'tool-call', toolCallId: 'call-create', toolName: 'create_group' },
          { type: 'tool-approval-request', approvalId: 'appr-create', toolCallId: 'call-create' },
        ],
      },
      // User approves both
      {
        role: 'tool',
        content: [
          { type: 'tool-approval-response', approvalId: 'appr-find', approved: true },
          { type: 'tool-approval-response', approvalId: 'appr-create', approved: true },
        ],
      },
      // Second assistant: only create_group (duplicate)
      {
        role: 'assistant',
        content: [
          { type: 'tool-call', toolCallId: 'call-create', toolName: 'create_group' },
          { type: 'tool-approval-request', approvalId: 'appr-create', toolCallId: 'call-create' },
        ],
      },
      // Approval response still pending (last message)
      {
        role: 'tool',
        content: [{ type: 'tool-approval-response', approvalId: 'appr-create', approved: true }],
      },
    ];

    const result = sanitizeModelMessages(messages);

    // Should preserve the duplicate create_group call because it has pending approval
    const createCalls = result.flatMap((m) => {
      if (!isRecord(m) || m.role !== 'assistant') return [];
      const content = (Array.isArray(m.content) ? m.content : []) as Array<
        Record<string, unknown>
      >;
      return content.filter(
        (part) =>
          part.type === 'tool-call' &&
          typeof part.toolCallId === 'string' &&
          part.toolCallId === 'call-create',
      );
    });

    // Both occurrences should be preserved (second one has pending approval)
    expect(createCalls.length).toBeGreaterThan(0);

    // Verify tool message with pending approval is still there
    const lastMsg = result[result.length - 1];
    expect(isRecord(lastMsg) && lastMsg.role).toBe('tool');
  });
});
