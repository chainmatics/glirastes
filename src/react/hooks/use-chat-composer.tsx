import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CommandArgumentsForm as DefaultCommandArgumentsForm } from '../components/command-arguments-form.js';
import { useChatContext } from '../provider/chat-context.js';
import type {
  ChatComposer,
  MentionData,
  RichMentionInputHandle,
  UseChatComposerOptions,
} from '../types.js';

/**
 * The composer logic of the chat (suggestion search, direct `/` commands,
 * the argument form, entity actions, references from `mentionEntity`) for a
 * custom input: render `RichMentionInput` with `inputRef` and `inputProps`.
 */
export function useChatComposer(options: UseChatComposerOptions = {}): ChatComposer {
  const {
    send,
    stop,
    isLoading,
    locale,
    components,
    completionSearch,
    runEntityAction,
    composerMentions,
    consumeComposerMentions,
    pendingCommand,
    submitPendingCommand,
    cancelPendingCommand,
  } = useChatContext();
  const { onSubmit, initialValue } = options;
  const [value, setValue] = useState('');
  const inputRef = useRef<RichMentionInputHandle | null>(null);
  const initialApplied = useRef(false);
  const ArgumentsForm = components.CommandArgumentsForm ?? DefaultCommandArgumentsForm;

  // References added from outside the composer (`mentionEntity`).
  useEffect(() => {
    const handle = inputRef.current;
    if (!handle || composerMentions.length === 0) return;
    for (const mention of composerMentions) handle.addMention(mention);
    consumeComposerMentions();
    setValue(handle.getValue());
  }, [composerMentions, consumeComposerMentions]);

  // Child effects run first, so the input's own `initialMentions` are already in the editor.
  useEffect(() => {
    const handle = inputRef.current;
    if (initialApplied.current || !initialValue || !handle) return;
    initialApplied.current = true;
    const prefix = handle.getValue();
    handle.setValue(prefix ? `${prefix} ${initialValue}` : initialValue, handle.getMentions());
    setValue(handle.getValue());
  }, [initialValue]);

  const submitText = useCallback((text: string, mentions: MentionData[]) => {
    const trimmed = text.trim();
    if (!trimmed || isLoading) return false;
    if (onSubmit) {
      onSubmit(trimmed, mentions);
    } else if (!send(trimmed, { mentions })) {
      return false;
    }
    setValue('');
    return true;
  }, [isLoading, onSubmit, send]);

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

  const inputProps = useMemo<ChatComposer['inputProps']>(() => ({
    onChange: setValue,
    onSubmit: (text, mentions) => { submitText(text, mentions); },
    onSearch: completionSearch,
    placeholder: locale.placeholder,
    disabled: isLoading,
    onEntityAction: (result, actionId) => runEntityAction(
      { type: result.type, id: result.id, label: result.label },
      actionId,
    ),
    listLabel: locale.completionListLabel,
    resultsLabel: locale.completionResultsLabel,
  }), [completionSearch, isLoading, locale, runEntityAction, submitText]);

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

  return {
    value,
    isLoading,
    canSend: value.trim().length > 0 && !isLoading,
    submit,
    stop,
    setText,
    appendText,
    focus,
    inputRef,
    inputProps,
    pendingCommand,
    submitPendingCommand,
    cancelPendingCommand,
    argumentsForm,
  };
}
