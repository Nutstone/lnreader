import {
  getEmotionModulation,
  pauseTypeToMs,
  PAUSE_DURATIONS,
} from '@services/audiobook/emotionModulation';

describe('getEmotionModulation', () => {
  it('returns neutral for neutral emotion', () => {
    const m = getEmotionModulation('neutral', 2, 'Bob');
    expect(m.speedMultiplier).toBe(1);
    expect(m.pitchOffset).toBe(0);
    expect(m.volumeOffset).toBe(0);
  });

  it('caps intensity at 2 for reserved speakers', () => {
    const m3 = getEmotionModulation('angry', 3, 'narrator');
    const m2 = getEmotionModulation('angry', 2, 'narrator');
    expect(m3).toEqual(m2);
  });

  it('respects intensity for normal speakers', () => {
    const m1 = getEmotionModulation('angry', 1, 'Bob');
    const m3 = getEmotionModulation('angry', 3, 'Bob');
    expect(m3.speedMultiplier).toBeGreaterThan(m1.speedMultiplier);
  });

  it('whisper has volume offset of -6', () => {
    const m = getEmotionModulation('whisper', 2, 'Bob');
    expect(m.volumeOffset).toBe(-6);
  });

  it('shouting at intensity 3 is loud and fast', () => {
    const m = getEmotionModulation('shouting', 3, 'Bob');
    expect(m.volumeOffset).toBeGreaterThan(0);
    expect(m.speedMultiplier).toBeGreaterThan(1);
  });
});

describe('pauseTypeToMs', () => {
  it('matches the pause table', () => {
    expect(pauseTypeToMs('short')).toBe(PAUSE_DURATIONS.short);
    expect(pauseTypeToMs('medium')).toBe(PAUSE_DURATIONS.medium);
    expect(pauseTypeToMs('long')).toBe(PAUSE_DURATIONS.long);
  });

  it('applies the multiplier', () => {
    expect(pauseTypeToMs('short', 2)).toBe(PAUSE_DURATIONS.short * 2);
  });
});
