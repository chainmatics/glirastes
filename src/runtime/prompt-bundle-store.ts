import {
  PromptBundleSchema,
  SignedPromptBindingSchema,
  type PromptBundle,
  type PromptPin,
  type SignedPromptBinding,
} from '../contracts/index.js';
import {
  RuntimeRevisionVerifier,
  type RuntimePublicKeyProvider,
} from '../sync/signature-verifier.js';

const DEFAULT_MAX_BUNDLE_BYTES = 1_000_000;

export interface PromptArtifactRegistry {
  fetch(artifactRef: string): Promise<unknown>;
}

export interface PromptBundleSections {
  readonly planner: string;
  readonly appBehavior: string;
  readonly responseStyle: string;
  readonly capabilityFragments: ReadonlyArray<{
    readonly id: string;
    readonly content: string;
  }>;
}

export interface StagedPromptBundle {
  readonly revisionId: string;
  readonly revision: number;
  readonly bundleDigest: string;
  readonly sections: PromptBundleSections;
}

export interface ActivePromptBundle extends StagedPromptBundle {}

export interface PinnedPromptBundle extends StagedPromptBundle {
  readonly turnId: string;
}

export interface PromptBundleStoreOptions {
  appId: string;
  registry: PromptArtifactRegistry;
  keys: RuntimePublicKeyProvider;
  maxBundleBytes?: number;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) {
      deepFreeze(child);
    }
  }
  return value;
}

/**
 * Local, verified prompt-bundle activation.
 *
 * Runtime and prompt bundles are separate artifacts. Staging performs every
 * network and cryptographic step outside interactive turns; activation is a
 * single atomic reference swap. A running turn keeps the revision it started
 * with, a new turn atomically sees the activated revision, and there is no
 * unsigned, stale, or partially verified fallback.
 */
export class PromptBundleStore {
  private readonly verifier: RuntimeRevisionVerifier;
  private readonly maxBundleBytes: number;
  private active?: ActivePromptBundle;
  private previous?: ActivePromptBundle;
  private readonly turnPins = new Map<string, PinnedPromptBundle>();

  constructor(private readonly options: PromptBundleStoreOptions) {
    this.verifier = new RuntimeRevisionVerifier(options.keys);
    this.maxBundleBytes = options.maxBundleBytes ?? DEFAULT_MAX_BUNDLE_BYTES;
  }

  async stage(binding: SignedPromptBinding): Promise<StagedPromptBundle> {
    const pin = SignedPromptBindingSchema.parse(binding);
    if (pin.appId !== this.options.appId) {
      throw new Error('Prompt binding targets a different app');
    }
    await this.verifier.verifyPromptBinding(pin);

    const raw = await this.options.registry.fetch(pin.artifactRef);
    const size = Buffer.byteLength(JSON.stringify(raw ?? null), 'utf8');
    if (size > this.maxBundleBytes) {
      throw new Error('Prompt bundle artifact is too large to verify');
    }

    const bundle: PromptBundle = PromptBundleSchema.parse(raw);
    if (bundle.appId !== this.options.appId) {
      throw new Error('Prompt bundle targets a different app');
    }
    await this.verifier.verifyPromptBundle(bundle);

    if (bundle.revisionId !== pin.revisionId) {
      throw new Error('Prompt binding revision identity does not match the bundle');
    }
    if (bundle.revision !== pin.revision) {
      throw new Error('Prompt binding revision does not match the bundle revision');
    }
    if (bundle.bundleDigest !== pin.bundleDigest) {
      throw new Error('Prompt binding digest does not match the bundle digest');
    }
    this.assertNotStale(bundle.revision);

    return deepFreeze({
      revisionId: bundle.revisionId,
      revision: bundle.revision,
      bundleDigest: bundle.bundleDigest,
      sections: bundle.sections,
    }) as StagedPromptBundle;
  }

  async activate(staged: StagedPromptBundle): Promise<void> {
    this.assertNotStale(staged.revision);
    const next = deepFreeze({
      revisionId: staged.revisionId,
      revision: staged.revision,
      bundleDigest: staged.bundleDigest,
      sections: staged.sections,
    }) as ActivePromptBundle;
    // Single atomic swap: a concurrent turn either sees the old or the new
    // reference, never a partially applied bundle.
    this.previous = this.active;
    this.active = next;
  }

  current(): ActivePromptBundle {
    if (!this.active) {
      throw new Error('No verified prompt bundle is active');
    }
    return this.active;
  }

  pinForTurn(turnId: string): PinnedPromptBundle {
    const existing = this.turnPins.get(turnId);
    if (existing) return existing;
    const active = this.current();
    const pinned = deepFreeze({ ...active, turnId }) as PinnedPromptBundle;
    this.turnPins.set(turnId, pinned);
    return pinned;
  }

  releaseTurn(turnId: string): void {
    this.turnPins.delete(turnId);
  }

  /** Restores the previously verified pin without refetching or rebuilding. */
  rollback(): void {
    if (!this.previous) {
      throw new Error('No previously verified prompt bundle to roll back to');
    }
    this.active = this.previous;
    this.previous = undefined;
  }

  promptPin(): PromptPin {
    const active = this.current();
    return {
      revisionId: active.revisionId,
      revision: active.revision,
      bundleDigest: active.bundleDigest,
    };
  }

  private assertNotStale(revision: number): void {
    if (this.active && revision <= this.active.revision) {
      throw new Error('Prompt bundle revision is stale');
    }
  }
}
