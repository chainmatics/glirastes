/**
 * The public types of `onTurnEnd`, as an app imports them from `glirastes/react`.
 * `bun run typecheck:tests` checks this file.
 */
import { describe, expectTypeOf, it } from 'vitest';
import type {
  AiChatProviderConfig,
  OnTurnEnd,
  TurnEndInfo,
  TurnOutcome,
} from 'glirastes/react';
import type { GlirastesChatElementConfig } from 'glirastes/embed';

describe('onTurnEnd types', () => {
  it('is optional on the provider config and takes the outcome and the info', () => {
    expectTypeOf<AiChatProviderConfig['onTurnEnd']>().toEqualTypeOf<OnTurnEnd | undefined>();
    expectTypeOf<OnTurnEnd>().parameters.toEqualTypeOf<[TurnOutcome, TurnEndInfo]>();
    expectTypeOf<OnTurnEnd>().returns.toEqualTypeOf<void>();
    expectTypeOf<TurnEndInfo>().toEqualTypeOf<{ sessionId: string }>();
    const config: AiChatProviderConfig = {};
    expectTypeOf(config).toMatchTypeOf<AiChatProviderConfig>();
  });

  it('passes through the <glirastes-chat> config', () => {
    expectTypeOf<GlirastesChatElementConfig['onTurnEnd']>().toEqualTypeOf<OnTurnEnd | undefined>();
  });
});
