/**
 * Chapter sanitisation for LLM input.
 *
 * Plugins return chapter text in a variety of states: raw HTML, partial
 * HTML, plain text with embedded markup. This module produces a clean
 * plain-text version suitable for LLM annotation.
 *
 * Goals:
 *   - Strip HTML tags but preserve dialogue and paragraph structure.
 *   - Strip translator notes ([T/N: ...]), author's notes, footnotes.
 *   - Preserve quotation marks, sound-effect annotations, onomatopoeia.
 *   - Preserve scene breaks ("***", "---", "* * *") as single markers.
 *
 * Token-saving target: ≥ 30% reduction on a typical web-novel chapter.
 */

import sanitizeHtml from 'sanitize-html';

const TN_MARKERS = [
  /\[\s*(?:T\/N|TN|TL\/N|Translator['’]?s?\s*Note)\s*:\s*[^\]]*\]/gi,
  /\(\s*(?:T\/N|TN|TL\/N|Translator['’]?s?\s*Note)\s*:\s*[^)]*\)/gi,
];

const AUTHOR_NOTE_BLOCKS = [
  /(?:^|\n)\s*(?:author['’]?s?\s*notes?|a\/n)\s*:?[^\n]*\n[\s\S]*?(?=\n\s*\n|$)/gi,
  /(?:^|\n)\s*\*+\s*(?:author['’]?s?\s*notes?|a\/n)[^*]*\*+/gi,
];

const FOOTNOTE_INLINE = /\[\d+\]/g;
const SUP_FOOTNOTE = /<sup[^>]*>\s*\d+\s*<\/sup>/gi;

const SCENE_BREAK = /^\s*([*\-—_=]\s*){3,}\s*$/gm;

const BOILERPLATE_PATTERNS = [
  /(?:^|\n)\s*(?:read|continue|next chapter|previous chapter|table of contents)\s*\W*$/gim,
  /(?:^|\n)\s*chapter\s+\d+(?:\s*[-:]\s*[^\n]*)?\s*\n/gi, // header
  /(?:^|\n)\s*(?:translated|edited|proofread)\s+by\s*[^\n]*$/gim,
  /(?:^|\n)\s*support\s+(?:us|me|the\s+team)\s*[^\n]*$/gim,
  /(?:^|\n)\s*(?:patreon|ko-fi|paypal|donate)\s*[^\n]*$/gim,
];

export interface SanitiseOptions {
  /** Custom plugin-provided regexes to strip in addition to the defaults. */
  pluginBoilerplate?: RegExp[];
  /** When true, keep sound-effect lines like "*BANG*". Default true. */
  keepSoundEffects?: boolean;
  /** Maximum size of returned text; very long chapters are truncated. */
  maxChars?: number;
}

export function sanitiseChapter(
  raw: string,
  options: SanitiseOptions = {},
): string {
  if (!raw) return '';

  // Phase 0: strip footnote-tag content BEFORE sanitizeHtml unwraps it.
  const preStrip = raw.replace(SUP_FOOTNOTE, '');

  // Phase 1: strip HTML safely.
  let text = sanitizeHtml(preStrip, {
    allowedTags: [],
    allowedAttributes: {},
  });
  text = text.replace(/\n{4,}/g, '\n\n');

  // Decode common HTML entities not handled by sanitize-html when no tags.
  text = text
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");

  // Phase 2: strip footnotes and notes.
  text = text.replace(SUP_FOOTNOTE, '');
  text = text.replace(FOOTNOTE_INLINE, '');
  for (const re of TN_MARKERS) text = text.replace(re, '');
  for (const re of AUTHOR_NOTE_BLOCKS) text = text.replace(re, '');

  // Phase 3: strip plugin-specific boilerplate.
  for (const re of BOILERPLATE_PATTERNS) text = text.replace(re, '\n');
  for (const re of options.pluginBoilerplate ?? []) text = text.replace(re, '\n');

  // Phase 4: normalise scene breaks.
  text = text.replace(SCENE_BREAK, '\n\n***\n\n');

  // Phase 5: collapse whitespace.
  text = text
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();

  if (options.maxChars && text.length > options.maxChars) {
    text = text.slice(0, options.maxChars);
    // Trim to a paragraph boundary if possible.
    const lastBreak = text.lastIndexOf('\n\n');
    if (lastBreak > options.maxChars * 0.8) {
      text = text.slice(0, lastBreak);
    }
  }

  return text;
}

/**
 * Detect scene breaks and return chunks of the chapter for chunked LLM
 * annotation. Returns the original text as a single chunk if no breaks
 * are found.
 */
export function chunkAtSceneBreaks(text: string, targetChars: number): string[] {
  if (text.length <= targetChars) return [text];
  const breaks = [...text.matchAll(/\n\n\*\*\*\n\n/g)];
  if (breaks.length === 0) return chunkAtParagraphs(text, targetChars);

  const chunks: string[] = [];
  let cursor = 0;
  let buffer = '';
  for (const m of breaks) {
    const idx = m.index ?? 0;
    const part = text.slice(cursor, idx + m[0].length);
    if (buffer.length + part.length > targetChars && buffer.length > 0) {
      chunks.push(buffer);
      buffer = part;
    } else {
      buffer += part;
    }
    cursor = idx + m[0].length;
  }
  buffer += text.slice(cursor);
  if (buffer) chunks.push(buffer);

  // If any chunk is still too long, fall back to paragraph chunking on it.
  return chunks.flatMap(c =>
    c.length > targetChars ? chunkAtParagraphs(c, targetChars) : [c],
  );
}

function chunkAtParagraphs(text: string, targetChars: number): string[] {
  const paragraphs = text.split(/\n\n+/);
  const chunks: string[] = [];
  let buffer = '';
  for (const p of paragraphs) {
    if (buffer.length + p.length + 2 > targetChars && buffer.length > 0) {
      chunks.push(buffer.trim());
      buffer = p;
    } else {
      buffer = buffer ? buffer + '\n\n' + p : p;
    }
  }
  if (buffer) chunks.push(buffer.trim());
  return chunks;
}
