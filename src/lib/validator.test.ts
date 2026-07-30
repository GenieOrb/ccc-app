import { describe, expect, it } from 'vitest';
import { validateCommentLocally } from './validator';
import type { SlotPlan } from './planner';

const ultraShortPlan: SlotPlan = {
  slotIndex: 0,
  lengthMode: 'ultra_short',
  emojiPolicy: 'no_emoji',
  rhetoricalForm: 'direct_reaction',
  texture: 'plain',
  deliveryOrder: 1,
  assignedPostId: 'post-1',
};

describe('validateCommentLocally ultra_short', () => {
  it('accepts two concise sentences within the existing word and character limits', () => {
    expect(validateCommentLocally('This is useful. I will try it.', ultraShortPlan)).toEqual({ valid: true });
  });
});
