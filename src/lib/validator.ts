import 'server-only';
import { createHash } from 'node:crypto';
import { ALLOWED_EMOJIS } from './planner';
import { SlotPlanV2 } from './brand-variants';

export function normalizeCommentText(text: string): string {
  if (!text) return '';
  return text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/https?:\/\/\S+/gi, '') // Remove URLs
    .replace(/[^\p{L}\p{N}\s]/gu, '') // Keep letters, numbers, spaces
    .replace(/\s+/g, ' ')
    .trim();
}

export function computeNormalizedHash(normalizedText: string): string {
  return createHash('sha256').update(normalizedText).digest('hex');
}

export function countEmojisInText(text: string): { totalCount: number; validListCount: number; foundEmojis: string[] } {
  const segmenter = new Intl.Segmenter('en', { granularity: 'grapheme' });
  const allowedSet = new Set(ALLOWED_EMOJIS);

  let totalCount = 0;
  let validListCount = 0;
  const foundEmojis: string[] = [];

  const emojiRegex = /\p{Extended_Pictographic}/u;

  for (const { segment } of segmenter.segment(text)) {
    if (emojiRegex.test(segment)) {
      totalCount++;
      if (allowedSet.has(segment)) {
        validListCount++;
        foundEmojis.push(segment);
      }
    }
  }

  return { totalCount, validListCount, foundEmojis };
}

function countWords(text: string): number {
  const normalized = text.replace(/https?:\/\/\S+/gi, '').replace(/[^\p{L}\p{N}\s]/gu, ' ').trim();
  if (!normalized) return 0;
  return normalized.split(/\s+/).filter((w) => w.length > 0).length;
}

function countSentences(text: string): number {
  const sentences = text
    .split(/[.!?]+(?:\s+|$)|(?:\n+)/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return sentences.length;
}

export interface ValidationResult {
  valid: boolean;
  reason?: string;
}

export function validateCommentLocally(
  commentText: string,
  plan: SlotPlanV2,
  recentComments: string[] = [],
  campaignDirection?: string
): ValidationResult {
  const trimmed = commentText.trim();
  if (!trimmed) {
    return { valid: false, reason: 'Comment text is empty.' };
  }

  // 1. Check for URLs
  if (/https?:\/\/\S+/i.test(trimmed) || /www\.\S+/i.test(trimmed)) {
    return { valid: false, reason: 'Comment contains a forbidden URL.' };
  }

  // Brand Variant Validation
  let textForStrictChecks = trimmed;
  if (plan.brandVariant) {
    const brandIdx = trimmed.indexOf(plan.brandVariant);
    if (brandIdx === -1) {
      return { valid: false, reason: `Brand variant "${plan.brandVariant}" is missing or incorrect casing.` };
    }
    const lastIdx = trimmed.lastIndexOf(plan.brandVariant);
    if (brandIdx !== lastIdx) {
      return { valid: false, reason: `Brand variant "${plan.brandVariant}" appears more than once.` };
    }
    // Remove the brand variant for lowercase/punctuation checks
    textForStrictChecks = trimmed.replace(plan.brandVariant, '');
  }

  // Voice Family Validation
  const firstPersonRegex = /\b(i|me|my|mine|i'm|i've|i'll|i'd|im|ive|ill|id)\b/i;
  const hasFirstPerson = firstPersonRegex.test(trimmed);
  if (plan.voiceFamily === 'first_person' && !hasFirstPerson) {
    return { valid: false, reason: `First person voice required but no first person pronouns found.` };
  } else if (plan.voiceFamily === 'general' && hasFirstPerson) {
    return { valid: false, reason: `General voice required but first person pronouns found.` };
  }

  // Punctuation Validation
  if (plan.punctuationMode === 'no_punctuation') {
    if (/[.,!?;:()[\]{}"'`\-—_…]/.test(textForStrictChecks)) {
      return { valid: false, reason: `no_punctuation mode violated.` };
    }
  } else if (plan.punctuationMode === 'commas_only') {
    if (/[.!?;:()[\]{}"'`\-—_…]/.test(textForStrictChecks)) {
      return { valid: false, reason: `commas_only mode violated by other punctuation.` };
    }
  } else if (plan.punctuationMode === 'ellipsis_required') {
    if (!trimmed.includes('...')) {
      return { valid: false, reason: `ellipsis_required mode violated (no ... found).` };
    }
  }

  // Capitalization Validation
  if (plan.capitalizationMode === 'lowercase_only') {
    if (/[A-Z]/.test(textForStrictChecks)) {
      return { valid: false, reason: `lowercase_only mode violated.` };
    }
  }

  // Syntax Validation
  if (plan.syntaxMode === 'parenthetical_aside') {
    if (!trimmed.includes('(') || !trimmed.includes(')')) {
      return { valid: false, reason: `parenthetical_aside syntax requires parentheses.` };
    }
  } else if (plan.syntaxMode === 'double_space_between_words') {
    if (commentText.length !== trimmed.length) {
      return { valid: false, reason: 'double_space_between_words mode violated (leading or trailing spaces found).' };
    }
    if (/\t/.test(commentText)) {
      return { valid: false, reason: 'double_space_between_words mode violated (tab character found).' };
    }
    if (/ {3,}/.test(commentText)) {
      return { valid: false, reason: 'double_space_between_words mode violated (three or more spaces found).' };
    }
    const doubleSpaceMatches = [...commentText.matchAll(/ {2}/g)];
    if (doubleSpaceMatches.length === 0) {
      return { valid: false, reason: 'double_space_between_words mode violated (no double space found).' };
    }
    if (doubleSpaceMatches.length > 1) {
      return { valid: false, reason: 'double_space_between_words mode violated (multiple double spaces found).' };
    }
    const match = /([\p{L}\p{N}]) {2}([\p{L}\p{N}])/u.exec(commentText);
    if (!match) {
      return { valid: false, reason: 'double_space_between_words mode violated (double space not strictly between two ASCII/Unicode words).' };
    }
    if (plan.brandVariant) {
      const brandIdx = commentText.indexOf(plan.brandVariant);
      if (brandIdx !== -1) {
        const doubleSpaceIdx = commentText.indexOf('  ');
        if (doubleSpaceIdx >= brandIdx && doubleSpaceIdx < brandIdx + plan.brandVariant.length) {
          return { valid: false, reason: 'double_space_between_words mode violated (double space is inside the brand variant).' };
        }
      }
    }
  } else if (plan.syntaxMode === 'rhetorical_question') {
    if (!trimmed.includes('?')) {
      return { valid: false, reason: `rhetorical_question syntax requires a question mark.` };
    }
  } else if (plan.syntaxMode === 'line_breaks') {
    if (!trimmed.includes('\n')) {
      return { valid: false, reason: `line_breaks syntax requires at least one newline.` };
    }
  }

  // 2. Length & Sentence constraints
  const charLength = Array.from(trimmed).length;
  const wordCount = countWords(trimmed);
  const sentenceCount = countSentences(trimmed);

  if (plan.lengthMode === 'ultra_short') {
    if (sentenceCount > 2) {
      return { valid: false, reason: `ultra_short mode allows at most 2 sentences, found ${sentenceCount}.` };
    }
    if (wordCount > 20) {
      return { valid: false, reason: `ultra_short mode exceeds maximum of 20 words (found ${wordCount}).` };
    }
    if (charLength > 180) {
      return { valid: false, reason: `ultra_short mode exceeds maximum of 180 Unicode characters (found ${charLength}).` };
    }
  } else if (plan.lengthMode === 'normal') {
    if (wordCount > 45) {
      return { valid: false, reason: `normal mode exceeds maximum of 45 words (found ${wordCount}).` };
    }
    if (charLength > 260) {
      return { valid: false, reason: `normal mode exceeds maximum of 260 Unicode characters (found ${charLength}).` };
    }
  }

  if (plan.syntaxMode === 'short_bursts') {
    if (sentenceCount < 2) {
      return { valid: false, reason: `short_bursts syntax requires multiple short sentences.` };
    }
  }

  // 3. Emoji rules
  const emojiInfo = countEmojisInText(trimmed);
  if (plan.emojiPolicy === 'one_emoji') {
    if (emojiInfo.totalCount !== 1) {
      return { valid: false, reason: `one_emoji policy requires exactly 1 emoji, found ${emojiInfo.totalCount}.` };
    }
    if (emojiInfo.validListCount !== 1) {
      return { valid: false, reason: `The emoji used is not in the allowed list.` };
    }
  } else if (plan.emojiPolicy === 'no_emoji') {
    if (emojiInfo.totalCount !== 0) {
      return { valid: false, reason: `no_emoji policy requires zero emojis, found ${emojiInfo.totalCount}.` };
    }
  }

  // 4. English language character sanity check
  const latinCount = (trimmed.match(/[\p{Script=Latin}\p{N}\p{P}\s]/gu) || []).length;
  const nonEmojiCharLength = charLength - emojiInfo.totalCount;
  if (nonEmojiCharLength > 0 && latinCount / nonEmojiCharLength < 0.85) {
    return { valid: false, reason: 'Comment contains non-English or unrecognized scripts.' };
  }

  // 5. Check against recent comments for repetition
  const currentNormalized = normalizeCommentText(trimmed);
  const currentWords = currentNormalized.split(' ').filter(Boolean);

  for (const recent of recentComments) {
    const recentNorm = normalizeCommentText(recent);
    if (currentNormalized === recentNorm) {
      return { valid: false, reason: 'Exact duplicate of a recent comment.' };
    }

    const recentWords = recentNorm.split(' ').filter(Boolean);

    // Check first 4 words identical
    if (currentWords.length >= 4 && recentWords.length >= 4) {
      const currentFirst4 = currentWords.slice(0, 4).join(' ');
      const recentFirst4 = recentWords.slice(0, 4).join(' ');
      if (currentFirst4 === recentFirst4) {
        return { valid: false, reason: 'First 4 words are identical to a recent comment.' };
      }
    }

    // Check >60% word overlap
    if (currentWords.length > 0 && recentWords.length > 0) {
      const currentSet = new Set(currentWords);
      const overlapCount = recentWords.filter((w) => currentSet.has(w)).length;
      const overlapRatio = overlapCount / Math.max(currentWords.length, recentWords.length);
      if (overlapRatio > 0.60) {
        return { valid: false, reason: `Over 60% word overlap (${Math.round(overlapRatio * 100)}%) with a recent comment.` };
      }
    }
  }

  // 6. Check for Campaign Direction leakage
  if (campaignDirection) {
    const normDir = normalizeCommentText(campaignDirection);
    const dirWords = normDir.split(' ').filter(Boolean);
    if (dirWords.length >= 2) {
      if (currentNormalized.includes(normDir)) {
        return {
          valid: false,
          reason: 'The comment literally copied the administrative campaign direction. You must generate a new comment applying the direction semantically without repeating it.'
        };
      }
      const firstTwoDirWords = dirWords.slice(0, 2).join(' ');
      if (currentNormalized.startsWith(firstTwoDirWords)) {
        return {
          valid: false,
          reason: 'The comment starts with the administrative campaign direction. You must generate a new comment directly talking about the post without using the instruction as a prefix.'
        };
      }
    }
  }

  return { valid: true };
}
