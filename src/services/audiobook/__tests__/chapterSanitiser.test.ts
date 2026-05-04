import {
  sanitiseChapter,
  chunkAtSceneBreaks,
} from '@services/audiobook/chapterSanitiser';

describe('sanitiseChapter', () => {
  it('strips HTML tags but keeps text', () => {
    const out = sanitiseChapter('<p>Hello <b>world</b>.</p>');
    expect(out).toContain('Hello world.');
    expect(out).not.toContain('<');
  });

  it('removes T/N markers', () => {
    const out = sanitiseChapter('She smiled. [T/N: meaningfully] He nodded.');
    expect(out).toContain('She smiled.');
    expect(out).toContain('He nodded.');
    expect(out).not.toContain('T/N');
    expect(out).not.toContain('meaningfully');
  });

  it('removes superscript footnotes', () => {
    const out = sanitiseChapter('A reference<sup>1</sup> here.');
    expect(out).not.toContain('1');
    expect(out).toContain('A reference');
  });

  it('removes inline footnote markers', () => {
    const out = sanitiseChapter('A reference[1] here.');
    expect(out).not.toMatch(/\[1\]/);
  });

  it('preserves dialogue quotes', () => {
    const out = sanitiseChapter('"Hello," she said.');
    expect(out).toContain('"');
  });

  it('normalises scene breaks', () => {
    const out = sanitiseChapter('para1\n\n* * *\n\npara2');
    expect(out).toContain('***');
  });

  it('truncates if maxChars set', () => {
    const long = 'a'.repeat(10000);
    const out = sanitiseChapter(long, { maxChars: 100 });
    expect(out.length).toBeLessThanOrEqual(100);
  });

  it('handles empty input', () => {
    expect(sanitiseChapter('')).toBe('');
  });
});

describe('chunkAtSceneBreaks', () => {
  it('returns single chunk if under target', () => {
    expect(chunkAtSceneBreaks('short text', 1000)).toEqual(['short text']);
  });

  it('splits at scene breaks when over target', () => {
    const text = 'a'.repeat(500) + '\n\n***\n\n' + 'b'.repeat(500);
    const chunks = chunkAtSceneBreaks(text, 600);
    expect(chunks.length).toBeGreaterThan(1);
  });
});
