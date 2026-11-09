import type {
  AiPipeline,
  AiPipelineConfig,
  AiRouterConfig,
  IntentClassification,
  ModelConfig,
  PipelineResult,
  ToolContext,
} from '../types.js';
import {
  createAiRouter,
  createAdaptiveFastPath,
  createIntentClassifier,
  createModelSelector,
  createModelSelectorFromMap,
  type LocalClassifierConfig,
} from './core/index.js';
import { createLocalGuardrails } from './core/local-guardrails.js';

export interface LocalAiPipelineConfig extends AiPipelineConfig {
  /** Focused by default; legacy keeps the historical full-catalogue fallback. */
  routingMode?: AiRouterConfig['routingMode'];
  /** AI SDK generateText or a compatible local model callback. */
  generateText?: LocalClassifierConfig['generateText'];
}

const CONTINUATION_TTL_MS = 10 * 60 * 1000;
const CONTINUATION_MAX_ENTRIES = 200;

/** The request and the user messages before it; assistant text added by a continuation does not count. */
function continuationKeyOf(
  input: string,
  conversationHistory: ReadonlyArray<{ role: string; content: string }> | undefined,
): string {
  return JSON.stringify([
    input,
    (conversationHistory ?? []).filter((message) => message.role === 'user').map((message) => message.content),
  ]);
}

/**
 * Target-app pipeline for content-bearing guardrails, intent classification,
 * routing, and model selection. No request or user content leaves the local
 * runtime unless the configured local model provider itself receives it.
 */
export function createLocalAiPipeline(
  config: LocalAiPipelineConfig,
): AiPipeline {
  const guardrails = createLocalGuardrails(config.guardrails);
  const fastPath = createAdaptiveFastPath(
    config.fastPath,
    config.fastPathStorage,
  );
  let fastPathReady: Promise<void> | undefined;
  const ensureFastPathReady = () => {
    fastPathReady ??= fastPath.loadFromStorage();
    return fastPathReady;
  };
  const router = createAiRouter({
    modules: config.modules,
    relatedModules: config.relatedModules,
    confidenceThresholds: config.confidenceThresholds,
    routingMode: config.routingMode ?? 'focused',
  });
  const modelSelector = config.models && config.modelInstanceFactory
    ? createModelSelectorFromMap(
        config.models,
        config.modelInstanceFactory,
        config.modules,
      )
    : config.modelSelector
      ? createModelSelector(config.modelSelector, config.modules)
      : undefined;
  const classifierModel = config.classifier?.model
    ?? config.modelSelector?.fast.instance
    ?? (
      config.models && config.modelInstanceFactory
        ? config.modelInstanceFactory(
            config.models.fast
              ?? config.models.standard
              ?? 'default',
          )
        : undefined
    );
  const classifier = createIntentClassifier({
    ...config.classifier,
    modules: config.modules,
    model: classifierModel,
    generateText: config.generateText,
  });
  const followupsEnabled = config.followups?.enabled ?? false;
  const defaultModel: ModelConfig = { modelId: 'default' };
  // A request reaches the pipeline again when it continues after an approval:
  // same words, same earlier user messages. It keeps its classification, so
  // the continuation saves the classifier call and stays in its module.
  const recentIntents = new Map<string, { intent: IntentClassification; at: number }>();

  const selectModel = (
    intent: IntentClassification,
    context: ToolContext,
  ) => modelSelector?.select(intent, context) ?? defaultModel;

  return {
    async process(input, context, conversationHistory): Promise<PipelineResult> {
      const validation = guardrails.validate(input);
      config.onAudit?.({
        type: validation.blocked ? 'guardrail.blocked' : 'guardrail.passed',
        timestamp: new Date().toISOString(),
        sessionId: '',
        source: 'server-core',
        details: {
          inputLength: input.length,
          blocked: validation.blocked,
          reason: validation.reason,
        },
      });

      if (validation.blocked) {
        const intent = { intent: 'ambiguous', confidence: 0 };
        return {
          model: selectModel(intent, context),
          tools: [],
          toolSelection: 'explicit',
          sanitizedInput: validation.sanitized,
          intent,
          module: null,
          followupsEnabled,
          blocked: true,
        };
      }

      const startedAt = Date.now();
      await ensureFastPathReady();
      const hasConversationHistory = Boolean(conversationHistory?.length);
      let intent = hasConversationHistory
        ? null
        : fastPath.match(validation.sanitized);
      const fastPathHit = intent !== null;
      const continuationKey = continuationKeyOf(validation.sanitized, conversationHistory);
      const continued = intent ? undefined : recentIntents.get(continuationKey);
      const continuationHit = !!continued && Date.now() - continued.at < CONTINUATION_TTL_MS;
      if (continuationHit) intent = continued.intent;
      if (!intent) {
        intent = await classifier.classify(
          validation.sanitized,
          context,
          conversationHistory,
        );
        if (!hasConversationHistory) {
          fastPath.learn(validation.sanitized, intent);
        }
        if (intent.intent !== 'ambiguous') {
          recentIntents.delete(continuationKey);
          recentIntents.set(continuationKey, { intent, at: Date.now() });
          if (recentIntents.size > CONTINUATION_MAX_ENTRIES) {
            recentIntents.delete(recentIntents.keys().next().value as string);
          }
        }
      }
      void fastPath.saveToStorage();
      config.onAudit?.({
        type: 'intent.classified',
        timestamp: new Date().toISOString(),
        sessionId: '',
        source: 'server-core',
        details: {
          intent: intent.intent,
          confidence: intent.confidence,
          latencyMs: Date.now() - startedAt,
          fastPathHit,
        },
      });

      const selected = router.route(
        intent,
        config.modules.flatMap((module) => [
          ...module.tools,
          ...(module.sharedTools ?? []),
        ]),
      );
      config.onAudit?.({
        type: 'routing.resolved',
        timestamp: new Date().toISOString(),
        sessionId: '',
        source: 'server-core',
        details: {
          module: selected.module?.id ?? null,
          strategy: selected.strategy,
          toolCount: selected.tools.length,
        },
      });
      const tools = [...selected.tools];
      if (followupsEnabled) tools.push('suggest_followups');

      return {
        model: selectModel(intent, context),
        tools: [...new Set(tools)],
        ...(config.routingMode === 'legacy' ? {} : { toolSelection: 'explicit' as const }),
        sanitizedInput: validation.sanitized,
        intent,
        module: selected.module,
        followupsEnabled,
        blocked: false,
      };
    },
  };
}
