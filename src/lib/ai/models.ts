export type AiProvider = 'openai' | 'deepseek' | 'qwen';

export interface AiModelDefinition {
  key: string;
  provider: AiProvider;
  apiModel: string;
  displayName: string;
  description: string;
  inputPricePerMillion: number;
  cachedInputPricePerMillion?: number;
  outputPricePerMillion: number;
  currency: 'USD';
  priceScope: string;
  pricingEffectiveAt: string;
  enabled: boolean;
  supportsStructuredOutput: boolean;
  supportsPromptCaching: boolean;
  supportsThinking: boolean;
  defaultThinkingMode: 'minimal' | 'disabled';
  isDefault: boolean;
  sortOrder: number;
  fallbackModelKey?: string;
}

export const AI_MODELS: readonly AiModelDefinition[] = [
  { key: 'deepseek-v4-flash', provider: 'deepseek', apiModel: 'deepseek-v4-flash', displayName: 'DeepSeek V4 Flash', description: 'Fast, economical comment generation.', inputPricePerMillion: 0.14, cachedInputPricePerMillion: 0.0028, outputPricePerMillion: 0.28, currency: 'USD', priceScope: 'list', pricingEffectiveAt: '2026-07-26', enabled: true, supportsStructuredOutput: true, supportsPromptCaching: true, supportsThinking: false, defaultThinkingMode: 'disabled', isDefault: true, sortOrder: 1, fallbackModelKey: 'gpt-5.4-mini' },
  { key: 'deepseek-v4-pro', provider: 'deepseek', apiModel: 'deepseek-v4-pro', displayName: 'DeepSeek V4 Pro', description: 'Higher-capability DeepSeek generation.', inputPricePerMillion: 0.435, cachedInputPricePerMillion: 0.003625, outputPricePerMillion: 0.87, currency: 'USD', priceScope: 'list', pricingEffectiveAt: '2026-07-26', enabled: true, supportsStructuredOutput: true, supportsPromptCaching: true, supportsThinking: false, defaultThinkingMode: 'disabled', isDefault: false, sortOrder: 2, fallbackModelKey: 'gpt-5.4-mini' },
  { key: 'gpt-5.4-mini', provider: 'openai', apiModel: 'gpt-5.4-mini', displayName: 'GPT-5.4 mini', description: 'Compact OpenAI generation.', inputPricePerMillion: 0.75, cachedInputPricePerMillion: 0.075, outputPricePerMillion: 4.5, currency: 'USD', priceScope: 'short-context list', pricingEffectiveAt: '2026-07-26', enabled: true, supportsStructuredOutput: true, supportsPromptCaching: true, supportsThinking: true, defaultThinkingMode: 'minimal', isDefault: false, sortOrder: 3, fallbackModelKey: 'gpt-5.4' },
  { key: 'gpt-5.4', provider: 'openai', apiModel: 'gpt-5.4', displayName: 'GPT-5.4', description: 'Highest-capability OpenAI generation.', inputPricePerMillion: 2.5, cachedInputPricePerMillion: 0.25, outputPricePerMillion: 15, currency: 'USD', priceScope: 'short-context list', pricingEffectiveAt: '2026-07-26', enabled: true, supportsStructuredOutput: true, supportsPromptCaching: true, supportsThinking: true, defaultThinkingMode: 'minimal', isDefault: false, sortOrder: 4 },
  { key: 'qwen3.7-plus', provider: 'qwen', apiModel: 'qwen3.7-plus', displayName: 'Qwen 3.7 Plus', description: 'Qwen Global, Frankfurt.', inputPricePerMillion: 0.276, outputPricePerMillion: 1.101, currency: 'USD', priceScope: 'Global Frankfurt requests up to 256K', pricingEffectiveAt: '2026-07-26', enabled: true, supportsStructuredOutput: true, supportsPromptCaching: false, supportsThinking: false, defaultThinkingMode: 'disabled', isDefault: false, sortOrder: 5, fallbackModelKey: 'gpt-5.4-mini' },
] as const;

export const DEFAULT_MODEL_KEY = 'deepseek-v4-flash';
export const LEGACY_MODEL_KEY = 'gpt-5.4';

export function getAiModel(key: string): AiModelDefinition | undefined { return AI_MODELS.find((model) => model.key === key); }
export function isAiModelKey(key: string): boolean { return Boolean(getAiModel(key)); }
export function isProviderConfigured(provider: AiProvider): boolean {
  if (provider === 'openai') return Boolean(process.env.OPENAI_API_KEY);
  if (provider === 'deepseek') return Boolean(process.env.DEEPSEEK_API_KEY);
  return Boolean(process.env.DASHSCOPE_API_KEY || process.env.QWEN_API_KEY);
}
export function getPublicAiModels() { return AI_MODELS.map(({ key, provider, displayName, description, inputPricePerMillion, outputPricePerMillion, currency, enabled, sortOrder }) => ({ key, provider, displayName, description, inputPricePerMillion, outputPricePerMillion, currency, enabled, sortOrder, configured: isProviderConfigured(provider) })); }

/** A fallback is an explicit registry decision, never an inferred provider swap. */
export function getConfiguredFallbackModel(modelKey: string): AiModelDefinition | undefined {
  const fallbackKey = getAiModel(modelKey)?.fallbackModelKey;
  const fallback = fallbackKey ? getAiModel(fallbackKey) : undefined;
  return fallback?.enabled && isProviderConfigured(fallback.provider) ? fallback : undefined;
}
