import { hashChapterPath, chapterKeyFor } from '@services/audiobook/chapterPath';

describe('hashChapterPath', () => {
  it('returns 16-char hex', () => {
    const h = hashChapterPath('/novel/12345/chapter-1');
    expect(h).toMatch(/^[0-9a-f]{16}$/);
  });

  it('is deterministic', () => {
    expect(hashChapterPath('/a/b/c')).toBe(hashChapterPath('/a/b/c'));
  });

  it('differs across paths', () => {
    expect(hashChapterPath('/a')).not.toBe(hashChapterPath('/b'));
  });

  it('handles empty/missing input', () => {
    expect(chapterKeyFor(null)).toBe('unknown');
    expect(chapterKeyFor(undefined)).toBe('unknown');
    expect(chapterKeyFor('')).toBe('unknown');
  });
});
