/**
 * Forgiving JSON-extractor.
 *
 * LLMs occasionally wrap JSON in fences, prefix with prose, or truncate.
 * This module finds the largest balanced JSON object/array in a string,
 * tolerating common imperfections. It also provides an incremental
 * parser used during streaming responses.
 */

/**
 * Extract the largest balanced JSON object or array from arbitrary text.
 * Returns null if none can be found.
 */
export function extractLargestJSON(text: string): string | null {
  let best: { start: number; end: number } | null = null;
  let depth = 0;
  let openIdx = -1;
  let openChar = '';
  let inString = false;
  let escape = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];

    if (inString) {
      if (escape) {
        escape = false;
      } else if (ch === '\\') {
        escape = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
      continue;
    }

    if (ch === '{' || ch === '[') {
      if (depth === 0) {
        openIdx = i;
        openChar = ch;
      }
      depth++;
    } else if (ch === '}' || ch === ']') {
      depth--;
      if (depth === 0 && openIdx >= 0) {
        const close = openChar === '{' ? '}' : ']';
        if (ch === close) {
          if (!best || i - openIdx > best.end - best.start) {
            best = { start: openIdx, end: i };
          }
        }
        openIdx = -1;
      }
    }
  }

  if (!best) return null;
  return text.slice(best.start, best.end + 1);
}

/**
 * Parse JSON from arbitrary LLM output. Throws on irrecoverable input.
 */
export function parseLLMJSON<T>(text: string): T {
  // Strip markdown fences first.
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1] : text;

  try {
    return JSON.parse(candidate.trim()) as T;
  } catch {
    const extracted = extractLargestJSON(candidate);
    if (!extracted) {
      throw new Error(
        'No JSON found in LLM response: ' +
          (candidate.length > 200 ? candidate.slice(0, 200) + '…' : candidate),
      );
    }
    return JSON.parse(extracted) as T;
  }
}

/**
 * Incrementally accumulate a streamed JSON response with a known shape:
 *
 *   { "segments": [ {...}, {...}, ... ] }
 *
 * On each chunk, yields fully-parsed segment objects as they become
 * available. Use the result of `done()` once the stream ends to flush
 * any remaining buffer.
 */
export class StreamingSegmentParser<T> {
  private buffer = '';
  private emittedCount = 0;
  private segmentsKeyFound = false;
  private arrayStartIdx = -1;

  constructor(private readonly key: string = 'segments') {}

  push(chunk: string): T[] {
    this.buffer += chunk;
    return this.tryEmit();
  }

  done(): T[] {
    return this.tryEmit();
  }

  private tryEmit(): T[] {
    if (!this.segmentsKeyFound) {
      // Look for `"<key>": [`
      const re = new RegExp(`["']${this.key}["']\\s*:\\s*\\[`);
      const m = this.buffer.match(re);
      if (!m) return [];
      this.arrayStartIdx = (m.index ?? 0) + m[0].length;
      this.segmentsKeyFound = true;
    }

    const out: T[] = [];
    let i = this.arrayStartIdx;
    let consumedThrough = i;
    while (i < this.buffer.length) {
      // Skip whitespace and commas.
      while (
        i < this.buffer.length &&
        (this.buffer[i] === ' ' ||
          this.buffer[i] === '\n' ||
          this.buffer[i] === '\r' ||
          this.buffer[i] === '\t' ||
          this.buffer[i] === ',')
      ) {
        i++;
      }
      if (i >= this.buffer.length) break;
      if (this.buffer[i] === ']') {
        // End of array.
        consumedThrough = i + 1;
        break;
      }
      if (this.buffer[i] !== '{') break;

      // Find balanced object end starting at i.
      const end = findObjectEnd(this.buffer, i);
      if (end < 0) break; // need more input

      const slice = this.buffer.slice(i, end + 1);
      try {
        const parsed = JSON.parse(slice) as T;
        out.push(parsed);
        this.emittedCount++;
      } catch {
        // unparseable; abort streaming and let the caller fall back to
        // a single-shot parse on `done()`.
        break;
      }
      i = end + 1;
      consumedThrough = i;
    }

    if (consumedThrough > this.arrayStartIdx) {
      // Compact the buffer to just what we haven't consumed yet.
      this.buffer = this.buffer.slice(consumedThrough);
      this.arrayStartIdx = 0;
    }
    return out;
  }
}

function findObjectEnd(s: string, start: number): number {
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (inString) {
      if (escape) escape = false;
      else if (ch === '\\') escape = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === '{') {depth++;}
    else if (ch === '}') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}
