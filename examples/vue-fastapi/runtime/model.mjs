import { createOpenAI } from '@ai-sdk/openai';

/**
 * The chat model. The fixture ships no model and no key: without
 * ACCEPTANCE_MODEL this throws, as an app that has not configured one.
 *
 * For the second acceptance run (docs/acceptance/second-app-vue-fastapi.md)
 * ACCEPTANCE_MODEL names an OpenRouter model (`openai/gpt-4o` as the
 * baseline, a Claude model as the second one), reached through the
 * OpenAI-compatible API with the key in OPENROUTER_API_KEY.
 */
export function chatModel(env = process.env) {
  const modelId = env.ACCEPTANCE_MODEL?.trim();
  if (!modelId) throw new Error('Configure the chat model in runtime/model.mjs');
  const apiKey = env.OPENROUTER_API_KEY?.trim();
  if (!apiKey) throw new Error('ACCEPTANCE_MODEL is set, but OPENROUTER_API_KEY is not');
  const openrouter = createOpenAI({ baseURL: 'https://openrouter.ai/api/v1', apiKey });
  // Chat Completions: the API OpenRouter implements for every model.
  return openrouter.chat(modelId);
}
