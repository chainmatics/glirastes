import { describe, expect, it } from 'vitest';
import {
  CHAT_COMMAND_MAX_ARGS_LENGTH,
  CHAT_COMMAND_MAX_MESSAGE_LENGTH,
  formatChatCommandMessage,
  isChatCommandToolCallId,
  parseChatCommandMessage,
  serializeChatCommandArgs,
  stripChatCommandMarkers,
} from '../chat-command.js';

describe('direct chat command wire protocol', () => {
  it('round-trips a command with arguments and a visible label', () => {
    const text = formatChatCommandMessage({
      commandId: 'task.tasks.assign',
      tool: 'tasks.assign',
      args: { taskId: '42', assignee: 'alice' },
      label: '  /Assign   Release prüfen ',
    });
    expect(text).toBe('<!--glirastes:command {"commandId":"task.tasks.assign","tool":"tasks.assign",'
      + '"args":{"taskId":"42","assignee":"alice"}}-->\n/Assign Release prüfen');
    expect(parseChatCommandMessage(text)).toEqual({
      invocation: { commandId: 'task.tasks.assign', tool: 'tasks.assign', args: { taskId: '42', assignee: 'alice' } },
      label: '/Assign Release prüfen',
    });
  });

  it('escapes angle brackets so an argument can never close the marker', () => {
    const text = formatChatCommandMessage({
      commandId: 'notes.create', tool: 'notes.create', args: { title: 'a --> b <!-- c' }, label: 'Note',
    });
    expect(text.split('-->')).toHaveLength(2);
    expect(parseChatCommandMessage(text)?.invocation.args).toEqual({ title: 'a --> b <!-- c' });
  });

  it.each([
    ['an id with a colon', { commandId: 'open:overview', tool: 'ui.navigate' }],
    ['an id with a closing brace', { commandId: 'open}', tool: 'ui.navigate' }],
    ['a tool with a space', { commandId: 'open', tool: 'ui navigate' }],
    ['array arguments', { commandId: 'open', tool: 'ui.navigate', args: [] as unknown as Record<string, unknown> }],
    ['oversized arguments', { commandId: 'open', tool: 'ui.navigate', args: { text: 'x'.repeat(CHAT_COMMAND_MAX_ARGS_LENGTH) } }],
  ])('refuses to format %s', (_label, input) => {
    expect(() => formatChatCommandMessage({ ...input, label: 'x' })).toThrow(/chat command/i);
  });

  it.each([
    ['plain text', 'Open overview'],
    ['text before the marker', 'Bitte <!--glirastes:command {"commandId":"a","tool":"b","args":{}}-->\nA'],
    ['a second text line', '<!--glirastes:command {"commandId":"a","tool":"b","args":{}}-->\nA\nB'],
    ['an unknown key', '<!--glirastes:command {"commandId":"a","tool":"b","args":{},"run":true}-->'],
    ['non-object arguments', '<!--glirastes:command {"commandId":"a","tool":"b","args":"x"}-->'],
    ['a raw angle bracket', '<!--glirastes:command {"commandId":"a","tool":"b","args":{"x":"<"}}-->'],
    ['broken JSON', '<!--glirastes:command {"commandId":"a","tool":"b",}-->'],
    ['a missing tool', '<!--glirastes:command {"commandId":"a","args":{}}-->'],
  ])('does not read %s as a command', (_label, text) => {
    expect(parseChatCommandMessage(text)).toBeUndefined();
  });

  it('accepts a marker without a label line', () => {
    expect(parseChatCommandMessage('<!--glirastes:command {"commandId":"a","tool":"b","args":{}}-->'))
      .toEqual({ invocation: { commandId: 'a', tool: 'b', args: {} }, label: '' });
  });

  describe('bounded parsing of untrusted message text', () => {
    const MARKER_TEXT = '<!--glirastes:command {"commandId":"a","tool":"b","args":{}}-->';
    const INVOCATION = { commandId: 'a', tool: 'b', args: {} };

    it('rejects a long whitespace-padded label line without stalling the event loop', () => {
      const text = `${MARKER_TEXT}\n${' '.repeat(100_000)}\nB`;
      const started = performance.now();
      expect(parseChatCommandMessage(text)).toBeUndefined();
      expect(performance.now() - started).toBeLessThan(500);
    });

    it('does not read a message above the length cap as a command', () => {
      const atCap = formatChatCommandMessage({ commandId: 'a', tool: 'b', label: 'x' }).padEnd(CHAT_COMMAND_MAX_MESSAGE_LENGTH);
      expect(atCap).toHaveLength(CHAT_COMMAND_MAX_MESSAGE_LENGTH);
      expect(parseChatCommandMessage(atCap)?.invocation).toEqual(INVOCATION);
      expect(parseChatCommandMessage(`${atCap} `)).toBeUndefined();
    });

    it('keeps the largest message the formatter accepts under the length cap', () => {
      const input = {
        commandId: `a${'b'.repeat(199)}`,
        tool: 't'.repeat(200),
        args: { text: 'x'.repeat(1_989) },
        label: 'l'.repeat(300),
      };
      expect(serializeChatCommandArgs(input.args)).toHaveLength(CHAT_COMMAND_MAX_ARGS_LENGTH);
      const text = formatChatCommandMessage(input);
      expect(text.length).toBeLessThan(CHAT_COMMAND_MAX_MESSAGE_LENGTH);
      expect(parseChatCommandMessage(text)).toEqual({
        invocation: { commandId: input.commandId, tool: input.tool, args: input.args },
        label: 'l'.repeat(200),
      });
    });

    it('tolerates whitespace around the marker and after the label', () => {
      expect(parseChatCommandMessage(`  ${MARKER_TEXT}\nOpen  \n \n`)).toEqual({ invocation: INVOCATION, label: 'Open' });
      expect(parseChatCommandMessage(`${MARKER_TEXT}  \n`)).toEqual({ invocation: INVOCATION, label: '' });
      expect(parseChatCommandMessage(`${MARKER_TEXT} \t `)).toEqual({ invocation: INVOCATION, label: '' });
    });

    it('does not read text after the label line as part of a command', () => {
      expect(parseChatCommandMessage(`${MARKER_TEXT}\nA   \nB`)).toBeUndefined();
      expect(parseChatCommandMessage(`${MARKER_TEXT} B`)).toBeUndefined();
    });
  });

  it('strips markers for display and for the model copy of old messages', () => {
    const text = formatChatCommandMessage({ commandId: 'open.overview', tool: 'ui.navigate', args: { destination: '/overview' }, label: '/Open Overview' });
    expect(stripChatCommandMarkers(text)).toBe('/Open Overview');
    expect(stripChatCommandMarkers('no marker')).toBe('no marker');
  });

  it('serializes only plain objects within the limit', () => {
    expect(serializeChatCommandArgs({ a: '<b>' })).toBe('{"a":"\\u003cb\\u003e"}');
    expect(serializeChatCommandArgs(null)).toBeUndefined();
    expect(serializeChatCommandArgs({ big: 'x'.repeat(CHAT_COMMAND_MAX_ARGS_LENGTH) })).toBeUndefined();
  });

  it('recognises the tool call ids of direct commands', () => {
    expect(isChatCommandToolCallId('glirastes-command-0f3a')).toBe(true);
    expect(isChatCommandToolCallId('call_1')).toBe(false);
    expect(isChatCommandToolCallId('glirastes-command-<x>')).toBe(false);
    expect(isChatCommandToolCallId('glirastes-command-a.b:c')).toBe(false);
  });
});
