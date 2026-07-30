import 'server-only';
import { createHash } from 'node:crypto';
import { ALLOWED_EMOJIS, SlotPlan } from './planner';

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

  // Match emoji ranges using Unicode property escapes
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
  // Splits by period, exclamation, or question mark followed by space or end
  const sentences = text
    .split(/[.!?]+(?:\s+|$)/)
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
  plan: SlotPlan,
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
  // Ensures most characters are Latin/standard English
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
