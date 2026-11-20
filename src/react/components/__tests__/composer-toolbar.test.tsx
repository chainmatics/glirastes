// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useMemo, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SttProviderAdapter } from '../../stt/controller.js';
import { defineChatCommand, defineChatEntity } from '../../interactions/definitions.js';
import { AiChatProvider } from '../../provider/ai-chat-provider.js';
import type {
  ChatComponents,
  ChatComposerInputControls,
  ChatTransport,
  ComposerConfig,
  ComposerToolbarProps,
  MentionInputProps,
} from '../../types.js';
import { ChatInput } from '../chat-input.js';
import { MentionInput } from '../mention-input.js';

const person = defineChatEntity({
  type: 'person',
  label: 'Person',
  search: () => [{ id: '7', label: 'Müller' }],
  resolve: (id) => (id === '7' ? { id: '7', label: 'Müller' } : undefined),
});
const commands = [
  defineChatCommand({ id: 'open.tasks', label: 'Open Tasks', run: { kind: 'ui', tool: 'ui.navigate', args: { destination: '/tasks' } } }),
];

const adapter: SttProviderAdapter = {
  connect: async () => ({ finalize: async () => {}, cancel: async () => {}, close: async () => {} }),
};

function transport(): ChatTransport {
  return {
    messages: [], status: 'ready', error: null,
    sendMessage: vi.fn(async () => {}), stop: vi.fn(), setMessages: vi.fn(), addToolApprovalResponse: vi.fn(async () => {}),
  };
}

function Extra() {
  return <span data-testid="extra">extra</span>;
}

interface SetupProps {
  composer?: ComposerConfig;
  components?: ChatComponents;
  interactions?: boolean;
  attachments?: boolean;
  children: ReactNode;
}

function Setup({ composer, components, interactions = true, attachments = true, children }: SetupProps) {
  const chatInteractions = useMemo(() => ({ entities: [person], commands }), []);
  const voice = useMemo(() => ({ enabled: true, adapter }), []);
  const comps = useMemo(() => ({ InputExtra: Extra, ...components }), [components]);
  return (
    <AiChatProvider
      transport={transport()}
      {...(interactions ? { chatInteractions } : {})}
      attachments={attachments}
      voice={voice}
      components={comps}
      {...(composer ? { composer } : {})}
    >
      {children}
    </AiChatProvider>
  );
}

const actions: MentionInputProps['renderActions'] = () => <button type="button" data-testid="actions">act</button>;

/** The form's children as `data-component` / `data-action` / test id / tag. */
function sequence(form: Element): string[] {
  return Array.from(form.children).map((el) =>
    el.getAttribute('data-component') ?? el.getAttribute('data-action') ?? el.getAttribute('data-testid') ?? el.tagName.toLowerCase());
}

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();
});
afterEach(async () => {
  await act(async () => { await new Promise((resolve) => requestAnimationFrame(resolve)); });
  cleanup();
  vi.restoreAllMocks();
});

describe('composer toolbar', () => {
  it('keeps today\'s order in the mention input by default and with the explicit default toolbar', () => {
    const today = render(<Setup><MentionInput renderActions={actions} /></Setup>);
    const form = today.container.querySelector('form')!;
    expect(sequence(form)).toEqual(['input', 'attachment-button', 'rich-mention-input', 'voice-input-addon', 'actions', 'extra', 'send']);
    const html = form.outerHTML;
    today.unmount();

    const explicit = render(
      <Setup composer={{ toolbar: { start: ['attach'], end: ['mic', 'actions', 'extra', 'send'] } }}>
        <MentionInput renderActions={actions} />
      </Setup>,
    );
    expect(explicit.container.querySelector('form')!.outerHTML).toBe(html);
  });

  it('keeps today\'s order in the plain input by default and with the explicit default toolbar', () => {
    const today = render(<Setup interactions={false} attachments={false}><ChatInput /></Setup>);
    const form = today.container.querySelector('form')!;
    expect(sequence(form)).toEqual(['textarea', 'voice-input-addon', 'extra', 'send']);
    const html = form.outerHTML;
    today.unmount();

    const explicit = render(
      <Setup interactions={false} attachments={false} composer={{ toolbar: { start: ['attach'], end: ['mic', 'actions', 'extra', 'send'] } }}>
        <ChatInput />
      </Setup>,
    );
    expect(explicit.container.querySelector('form')!.outerHTML).toBe(html);
  });

  it('reorders builtins and leaves out the ones not listed', () => {
    const { container } = render(
      <Setup composer={{ toolbar: { start: ['mic'], end: ['send', 'attach'] } }}><MentionInput renderActions={actions} /></Setup>,
    );
    expect(sequence(container.querySelector('form')!)).toEqual(['voice-input-addon', 'rich-mention-input', 'send', 'input', 'attachment-button']);
  });

  it('renders a trigger button labeled from the trigger definition that opens the list', async () => {
    const triggers = [{ char: '@', label: 'Mention someone' }];
    function WithTriggers() {
      const chatInteractions = useMemo(() => ({ entities: [person], commands }), []);
      const composer = useMemo<ComposerConfig>(() => ({ toolbar: { end: ['trigger:@', 'send'] } }), []);
      return (
        <AiChatProvider transport={transport()} chatInteractions={chatInteractions} triggers={triggers} composer={composer}>
          <MentionInput />
        </AiChatProvider>
      );
    }
    const { container } = render(<WithTriggers />);
    expect(sequence(container.querySelector('form')!)).toEqual(['rich-mention-input', 'composer-trigger-button', 'send']);
    const button = screen.getByRole('button', { name: 'Mention someone' });
    // The button keeps the focus in the editor.
    const mouseDown = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
    button.dispatchEvent(mouseDown);
    expect(mouseDown.defaultPrevented).toBe(true);

    fireEvent.click(button);
    const editor = screen.getByRole('textbox');
    expect(editor.textContent).toBe('@');
    expect(document.activeElement).toBe(editor);
    await screen.findByRole('listbox');
    await waitFor(() => expect(screen.getByRole('option', { name: /Müller/ })).toBeTruthy());
  });

  it('names a trigger button after its char when the trigger has no label', () => {
    render(<Setup composer={{ toolbar: { end: ['trigger:/', 'send'] } }}><MentionInput /></Setup>);
    expect(screen.getByRole('button', { name: '/' })).toBeTruthy();
  });

  it('hands the controls to a custom item\'s onSelect', () => {
    const onSelect = vi.fn((controls: ChatComposerInputControls) => controls.appendText('Hallo'));
    render(
      <Setup composer={{ toolbar: { start: ['greet'], end: ['send'] }, items: { greet: { label: 'Greet', icon: <span>G</span>, onSelect } } }}>
        <MentionInput />
      </Setup>,
    );
    const button = screen.getByRole('button', { name: 'Greet' });
    expect(button.getAttribute('data-component')).toBe('composer-toolbar-item');
    fireEvent.click(button);
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(typeof onSelect.mock.calls[0]![0].submit).toBe('function');
    expect(screen.getByRole('textbox').textContent).toBe('Hallo');
  });

  it('hands the controls to a custom item in the plain input', () => {
    render(
      <Setup interactions={false} attachments={false} composer={{ toolbar: { end: ['greet', 'send'] }, items: { greet: { label: 'Greet', onSelect: (controls) => controls.appendText('Hallo') } } }}>
        <ChatInput />
      </Setup>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Greet' }));
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('Hallo');
  });

  it('lets render win over icon and onSelect', () => {
    const onSelect = vi.fn();
    render(
      <Setup composer={{
        toolbar: { end: ['own', 'send'] },
        items: { own: { label: 'Own', icon: <span>i</span>, onSelect, render: (controls) => <button type="button" onClick={() => controls.setText('gerendert')}>Mine</button> } },
      }}>
        <MentionInput />
      </Setup>,
    );
    expect(screen.queryByRole('button', { name: 'Own' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Mine' }));
    expect(onSelect).not.toHaveBeenCalled();
    expect(screen.getByRole('textbox').textContent).toBe('gerendert');
  });

  it('hides an item with hidden: true or a hidden function', () => {
    const hidden = vi.fn((controls: ChatComposerInputControls) => !controls.canSend);
    render(
      <Setup composer={{
        toolbar: { end: ['a', 'b', 'send'] },
        items: { a: { label: 'A', hidden: true }, b: { label: 'B', hidden } },
      }}>
        <MentionInput />
      </Setup>,
    );
    expect(screen.queryByRole('button', { name: 'A' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'B' })).toBeNull();
    expect(hidden).toHaveBeenCalled();
  });

  it('passes start, end, editor and controls to components.ComposerToolbar', () => {
    const seen: ComposerToolbarProps[] = [];
    function Toolbar(props: ComposerToolbarProps) {
      seen.push(props);
      return (
        <>
          <div data-testid="row">{props.start}{props.end}</div>
          {props.editor}
        </>
      );
    }
    const { container } = render(<Setup components={{ ComposerToolbar: Toolbar }}><MentionInput renderActions={actions} /></Setup>);
    const last = seen.at(-1)!;
    expect(last.start).toHaveLength(1);
    expect(last.end).toHaveLength(4);
    expect(typeof last.controls.openCompletion).toBe('function');
    expect(sequence(container.querySelector('form')!)).toEqual(['row', 'rich-mention-input']);
    expect(sequence(screen.getByTestId('row'))).toEqual(['input', 'attachment-button', 'voice-input-addon', 'actions', 'extra', 'send']);
  });

  it('passes the textarea as editor in the plain input', () => {
    function Toolbar({ start, end, editor }: ComposerToolbarProps) {
      return <>{end}{editor}{start}</>;
    }
    const { container } = render(<Setup interactions={false} attachments={false} components={{ ComposerToolbar: Toolbar }}><ChatInput /></Setup>);
    expect(sequence(container.querySelector('form')!)).toEqual(['voice-input-addon', 'extra', 'send', 'textarea']);
  });

  it('warns once about an unknown id and skips it', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const composer: ComposerConfig = { toolbar: { start: [], end: ['nope-unknown-toolbar-id', 'send'] } };
    const { container, rerender } = render(<Setup composer={composer}><MentionInput /></Setup>);
    rerender(<Setup composer={composer}><MentionInput className="x" /></Setup>);
    expect(sequence(container.querySelector('form')!)).toEqual(['rich-mention-input', 'send']);
    const calls = warn.mock.calls.filter((call) => String(call[0]).includes('neither a builtin'));
    expect(calls).toHaveLength(1);
  });

  it('warns once about a trigger char the composer does not have', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { container } = render(<Setup composer={{ toolbar: { start: [], end: ['trigger:%', 'send'] } }}><MentionInput /></Setup>);
    expect(sequence(container.querySelector('form')!)).toEqual(['rich-mention-input', 'send']);
    expect(warn.mock.calls.filter((call) => String(call[0]).includes('names no trigger'))).toHaveLength(1);
  });

  it('lets an item replace the builtin of the same id', () => {
    render(
      <Setup composer={{ toolbar: { start: [], end: ['send'] }, items: { send: { label: 'Abschicken', onSelect: (controls) => controls.submit() } } }}>
        <MentionInput />
      </Setup>,
    );
    expect(screen.getByRole('button', { name: 'Abschicken' })).toBeTruthy();
    expect(document.querySelector('[data-action="send"]')).toBeNull();
  });

  it('skips a trigger button in the plain input, which has no completion', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { container } = render(
      <Setup interactions={false} attachments={false} composer={{ toolbar: { end: ['trigger:@', 'send'] } }}><ChatInput /></Setup>,
    );
    expect(sequence(container.querySelector('form')!)).toEqual(['textarea', 'send']);
    expect(warn).not.toHaveBeenCalled();
  });
});
