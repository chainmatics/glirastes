/**
 * AI pipeline: multi-stage workflow that composes guardrails, intent
 * classification, tool routing, and model selection into a single
 * `process()` call. Requires a Lancer client (Glirastes platform).
 */

import {
  createAiRouter,
  createModelSelector,
  createModelSelectorFromMap,
  createIntentClassifier,
  type LocalClassifierConfig,
} from './core/index.js';
import type {
  AiPipelineConfig,
  AiPipeline,
  ConversationMessage,
  PipelineResult,
  ToolContext,
  IntentClassification,
} from '../types.js';
import { ServiceBlockedError } from './lancer/index.js';
import type { DegradationDefaults, Lancer, OnServiceUnavailable } from './lancer/index.js';

export interface ProPipelineConfig extends AiPipelineConfig {
  /**
   * Lancer platform client. Required for the pipeline.
   * Guardrail checks delegate to Glirastes Warden.
   */
  lancer: Lancer;
  degradation?: DegradationDefaults;
  onServiceUnavailable?: OnServiceUnavailable;
  /**
   * Optional generateText callback (from Vercel AI SDK or compatible).
   */
  generateText?: LocalClassifierConfig['generateText'];
}

/**
 * Create an AI pipeline that composes guardrails, classification, routing,
 * and model selection into a single `process()` call.
 */
export function createAiPipeline(config: ProPipelineConfig): AiPipeline {
  const {
    modules,
    modelSelector: modelSelectorConfig,
    models: modelsMap,
    modelInstanceFactory,
    followups: followupsConfig,
    relatedModules,
    confidenceThresholds,
    onAudit,
    lancer,
    generateText,
  } = config;

  if (!lancer) {
    throw new Error(
      'createAiPipeline requires a Lancer client. ' +
      'Create one with createLancer({ apiKey }) from glirastes/server/lancer.',
    );
  }

  const router = createAiRouter({
    modules,
    relatedModules,
    confidenceThresholds,
  });

  const modelSelector = modelsMap && modelInstanceFactory
    ? createModelSelectorFromMap(modelsMap, modelInstanceFactory, modules)
    : modelSelectorConfig
      ? createModelSelector(modelSelectorConfig, modules)
      : null;

  const classifierModel =
    modelsMap && modelInstanceFactory
      ? modelInstanceFactory(modelsMap.fast ?? modelsMap.standard ?? 'default')
      : undefined;

  const classifier = createIntentClassifier({
    modules,
    model: classifierModel,
    generateText,
    locale: config.classifier?.locale,
  });

  const followupsEnabled = followupsConfig?.enabled ?? false;
  const defaultModel = { modelId: 'default' };

  return {
    async process(
      input: string,
      context: ToolContext,
      _conversationHistory?: ConversationMessage[],
    ): Promise<PipelineResult> {
      const auditCtx = { sessionId: '' };

      let sanitizedInput = input;
      let blocked = false;
      try {
        const wardenResult = await lancer.warden.check(input, []);
        if (!wardenResult.passed) {
          blocked = true;
        }
      } catch (err) {
        if (err instanceof ServiceBlockedError) {
          blocked = true;
        }
      }

      onAudit?.({
        type: blocked ? 'guardrail.blocked' : 'guardrail.passed',
        timestamp: new Date().toISOString(),
        sessionId: auditCtx.sessionId,
        source: 'server-pro',
        details: {
          inputLength: input.length,
          blocked,
        },
      });

      if (blocked) {
        const ambiguous: IntentClassification = { intent: 'ambiguous', confidence: 0 };
        return {
          model: modelSelector?.select(ambiguous, context) ?? defaultModel,
          tools: [],
          sanitizedInput,
          intent: ambiguous,
          module: null,
          followupsEnabled,
          blocked: true,
        };
      }

      let intent: IntentClassification = { intent: 'ambiguous', confidence: 0 };
      const classifyStart = Date.now();
      try {
        intent = await classifier.classify(sanitizedInput, context);
      } catch {
        // Graceful degradation
      }

      onAudit?.({
        type: 'intent.classified',
        timestamp: new Date().toISOString(),
        sessionId: auditCtx.sessionId,
        source: 'server-pro',
        details: {
          intent: intent.intent,
          confidence: intent.confidence,
          latencyMs: Date.now() - classifyStart,
        },
      });

      const allToolNames = modules.flatMap((m) => [...m.tools, ...(m.sharedTools ?? [])]);
      const selected = router.route(intent, allToolNames);

      onAudit?.({
        type: 'routing.resolved',
        timestamp: new Date().toISOString(),
        sessionId: auditCtx.sessionId,
        source: 'server-pro',
        details: {
          module: selected.module?.id ?? null,
          strategy: selected.strategy,
          toolCount: selected.tools.length,
        },
      });

      const tools = [...selected.tools];
      if (followupsEnabled) {
        tools.push('suggest_followups');
      }

      const model = modelSelector?.select(intent, context) ?? defaultModel;

      return {
        model,
        tools: [...new Set(tools)],
        sanitizedInput,
        intent,
        module: selected.module,
        followupsEnabled,
      };
    },
  };
}
