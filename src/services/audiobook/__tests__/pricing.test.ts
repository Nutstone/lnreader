import {
  PRICING_TABLE,
  findPricing,
  recommendedModelFor,
  listModelsFor,
  estimateTokens,
} from '@services/audiobook/pricing';

describe('PRICING_TABLE', () => {
  it('has at least Anthropic Sonnet recommended', () => {
    expect(
      PRICING_TABLE.some(
        p =>
          p.provider === 'anthropic' &&
          p.model === 'claude-sonnet-4-6' &&
          p.recommended,
      ),
    ).toBe(true);
  });

  it('has at least one Ollama recommended', () => {
    expect(PRICING_TABLE.some(p => p.provider === 'ollama' && p.recommended)).toBe(
      true,
    );
  });

  it('Ollama entries are zero-cost', () => {
    for (const p of PRICING_TABLE.filter(p => p.provider === 'ollama')) {
      expect(p.inputPerM).toBe(0);
      expect(p.outputPerM).toBe(0);
    }
  });
});

describe('findPricing', () => {
  it('finds known model', () => {
    expect(findPricing('anthropic', 'claude-sonnet-4-6')).toBeDefined();
  });

  it('returns undefined for unknown', () => {
    expect(findPricing('anthropic', 'claude-magic-9000')).toBeUndefined();
  });
});

describe('recommendedModelFor', () => {
  it('returns Sonnet for anthropic', () => {
    expect(recommendedModelFor('anthropic').model).toBe('claude-sonnet-4-6');
  });

  it('returns 70b for ollama', () => {
    expect(recommendedModelFor('ollama').model).toBe('llama3.1:70b');
  });
});

describe('listModelsFor', () => {
  it('returns all models for a provider', () => {
    expect(listModelsFor('anthropic').length).toBeGreaterThan(0);
    expect(listModelsFor('ollama').length).toBeGreaterThan(0);
  });
});

describe('estimateTokens', () => {
  it('returns 0 for empty', () => {
    expect(estimateTokens('')).toBe(0);
  });

  it('approximates 4 chars / token', () => {
    expect(estimateTokens('a'.repeat(40))).toBe(10);
  });
});
