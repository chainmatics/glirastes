import { useEffect, useRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  parseChatInteractions,
  type ChatInteractionsData,
  type ChatLocaleCode,
} from '../contracts/chat-interactions.js';
import { AiChatPanel } from '../react/components/ai-chat-panel.js';
import {
  defineChatCommand,
  defineChatEntity,
  type ChatCommandDefinition,
  type ChatEntityDefinition,
} from '../react/interactions/definitions.js';
import type { ChatInteractionsConfig } from '../react/interactions/registry.js';
import { AiChatProvider } from '../react/provider/ai-chat-provider.js';
import { useChatContext } from '../react/provider/chat-context.js';
import { VercelAiChat } from '../react/transports/vercel/vercel-ai-chat.js';
import type { AiChatProviderConfig, ChatThemePreset, ChatTransport } from '../react/types.js';
import { CHAT_STYLES } from './chat-styles.generated.js';
import { embedThemeCss, isChatThemePreset } from './theme.js';

export const GLIRASTES_CHAT_TAG = 'glirastes-chat';

export interface GlirastesChatEventMap {
  'glirastes-chat:ready': Record<string, never>;
  'glirastes-chat:status': { state: 'idle' | 'busy' | 'error' };
  'glirastes-chat:tool-result': { toolName: string; result: unknown };
  'glirastes-chat:error': { message: string };
}

export type GlirastesChatEventName = keyof GlirastesChatEventMap;

/** JS-only settings that do not fit attributes. Theme comes from the attribute. */
export interface GlirastesChatElementConfig
  extends Omit<AiChatProviderConfig, 'theme' | 'themeScope'> {
  headers?: Record<string, string> | (() => Record<string, string>);
  bodyExtras?: Record<string, unknown> | (() => Record<string, unknown>);
}

type Emit = <TName extends GlirastesChatEventName>(
  name: TName,
  detail: GlirastesChatEventMap[TName],
) => void;

interface EmbedApi {
  send(text: string): boolean;
  mentionEntity(type: string, id: string): Promise<boolean>;
}

function EmbedBridge({
  emit,
  onSendReady,
}: {
  emit: Emit;
  onSendReady: (api: EmbedApi | null) => void;
}) {
  const { send, mentionEntity, isLoading, error } = useChatContext();
  const previous = useRef<string | null>(null);
  const state = error ? 'error' : isLoading ? 'busy' : 'idle';

  useEffect(() => {
    onSendReady({ send: (text) => send(text), mentionEntity });
    return () => onSendReady(null);
  }, [send, mentionEntity, onSendReady]);

  useEffect(() => {
    emit('glirastes-chat:ready', {});
  }, [emit]);

  useEffect(() => {
    if (previous.current === state) return;
    previous.current = state;
    emit('glirastes-chat:status', { state });
  }, [state, emit]);

  return null;
}

function EmbeddedChat({
  endpoint,
  transport,
  config,
  theme,
  welcomeMessage,
  emit,
  onSendReady,
}: {
  endpoint: string;
  transport?: ChatTransport;
  config: GlirastesChatElementConfig;
  theme?: ChatThemePreset;
  welcomeMessage?: string;
  emit: Emit;
  onSendReady: (api: EmbedApi | null) => void;
}) {
  const { headers, bodyExtras, onToolResult, ...providerConfig } = config;
  const shared = {
    ...providerConfig,
    // Colours come from the shadow-root CSS (`themeScope: 'inherit'` skips the
    // inline variables); the preset still drives effects such as glass blur.
    theme,
    themeScope: 'inherit' as const,
    onToolResult: (toolName: string, result: unknown) => {
      onToolResult?.(toolName, result);
      emit('glirastes-chat:tool-result', { toolName, result });
    },
  };
  const body = (
    <>
      <EmbedBridge emit={emit} onSendReady={onSendReady} />
      <AiChatPanel welcomeMessage={welcomeMessage} />
    </>
  );
  if (transport) {
    return <AiChatProvider transport={transport} {...shared}>{body}</AiChatProvider>;
  }
  return (
    <VercelAiChat endpoint={endpoint} headers={headers} bodyExtras={bodyExtras} {...shared}>
      {body}
    </VercelAiChat>
  );
}

// Importing on a server (SSR) must not touch DOM globals.
const BaseElement = (typeof HTMLElement === 'undefined'
  ? class {}
  : HTMLElement) as typeof HTMLElement;

/**
 * `<glirastes-chat endpoint="/api/chat">`: the React chat UI inside a Shadow
 * DOM for Vue, Angular, Svelte or plain HTML hosts.
 *
 * Attributes: `endpoint` (required unless `transport` is set), `theme`
 * (preset name), `placeholder`, `welcome-message`, `voice`, `voice-language`,
 * `interactions` (load `@` entities and `/` commands with a GET from the
 * endpoint or the given URL; labels follow the nearest `lang`).
 * Properties: `config`, `transport`, `interactions`. Methods: `send(text)`,
 * `defineEntity(definition)`, `defineCommand(definition)`,
 * `mentionEntity(type, id)`.
 * Events (bubbling, composed): `glirastes-chat:ready`, `:status`,
 * `:tool-result`, `:error`. Styling: `--glirastes-chat-*` CSS variables.
 * Removing the element unmounts React and releases the microphone.
 */
export class GlirastesChatElement extends BaseElement {
  static get observedAttributes(): string[] {
    return ['endpoint', 'theme', 'placeholder', 'welcome-message', 'voice', 'voice-language', 'interactions', 'lang'];
  }

  #root: Root | null = null;
  #style: HTMLStyleElement | null = null;
  #config: GlirastesChatElementConfig = {};
  #transport: ChatTransport | undefined;
  #api: EmbedApi | null = null;
  #pendingUnmount = false;
  #entities: ChatEntityDefinition[] = [];
  #commands: ChatCommandDefinition[] = [];
  #interactions: ChatInteractionsData | undefined;
  #interactionsFromProperty = false;
  #interactionsLoad: AbortController | null = null;

  readonly #emit: Emit = (name, detail) => {
    this.dispatchEvent(new CustomEvent(name, { detail, bubbles: true, composed: true }));
  };

  readonly #onSendReady = (api: EmbedApi | null) => {
    this.#api = api;
  };

  get config(): GlirastesChatElementConfig {
    return this.#config;
  }

  set config(value: GlirastesChatElementConfig | null | undefined) {
    this.#config = value ?? {};
    this.#render();
  }

  get transport(): ChatTransport | undefined {
    return this.#transport;
  }

  set transport(value: ChatTransport | undefined) {
    this.#transport = value;
    this.#render();
  }

  /** Derived `@` entities and `/` commands, e.g. the generated module's `chatInteractions`. */
  get interactions(): ChatInteractionsData | undefined {
    return this.#interactions;
  }

  set interactions(value: ChatInteractionsData | null | undefined) {
    this.#interactionsLoad?.abort();
    this.#interactions = value ? parseChatInteractions(value) : undefined;
    this.#interactionsFromProperty = Boolean(value);
    this.#render();
  }

  /** Adds or replaces (same type) an `@` entity; same definition as `defineChatEntity`. */
  defineEntity(definition: ChatEntityDefinition): void {
    const entity = defineChatEntity(definition);
    this.#entities = [...this.#entities.filter((entry) => entry.type !== entity.type), entity];
    this.#render();
  }

  /** Adds or replaces (same id) a `/` command; same definition as `defineChatCommand`. */
  defineCommand(definition: ChatCommandDefinition): void {
    const command = defineChatCommand(definition);
    this.#commands = [...this.#commands.filter((entry) => entry.id !== command.id), command];
    this.#render();
  }

  /** Adds a reference to an entity, resolved by id, to the composer. False before mount or when refused. */
  async mentionEntity(type: string, id: string): Promise<boolean> {
    return this.#api ? this.#api.mentionEntity(type, id) : false;
  }

  /** Sends a user message through the embedded chat. False before mount. */
  send(text: string): boolean {
    if (!this.#api || !text.trim()) return false;
    return this.#api.send(text);
  }

  connectedCallback(): void {
    this.#pendingUnmount = false;
    this.#loadInteractions();
    if (!this.#root) {
      const shadow = this.shadowRoot ?? this.attachShadow({ mode: 'open' });
      const style = document.createElement('style');
      const mount = document.createElement('div');
      mount.setAttribute('data-part', 'mount');
      shadow.replaceChildren(style, mount);
      this.#style = style;
      this.#root = createRoot(mount);
    }
    this.#render();
  }

  disconnectedCallback(): void {
    // A move (disconnect + connect in one task) keeps the mounted chat.
    this.#pendingUnmount = true;
    queueMicrotask(() => {
      if (!this.#pendingUnmount || this.isConnected) return;
      this.#pendingUnmount = false;
      const root = this.#root;
      this.#root = null;
      this.#style = null;
      this.#api = null;
      this.#interactionsLoad?.abort();
      root?.unmount();
      this.shadowRoot?.replaceChildren();
    });
  }

  attributeChangedCallback(name?: string): void {
    if (name === 'interactions' || name === 'endpoint') this.#loadInteractions();
    this.#render();
  }

  #locale(): ChatLocaleCode {
    const lang = this.closest('[lang]')?.getAttribute('lang') ?? '';
    return lang.toLowerCase().startsWith('de') ? 'de' : 'en';
  }

  /** `interactions` attribute: GET the data from its URL, or from the endpoint when empty. */
  #loadInteractions(): void {
    if (this.#interactionsFromProperty || !this.isConnected) return;
    this.#interactionsLoad?.abort();
    this.#interactionsLoad = null;
    const attribute = this.getAttribute('interactions');
    const url = attribute === null ? '' : attribute || this.getAttribute('endpoint') || '';
    if (!url) return;
    const controller = new AbortController();
    this.#interactionsLoad = controller;
    void (async () => {
      try {
        const response = await fetch(url, {
          method: 'GET',
          credentials: 'same-origin',
          headers: { accept: 'application/json' },
          signal: controller.signal,
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = parseChatInteractions(await response.json());
        if (controller.signal.aborted) return;
        this.#interactions = data;
        this.#render();
      } catch {
        if (!controller.signal.aborted) this.#emit('glirastes-chat:error', { message: 'Chat interactions unavailable' });
      }
    })();
  }

  #chatInteractions(): ChatInteractionsConfig | undefined {
    const base = this.#config.chatInteractions;
    const data = this.#interactions ?? base?.data;
    if (!base && !data && this.#entities.length === 0 && this.#commands.length === 0) return undefined;
    return {
      ...base,
      locale: base?.locale ?? this.#locale(),
      ...(data ? { data } : {}),
      entities: [...(base?.entities ?? []), ...this.#entities],
      commands: [...(base?.commands ?? []), ...this.#commands],
    };
  }

  #render(): void {
    if (!this.#root || !this.#style) return;
    const themeAttribute = this.getAttribute('theme');
    const theme = isChatThemePreset(themeAttribute) ? themeAttribute : undefined;
    this.#style.textContent = `${CHAT_STYLES}\n${embedThemeCss(theme)}`;
    const endpoint = this.getAttribute('endpoint') ?? '';
    if (!endpoint && !this.#transport) {
      this.#root.render(null);
      this.#emit('glirastes-chat:error', { message: 'Missing endpoint attribute' });
      return;
    }
    const placeholder = this.getAttribute('placeholder');
    const voiceLanguage = this.getAttribute('voice-language');
    const chatInteractions = this.#chatInteractions();
    const config: GlirastesChatElementConfig = {
      ...this.#config,
      ...(chatInteractions ? { chatInteractions } : {}),
      ...(placeholder
        ? { locale: { ...(this.#config.locale ?? {}), placeholder } }
        : {}),
      ...(this.hasAttribute('voice')
        ? {
          voice: {
            ...(this.#config.voice ?? {}),
            enabled: true,
            ...(voiceLanguage ? { language: voiceLanguage } : {}),
          },
        }
        : {}),
    };
    this.#root.render(
      <EmbeddedChat
        endpoint={endpoint}
        transport={this.#transport}
        config={config}
        theme={theme}
        welcomeMessage={this.getAttribute('welcome-message') ?? undefined}
        emit={this.#emit}
        onSendReady={this.#onSendReady}
      />,
    );
  }
}

/**
 * Registers the element once per tag name and returns its class. Each tag
 * gets its own subclass, so a page may register several names.
 */
export function defineGlirastesChatElement(
  tagName: string = GLIRASTES_CHAT_TAG,
): typeof GlirastesChatElement {
  if (typeof customElements === 'undefined') {
    throw new Error('glirastes/embed needs a browser with Custom Elements support');
  }
  const existing = customElements.get(tagName);
  if (existing) {
    if (!(existing.prototype instanceof GlirastesChatElement)) {
      throw new Error(`<${tagName}> is already defined by another element`);
    }
    return existing as typeof GlirastesChatElement;
  }
  const ElementClass = class extends GlirastesChatElement {};
  customElements.define(tagName, ElementClass);
  return ElementClass;
}
