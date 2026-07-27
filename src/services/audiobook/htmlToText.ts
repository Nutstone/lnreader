import { Parser } from 'htmlparser2';

const BLOCK_TAGS = new Set([
  'p',
  'div',
  'br',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'li',
  'tr',
  'blockquote',
  'section',
  'article',
  'hr',
]);

const SKIP_TAGS = new Set(['script', 'style', 'head', 'title', 'noscript']);

/**
 * Converts chapter HTML into plain text with paragraph breaks preserved,
 * for feeding to the LLM annotator and TTS (which would otherwise read
 * markup aloud).
 */
export function htmlToText(html: string): string {
  let out = '';
  let skipDepth = 0;

  const parser = new Parser(
    {
      onopentag(name) {
        if (SKIP_TAGS.has(name)) {
          skipDepth++;
        }
      },
      ontext(text) {
        if (!skipDepth) {
          out += text;
        }
      },
      onclosetag(name) {
        if (SKIP_TAGS.has(name)) {
          skipDepth = Math.max(0, skipDepth - 1);
          return;
        }
        if (BLOCK_TAGS.has(name)) {
          out += '\n\n';
        }
      },
    },
    { decodeEntities: true },
  );
  parser.write(html);
  parser.end();

  return out
    .replace(/ /g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
