/**
 * LLM pricing table.
 *
 * Verify against the provider's published rates before relying on this
 * for billing decisions — provider pricing changes. The numbers here
 * are anchors for cost-estimation UI; if a user reports a 20% delta,
 * update this file and ship.
 *
 * Numbers are USD per million tokens.
 */

import { LLMProvider } from './types';

export interface PricingEntry {
  provider: LLMProvider;
  model: string;
  /** USD per 1M input tokens. */
  inputPerM: number;
  /** USD per 1M cached-read input tokens (Anthropic only). */
  cachedInputPerM: number;
  /** USD per 1M output tokens. */
  outputPerM: number;
  description: string;
  /** Recommended for default selection within the provider. */
  recommended?: boolean;
}

// Numbers documented at https://platform.claude.com/docs/en/about-claude/models/overview
// at the time of writing. Treat as anchors; verify before billing.
export const PRICING_TABLE: PricingEntry[] = [
  {
    provider: 'anthropic',
    model: 'claude-sonnet-4-6',
    inputPerM: 3.0,
    cachedInputPerM: 0.3,
    outputPerM: 15.0,
    description: 'Quality default. Best literary judgement on Anthropic.',
    recommended: true,
  },
  {
    provider: 'anthropic',
    model: 'claude-opus-4-7',
    inputPerM: 15.0,
    cachedInputPerM: 1.5,
    outputPerM: 75.0,
    description:
      'Top-tier nuance for complex novels; usually overkill for chapter segmentation.',
  },
  {
    provider: 'anthropic',
    model: 'claude-haiku-4-5',
    inputPerM: 1.0,
    cachedInputPerM: 0.1,
    outputPerM: 5.0,
    description: 'Cheapest Anthropic option; quality dips on subtle dialogue.',
  },

  // Local — free.
  {
    provider: 'ollama',
    model: 'llama3.1:70b',
    inputPerM: 0,
    cachedInputPerM: 0,
    outputPerM: 0,
    description: 'Local; free; needs a PC running Ollama.',
    recommended: true,
  },
  {
    provider: 'ollama',
    model: 'qwen2.5:32b',
    inputPerM: 0,
    cachedInputPerM: 0,
    outputPerM: 0,
    description:
      'Smaller, faster local option; reasonable cast quality on a 24 GB GPU.',
  },
  {
    provider: 'ollama',
    model: 'llama3.1:8b',
    inputPerM: 0,
    cachedInputPerM: 0,
    outputPerM: 0,
    description: 'Fast local; struggles with complex multi-character dialogue.',
  },
];

export function findPricing(
  provider: LLMProvider,
  model: string,
): PricingEntry | undefined {
  return PRICING_TABLE.find(p => p.provider === provider && p.model === model);
}

export function recommendedModelFor(provider: LLMProvider): PricingEntry {
  const recommended = PRICING_TABLE.find(
    p => p.provider === provider && p.recommended,
  );
  if (!recommended) {
    const first = PRICING_TABLE.find(p => p.provider === provider);
    if (!first) {
      throw new Error(`No pricing entry for provider ${provider}`);
    }
    return first;
  }
  return recommended;
}

export function listModelsFor(provider: LLMProvider): PricingEntry[] {
  return PRICING_TABLE.filter(p => p.provider === provider);
}

/**
 * Approximate token estimator. ±20% is fine for cost preview UI.
 * Don't pull in a real tokenizer — adds 1 MB and we don't need accuracy.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
