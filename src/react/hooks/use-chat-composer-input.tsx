import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CommandArgumentsForm as DefaultCommandArgumentsForm } from '../components/command-arguments-form.js';
import { useChatComposerTarget } from '../composer/chat-composer.js';
import { useChatContext } from '../provider/chat-context.js';
import type {
  ChatAttachment,
  ChatComposerInput,
  ChatComposerInputControls,
  ChatLocale,
  MentionData,
  OpenCompletionOptions,
  ResolvedChatTrigger,
  RichMentionInputHandle,
  UseChatComposerInputOptions,
} from '../types.js';
import { formatBytes, readAttachments, toFilePart, type AttachmentProblem } from '../utils/attachments.js';

function describeProblem(problem: AttachmentProblem, locale: ChatLocale): string {
  const fill = (text: string, values: Record<string, string | number>) =>
    text.replace(/\{(\w+)\}/g, (match, key: string) => (key in values ? String(values[key]) : match));
  switch (problem.code) {
    case 'type': return fill(locale.attachmentTypeNotAllowed, { name: problem.name });
    case 'too-many': return fill(locale.attachmentTooMany, { count: problem.count });
    case 'too-large': return fill(locale.attachmentTooLarge, { name: problem.name, size: formatBytes(problem.maxBytes) });
    case 'read-failed': return fill(locale.attachmentReadFailed, { name: problem.name });
    case 'command': return locale.attachmentCommandRefused;
    case 'unsupported': return locale.attachmentUnsupported;
  }
}

/** Exactly the built-in `@` and `/` (default prefix and pick, no label or types): the input's own default. */
function isDefaultTriggers(triggers: ReadonlyArray<ResolvedChatTrigger>): boolean {
  return triggers.length === 2 && triggers.every((trigger, index) => (
    trigger.char === ['@', '/'][index] && trigger.prefix === trigger.char && trigger.select === 'chip'
    && trigger.label === undefined && trigger.types === undefined
  ));
}

/**
 * The composer logic of the chat (suggestion search, direct `/` commands,
 * the argument form, entity actions, references from `mentionEntity`) for a
 * custom input: render `RichMentionInput` with `inputRef` and `inputProps`.
 * The input also receives what `useChatComposer` (e.g. `chatAbout`) sends.
 */
export function useChatComposerInput(options: UseChatComposerInputOptions = {}): ChatComposerInput {
  const {
    send,
    stop,
    isLoading,
    canCompose: composable,
    locale,
    components,
    completionSearch,
    triggers,
    onCompletionSelect,
    runEntityAction,
    composerMentions,
    consumeComposerMentions,
    pendingCommand,
    submitPendingCommand,
    cancelPendingCommand,
    attachments: attachmentOptions,
    interactions,
  } = useChatContext();
  // A hand-built context without `canCompose` locks while loading, as before.
  const canCompose = composable ?? !isLoading;
  const { onSubmit, initialValue } = options;
  const [value, setValue] = useState('');
  const [attachments, setAttachments] = useState<ChatAttachment[]>([]);
  const [attachmentProblem, setAttachmentProblem] = useState<AttachmentProblem | null>(null);
  const attachmentsRef = useRef(attachments);
  attachmentsRef.current = attachments;
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const inputRef = useRef<RichMentionInputHandle | null>(null);
  const initialApplied = useRef(false);
  const ArgumentsForm = components.CommandArgumentsForm ?? DefaultCommandArgumentsForm;

  // Pills and drafts from `useChatComposer` (e.g. a "Chat about this" menu entry).
  useChatComposerTarget(inputRef, { onChange: setValue });

  // References added from outside the composer (`mentionEntity`).
  useEffect(() => {
    const handle = inputRef.current;
    if (!handle || composerMentions.length === 0) return;
    for (const mention of composerMentions) handle.addMention(mention);
    consumeComposerMentions();
    setValue(handle.getValue());
  }, [composerMentions, consumeComposerMentions]);

  // Child effects run first, so the input's own `initialMentions` are already in the editor.
  // Only the value at mount counts: a consumer that passes its live draft here must not
  // have the first typed character re-applied as an "initial" value (and the caret reset).
  useEffect(() => {
    const handle = inputRef.current;
    if (initialApplied.current || !handle) return;
    initialApplied.current = true;
    if (!initialValue) return;
    const prefix = handle.getValue();
    handle.setValue(prefix ? `${prefix} ${initialValue}` : initialValue, handle.getMentions());
    setValue(handle.getValue());
  }, [initialValue]);

  const addFiles = useCallback(async (files: FileList | ReadonlyArray<File>) => {
    if (!attachmentOptions) return;
    const list = Array.from(files);
    if (list.length === 0) return;
    const read = await readAttachments(list, attachmentsRef.current.length, attachmentOptions);
    if (read.attachments.length > 0) {
      attachmentsRef.current = [...attachmentsRef.current, ...read.attachments];
      setAttachments(attachmentsRef.current);
    }
    setAttachmentProblem(read.error);
  }, [attachmentOptions]);

  const removeAttachment = useCallback((id: string) => {
    attachmentsRef.current = attachmentsRef.current.filter((attachment) => attachment.id !== id);
    setAttachments(attachmentsRef.current);
    setAttachmentProblem(null);
  }, []);

  const removeLastAttachment = useCallback(() => {
    const last = attachmentsRef.current.at(-1);
    if (last) removeAttachment(last.id);
  }, [removeAttachment]);

  const openFilePicker = useCallback(() => { fileInputRef.current?.click(); }, []);

  const submitText = useCallback((text: string, mentions: MentionData[]) => {
    const trimmed = text.trim();
    const pending = attachmentsRef.current;
    if ((!trimmed && pending.length === 0) || !canCompose) return false;
    const files = pending.map(toFilePart);
    if (files.length > 0) {
      const plan = interactions?.planMessage(trimmed, mentions);
      if (plan?.status === 'send' || plan?.status === 'needs-args') {
        setAttachmentProblem({ code: 'command' });
        return false;
      }
    }
    if (onSubmit) {
      onSubmit(trimmed, mentions, ...(files.length > 0 ? [files] : []));
    } else if (!send(trimmed, files.length > 0 ? { mentions, files } : { mentions })) {
      return false;
    }
    setValue('');
    if (pending.length > 0) {
      attachmentsRef.current = [];
      setAttachments([]);
    }
    setAttachmentProblem(null);
    return true;
  }, [canCompose, onSubmit, send, interactions]);

  const submit = useCallback(() => {
    const handle = inputRef.current;
    if (!handle || !submitText(handle.getValue(), handle.getMentions())) return false;
    handle.clear();
    return true;
  }, [submitText]);

  const setText = useCallback((text: string) => {
    const handle = inputRef.current;
    if (!handle) return;
    handle.setValue(text, handle.getMentions());
    setValue(handle.getValue());
  }, []);

  const appendText = useCallback((text: string) => {
    const handle = inputRef.current;
    if (!handle) return;
    const current = handle.getValue();
    handle.setValue(current ? `${current} ${text}` : text, handle.getMentions());
    setValue(handle.getValue());
  }, []);

  const focus = useCallback(() => { inputRef.current?.focus(); }, []);

  const openCompletion = useCallback((completion: OpenCompletionOptions) => {
    inputRef.current?.openCompletion?.(completion);
  }, []);

  // The controls returned below, read when an entry is picked (after this render).
  const controlsRef = useRef<ChatComposerInputControls | null>(null);

  const inputProps = useMemo<ChatComposerInput['inputProps']>(() => ({
    onChange: setValue,
    onSubmit: (text, mentions) => submitText(text, mentions),
    onSearch: completionSearch,
    // Only a non-default list: a `triggers` prop the app sets on the input must not be overridden by the default.
    ...(triggers && !isDefaultTriggers(triggers) ? { triggers } : {}),
    ...(onCompletionSelect
      ? {
          onCompletionSelect: (item, context) => (controlsRef.current
            ? onCompletionSelect(item, { ...context, controls: controlsRef.current })
            : undefined),
        }
      : {}),
    placeholder: locale.placeholder,
    disabled: !canCompose,
    onEntityAction: (result, actionId) => runEntityAction(
      { type: result.type, id: result.id, label: result.label },
      actionId,
    ),
    listLabel: locale.completionListLabel,
    resultsLabel: locale.completionResultsLabel,
    emptyLabel: locale.completionEmptyLabel,
    removeMentionLabel: locale.removeMentionLabel,
    ...(attachmentOptions
      ? {
          onFiles: (files: File[]) => { void addFiles(files); },
          onBackspaceEmpty: removeLastAttachment,
          allowEmptySubmit: attachments.length > 0,
        }
      : {}),
  }), [completionSearch, triggers, onCompletionSelect, canCompose, locale, runEntityAction, submitText, attachmentOptions, addFiles, removeLastAttachment, attachments.length]);

  const attachmentInputProps = useMemo<ChatComposerInput['attachmentInputProps']>(() => ({
    ref: fileInputRef,
    type: 'file',
    multiple: true,
    accept: (attachmentOptions?.mediaTypes ?? []).join(','),
    hidden: true,
    tabIndex: -1,
    'aria-hidden': true,
    onChange: (event) => {
      const input = event.currentTarget;
      const files = input.files ? Array.from(input.files) : [];
      // Lets the same file be picked again after it was removed.
      input.value = '';
      void addFiles(files);
    },
  }), [attachmentOptions, addFiles]);

  const argumentsForm = pendingCommand ? (
    <ArgumentsForm
      key={`${pendingCommand.commandId}:${JSON.stringify(pendingCommand.values)}:${pendingCommand.error ?? ''}`}
      pending={pendingCommand}
      onSubmit={(values, valueLabels) => {
        // Back to the editor only once the form is gone; while it keeps asking, focus stays in it.
        if (submitPendingCommand(values, valueLabels)) inputRef.current?.focus();
      }}
      onCancel={() => {
        cancelPendingCommand();
        inputRef.current?.focus();
      }}
    />
  ) : null;

  const composer: ChatComposerInput = {
    value,
    isLoading,
    canSend: (value.trim().length > 0 || attachments.length > 0) && canCompose,
    attachments,
    attachmentError: attachmentProblem ? describeProblem(attachmentProblem, locale) : null,
    attachmentsEnabled: attachmentOptions !== null,
    addFiles,
    removeAttachment,
    openFilePicker,
    attachmentInputProps,
    submit,
    stop,
    setText,
    appendText,
    focus,
    openCompletion,
    inputRef,
    inputProps,
    pendingCommand,
    submitPendingCommand,
    cancelPendingCommand,
    argumentsForm,
  };
  controlsRef.current = composer;
  return composer;
}
