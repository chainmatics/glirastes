# SDK Follow-up Suggestions Design

**Status:** Approved on 2026-08-13.

## Problem

The SDK already owns contextual follow-up suggestions through the synthetic
`suggest_followups` tool and renders them in the rotating `SuggestionBar` above
the input. The current model can nevertheless emit a trailing Markdown section
such as `Vorschläge:` in its assistant text. That duplicates SDK UI behavior,
makes the chat unnecessarily long, and leaves only the static suggestion in
the pill bar.

## Decision

The structured `suggest_followups` tool remains canonical. The SDK adds a
strict presentation fallback for assistant text that ends in a German or
English suggestion section. It recognizes only a trailing heading followed by
one to five bullet or numbered items, removes that section from the rendered
assistant bubble, and feeds the items into the same SDK-owned rotating
`SuggestionBar`.

Get It Done supplies only the existing SDK configuration and translations. It
does not parse messages or render separate suggestion components.

## Data flow

1. Prefer completed `suggest_followups` tool output from the newest assistant
   message.
2. If no structured output is available for that message, parse a strictly
   delimited trailing suggestion section from assistant text.
3. Bound, trim, and deduplicate the extracted items using the configured
   suggestion count.
4. Render only the remaining assistant answer through `MessageBubble`.
5. Show extracted items through the existing rotating `SuggestionBar`.
6. Fall back to app-provided static chips only when neither structured nor
   text fallback suggestions exist.

## Safety and compatibility

- Ordinary prose containing the word "Vorschläge" is unchanged.
- A heading without list items is unchanged.
- Embedded or non-trailing sections are unchanged.
- Tool output wins over text fallback output.
- No model, network, authentication, scoping, signing, or tool-execution path
  changes.
- The fallback performs no extra model call and adds only local string parsing.

## Acceptance

- Assistant bubbles never show a recognized trailing suggestion list.
- The same items appear in the SDK pill and rotate with the existing timer.
- Structured tool suggestions continue to work unchanged and take precedence.
- Static context chips remain the last fallback.
- Get It Done contains no suggestion parser or duplicate component.
