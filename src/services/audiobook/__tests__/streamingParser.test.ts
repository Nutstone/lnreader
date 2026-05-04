import {
  extractLargestJSON,
  parseLLMJSON,
  StreamingSegmentParser,
} from '@services/audiobook/streamingParser';

describe('extractLargestJSON', () => {
  it('finds plain object', () => {
    expect(extractLargestJSON('{"a":1}')).toBe('{"a":1}');
  });

  it('finds inside prose', () => {
    expect(extractLargestJSON('here you go: {"a":1}.')).toBe('{"a":1}');
  });

  it('prefers the largest balanced segment', () => {
    expect(extractLargestJSON('{}{"a":{"b":1}}')).toBe('{"a":{"b":1}}');
  });

  it('handles strings with braces inside', () => {
    expect(extractLargestJSON('{"a":"{"}')).toBe('{"a":"{"}');
  });

  it('returns null when nothing matches', () => {
    expect(extractLargestJSON('no json here')).toBeNull();
  });
});

describe('parseLLMJSON', () => {
  it('parses fenced JSON', () => {
    expect(parseLLMJSON<{ a: number }>('```json\n{"a":1}\n```').a).toBe(1);
  });

  it('parses unfenced JSON', () => {
    expect(parseLLMJSON<{ a: number }>('{"a":1}').a).toBe(1);
  });

  it('parses JSON with prose preface', () => {
    expect(parseLLMJSON<{ a: number }>('Sure: {"a":42}').a).toBe(42);
  });

  it('throws on no JSON', () => {
    expect(() => parseLLMJSON('no JSON anywhere')).toThrow();
  });
});

describe('StreamingSegmentParser', () => {
  it('emits complete segments as they arrive', () => {
    const p = new StreamingSegmentParser<{ x: number }>();
    expect(p.push('{"segments":[{"x":1},{"x":2}')).toEqual([
      { x: 1 },
      { x: 2 },
    ]);
  });

  it('emits remainder on done()', () => {
    const p = new StreamingSegmentParser<{ x: number }>();
    p.push('{"segments":[{"x":1}');
    expect(p.push(',{"x":2}]}')).toEqual([{ x: 2 }]);
  });

  it('handles split chunks', () => {
    const p = new StreamingSegmentParser<{ x: number }>();
    expect(p.push('{"segments":[{"x":1')).toEqual([]);
    expect(p.push('}]}')).toEqual([{ x: 1 }]);
  });
});
