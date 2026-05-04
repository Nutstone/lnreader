/**
 * Keyword → archetype scoring matrix (English).
 *
 * Per-keyword scores let one keyword vote for multiple archetypes,
 * which makes ties resolve naturally. The matcher sums scores across
 * all keywords for a character; highest archetype wins.
 *
 * Add keywords freely — data-only change with no test impact.
 */

import { ArchetypeScores } from '../types';
import { EN_KEYWORD_SCORES } from './en';

export const KEYWORD_SCORES: Record<string, ArchetypeScores> = EN_KEYWORD_SCORES;

/**
 * Lowercase + strip whitespace and ASCII punctuation. Preserves
 * non-ASCII chars in case the LLM occasionally emits a foreign-language
 * loanword like "tsundere" or "shounen".
 */
export function normaliseKeyword(keyword: string): string {
  return keyword
    .toLowerCase()
    .normalize('NFC')
    .replace(/[\s\-_]+/g, '')
    .replace(/[!-/:-@[-`{-~]/g, '');
}
