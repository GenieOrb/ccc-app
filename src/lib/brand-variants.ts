import 'server-only';
import { LengthMode, EmojiPolicy, RhetoricalForm, Textures } from './planner';

export type VoiceFamily = 'general' | 'first_person';

export type FirstPersonSubfamily =
  | 'personal_experience'
  | 'future_intention'
  | 'personal_lesson'
  | 'personal_preference'
  | 'lived_difficulty'
  | 'changed_mind';

export type EmotionalTone =
  | 'neutral'
  | 'histrionic_humor'
  | 'blunt_irreverent'
  | 'surprised'
  | 'skeptical'
  | 'enthusiastic'
  | 'frustrated'
  | 'nostalgic'
  | 'challenging'
  | 'calm_reflective';

export type PunctuationMode =
  | 'standard'
  | 'no_punctuation'
  | 'commas_only'
  | 'ellipsis_required';

export type CapitalizationMode = 'standard' | 'lowercase_only';

export type ExpressionMode = 'standard' | 'spontaneous_vocal_reaction';

export type SyntaxMode =
  | 'standard'
  | 'fragmented_thought'
  | 'emphatic_repetition'
  | 'self_correction'
  | 'run_on_sentence'
  | 'short_bursts'
  | 'parenthetical_aside' // Kept only for historical backward compatibility
  | 'double_space_between_words'
  | 'line_breaks'
  | 'rhetorical_question';

export interface NormalizedBrandVariant {
  value: string;
  weightBps: number;
  order: number;
}

export interface BrandVariantInput {
  value: string;
  percentage: number;
}

export interface SlotPlanV2 {
  version: 2;
  slotIndex: number;
  lengthMode: LengthMode;
  emojiPolicy: EmojiPolicy;
  rhetoricalForm: RhetoricalForm;
  texture: Textures;
  voiceFamily: VoiceFamily;
  firstPersonSubfamily: FirstPersonSubfamily | null;
  emotionalTone: EmotionalTone;
  punctuationMode: PunctuationMode;
  capitalizationMode: CapitalizationMode;
  expressionMode: ExpressionMode;
  syntaxMode: SyntaxMode;
  brandVariant: string | null;
  deliveryOrder: number;
  assignedPostId: string;
}

// Ensure old versions can be imported
export function normalizeStoredSlotPlan(raw: unknown): SlotPlanV2 {
  if (!raw || typeof raw !== 'object') {
    throw new Error('Invalid raw SlotPlan');
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const anyRaw = raw as any;

  if (anyRaw.version === 2) {
    return anyRaw as unknown as SlotPlanV2;
  }

  // Convert V1 to V2
  return {
    version: 2,
    slotIndex: typeof anyRaw.slotIndex === 'number' ? anyRaw.slotIndex : 0,
    lengthMode: anyRaw.lengthMode || 'normal',
    emojiPolicy: anyRaw.emojiPolicy || 'no_emoji',
    rhetoricalForm: anyRaw.rhetoricalForm || 'direct_reaction',
    texture: anyRaw.texture || 'plain',
    voiceFamily: 'general',
    firstPersonSubfamily: null,
    emotionalTone: 'neutral',
    punctuationMode: 'standard',
    capitalizationMode: 'standard',
    expressionMode: 'standard',
    syntaxMode: 'standard',
    brandVariant: null,
    deliveryOrder: typeof anyRaw.deliveryOrder === 'number' ? anyRaw.deliveryOrder : 0,
    assignedPostId: anyRaw.assignedPostId || '',
  };
}

/**
 * Largest Remainder Method (Hare-Niemeyer)
 * Transforms proportional weights into exact integer counts summing to `totalAmount`.
 */
export function allocateByLargestRemainder<T extends { weight: number; id: string }>(
  items: T[],
  totalAmount: number
): { id: string; count: number }[] {
  if (items.length === 0) return [];
  if (totalAmount <= 0) return items.map(item => ({ id: item.id, count: 0 }));

  const totalWeight = items.reduce((sum, item) => sum + item.weight, 0);
  if (totalWeight <= 0) {
    // If weights sum to 0, distribute evenly and handle remainders
    const base = Math.floor(totalAmount / items.length);
    const remainder = totalAmount % items.length;
    return items.map((item, idx) => ({
      id: item.id,
      count: base + (idx < remainder ? 1 : 0),
    }));
  }

  let remainingSlots = totalAmount;
  const allocations = items.map(item => {
    const exact = (item.weight / totalWeight) * totalAmount;
    const integerPart = Math.floor(exact);
    const fractionalPart = exact - integerPart;
    remainingSlots -= integerPart;
    return {
      id: item.id,
      count: integerPart,
      fractional: fractionalPart,
    };
  });

  // Sort by largest fractional remainder first
  allocations.sort((a, b) => b.fractional - a.fractional);

  for (let i = 0; i < remainingSlots; i++) {
    allocations[i % allocations.length].count += 1;
  }

  // Restore original order based on items
  const result = items.map(item => {
    const alloc = allocations.find(a => a.id === item.id);
    return { id: item.id, count: alloc ? alloc.count : 0 };
  });

  return result;
}

/**
 * Normalizes brand variant input array from percentages into basis points (bps).
 * Sums to 10,000 bps exactly.
 */
export function normalizeBrandVariants(variants: BrandVariantInput[]): NormalizedBrandVariant[] {
  if (!variants || variants.length === 0) return [];

  const cleanMap = new Map<string, number>();
  for (const v of variants) {
    const cleanValue = v.value.normalize('NFKC').trim();
    if (!cleanValue) continue;
    if (cleanMap.has(cleanValue)) continue;

    const percentage = Number(v.percentage);
    if (Number.isFinite(percentage) && percentage > 0) {
      cleanMap.set(cleanValue, percentage);
    }
  }

  if (cleanMap.size === 0) return [];

  const items = Array.from(cleanMap.entries()).map(([value, percentage], idx) => ({
    id: value,
    weight: percentage,
    originalOrder: idx,
  }));

  const allocated = allocateByLargestRemainder(items, 10000);

  return allocated.map((a, idx) => ({
    value: a.id,
    weightBps: a.count,
    order: idx,
  }));
}

/**
 * Validates compatibility of a set of features for a slot.
 */
export function isValidCombination(
  lengthMode: LengthMode,
  punctuationMode: PunctuationMode,
  syntaxMode: SyntaxMode
): boolean {
  if (punctuationMode === 'no_punctuation' || punctuationMode === 'commas_only') {
    if (syntaxMode === 'rhetorical_question') {
      return false;
    }
  }

  if (lengthMode === 'ultra_short') {
    if (syntaxMode === 'short_bursts' || syntaxMode === 'line_breaks') {
      return false;
    }
  }

  if (syntaxMode === 'rhetorical_question') {
    if (punctuationMode !== 'standard' && punctuationMode !== 'ellipsis_required') {
      return false;
    }
  }

  if (syntaxMode === 'short_bursts' && lengthMode !== 'normal') {
    return false;
  }

  if (syntaxMode === 'line_breaks' && lengthMode !== 'normal') {
    return false;
  }

  return true;
}
