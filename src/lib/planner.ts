import 'server-only';
import { randomBytes } from 'node:crypto';
import {
  BrandVariantInput,
  CapitalizationMode,
  EmotionalTone,
  ExpressionMode,
  FirstPersonSubfamily,
  PunctuationMode,
  SlotPlanV2,
  SyntaxMode,
  VoiceFamily,
  allocateByLargestRemainder,
  isValidCombination,
  normalizeBrandVariants,
} from './brand-variants';

export type LengthMode = 'ultra_short' | 'normal';
export type EmojiPolicy = 'one_emoji' | 'no_emoji';

export type RhetoricalForm =
  | 'direct_reaction'
  | 'specific_observation'
  | 'concrete_consequence'
  | 'contrast_or_tension'
  | 'genuine_question'
  | 'clear_position'
  | 'call_to_action'
  | 'practical_angle'
  | 'community_angle'
  | 'future_implication';

export type Textures = 'plain' | 'warm' | 'firm' | 'energetic' | 'reflective';

export const ALLOWED_EMOJIS = [
  '🤔', '👀', '😅', '😂', '🙃', '😬', '🙂', '👏', '😄', '😮',
  '🫠', '😭', '🤷', '😆', '🤣', '😊', '😌', '😏', '😐', '😑',
  '😶', '🤨', '😳', '😯', '😱', '😤', '😔', '😕', '😵‍💫', '🤯',
  '🥲', '🫡', '💀',
];

function cryptoShuffle<T>(array: T[]): T[] {
  const result = [...array];
  for (let i = result.length - 1; i > 0; i--) {
    const randomBuffer = randomBytes(4);
    const randomInt = randomBuffer.readUInt32BE(0);
    const j = randomInt % (i + 1);
    const temp = result[i];
    result[i] = result[j];
    result[j] = temp;
  }
  return result;
}

export function generateDeterministicSlotPlans(
  campaignPostIds: string[],
  totalSlots: number = 50,
  brandVariantsRaw: BrandVariantInput[] = []
): SlotPlanV2[] {
  if (!campaignPostIds || campaignPostIds.length === 0) {
    throw new Error('At least one campaign post ID is required for slot planning.');
  }

  // 1. Length & Emoji Policy
  const lengthEmojiPairs: Array<{ lengthMode: LengthMode; emojiPolicy: EmojiPolicy }> = [];
  const emojiCount = Math.max(0, Math.round(totalSlots * 0.12));
  const normalCount = Math.max(1, Math.round(totalSlots * 0.30));
  for (let i = 0; i < emojiCount; i++) {
    lengthEmojiPairs.push({ lengthMode: 'ultra_short', emojiPolicy: 'one_emoji' });
  }
  for (let i = emojiCount; i < totalSlots - normalCount; i++) {
    lengthEmojiPairs.push({ lengthMode: 'ultra_short', emojiPolicy: 'no_emoji' });
  }
  for (let i = 0; i < normalCount; i++) {
    lengthEmojiPairs.push({ lengthMode: 'normal', emojiPolicy: 'no_emoji' });
  }

  // 2. Voice Family & Subfamily
  const voiceFamilyAlloc = allocateByLargestRemainder([
    { id: 'general', weight: 80 },
    { id: 'first_person', weight: 20 },
  ], totalSlots);
  const voiceFamilyBag: VoiceFamily[] = [];
  for (const alloc of voiceFamilyAlloc) {
    for (let i = 0; i < alloc.count; i++) voiceFamilyBag.push(alloc.id as VoiceFamily);
  }

  const subfamilies: FirstPersonSubfamily[] = [
    'personal_experience',
    'future_intention',
    'personal_lesson',
    'personal_preference',
    'lived_difficulty',
    'changed_mind',
  ];
  const firstPersonCount = voiceFamilyBag.filter(v => v === 'first_person').length;
  const subfamilyAlloc = allocateByLargestRemainder(
    subfamilies.map(sf => ({ id: sf, weight: 100 / subfamilies.length })),
    firstPersonCount
  );
  const subfamilyBag: FirstPersonSubfamily[] = [];
  for (const alloc of subfamilyAlloc) {
    for (let i = 0; i < alloc.count; i++) subfamilyBag.push(alloc.id as FirstPersonSubfamily);
  }
  const shuffledSubfamily = cryptoShuffle(subfamilyBag);

  // 3. Emotional Tone
  const emotionalToneAlloc = allocateByLargestRemainder([
    { id: 'neutral', weight: 30 },
    { id: 'histrionic_humor', weight: 10 },
    { id: 'blunt_irreverent', weight: 10 },
    { id: 'surprised', weight: 10 },
    { id: 'skeptical', weight: 10 },
    { id: 'enthusiastic', weight: 10 },
    { id: 'frustrated', weight: 5 },
    { id: 'nostalgic', weight: 5 },
    { id: 'challenging', weight: 5 },
    { id: 'calm_reflective', weight: 5 },
  ], totalSlots);
  const emotionalToneBag: EmotionalTone[] = [];
  for (const alloc of emotionalToneAlloc) {
    for (let i = 0; i < alloc.count; i++) emotionalToneBag.push(alloc.id as EmotionalTone);
  }

  // 4. Punctuation Mode
  const punctuationAlloc = allocateByLargestRemainder([
    { id: 'standard', weight: 50 },
    { id: 'no_punctuation', weight: 20 },
    { id: 'commas_only', weight: 15 },
    { id: 'ellipsis_required', weight: 15 },
  ], totalSlots);
  const punctuationBag: PunctuationMode[] = [];
  for (const alloc of punctuationAlloc) {
    for (let i = 0; i < alloc.count; i++) punctuationBag.push(alloc.id as PunctuationMode);
  }

  // 5. Capitalization Mode
  const capitalizationAlloc = allocateByLargestRemainder([
    { id: 'standard', weight: 75 },
    { id: 'lowercase_only', weight: 25 },
  ], totalSlots);
  const capitalizationBag: CapitalizationMode[] = [];
  for (const alloc of capitalizationAlloc) {
    for (let i = 0; i < alloc.count; i++) capitalizationBag.push(alloc.id as CapitalizationMode);
  }

  // 6. Expression Mode
  const expressionAlloc = allocateByLargestRemainder([
    { id: 'standard', weight: 80 },
    { id: 'spontaneous_vocal_reaction', weight: 20 },
  ], totalSlots);
  const expressionBag: ExpressionMode[] = [];
  for (const alloc of expressionAlloc) {
    for (let i = 0; i < alloc.count; i++) expressionBag.push(alloc.id as ExpressionMode);
  }

  // 7. Syntax Mode
  const syntaxAlloc = allocateByLargestRemainder([
    { id: 'standard', weight: 20 },
    { id: 'fragmented_thought', weight: 10 },
    { id: 'emphatic_repetition', weight: 10 },
    { id: 'self_correction', weight: 10 },
    { id: 'run_on_sentence', weight: 10 },
    { id: 'short_bursts', weight: 10 },
    { id: 'parenthetical_aside', weight: 10 },
    { id: 'line_breaks', weight: 10 },
    { id: 'rhetorical_question', weight: 10 },
  ], totalSlots);
  const syntaxBag: SyntaxMode[] = [];
  for (const alloc of syntaxAlloc) {
    for (let i = 0; i < alloc.count; i++) syntaxBag.push(alloc.id as SyntaxMode);
  }

  // 8. Brand Variants
  const normalizedBrands = normalizeBrandVariants(brandVariantsRaw);
  let brandVariantBag: (string | null)[] = new Array(totalSlots).fill(null);
  if (normalizedBrands.length > 0) {
    const brandAlloc = allocateByLargestRemainder(
      normalizedBrands.map(b => ({ id: b.value, weight: b.weightBps })),
      totalSlots
    );
    brandVariantBag = [];
    for (const alloc of brandAlloc) {
      for (let i = 0; i < alloc.count; i++) brandVariantBag.push(alloc.id);
    }
  }

  // Existing Dimensions (Forms, Textures, etc.)
  const formsList: RhetoricalForm[] = [
    'direct_reaction', 'specific_observation', 'concrete_consequence',
    'contrast_or_tension', 'genuine_question', 'clear_position',
    'call_to_action', 'practical_angle', 'community_angle', 'future_implication',
  ];
  const formsAlloc = allocateByLargestRemainder(
    formsList.map(f => ({ id: f, weight: 10 })),
    totalSlots
  );
  const formsBag: RhetoricalForm[] = [];
  for (const alloc of formsAlloc) {
    for (let i = 0; i < alloc.count; i++) formsBag.push(alloc.id as RhetoricalForm);
  }

  const texturesList: Textures[] = ['plain', 'warm', 'firm', 'energetic', 'reflective'];
  const texturesAlloc = allocateByLargestRemainder(
    texturesList.map(t => ({ id: t, weight: 20 })),
    totalSlots
  );
  const texturesBag: Textures[] = [];
  for (const alloc of texturesAlloc) {
    for (let i = 0; i < alloc.count; i++) texturesBag.push(alloc.id as Textures);
  }

  // Shuffle everything
  const shuffledPairs = cryptoShuffle(lengthEmojiPairs);
  const shuffledVoice = cryptoShuffle(voiceFamilyBag);
  const shuffledEmotion = cryptoShuffle(emotionalToneBag);
  const shuffledPunct = cryptoShuffle(punctuationBag);
  const shuffledCap = cryptoShuffle(capitalizationBag);
  const shuffledExpr = cryptoShuffle(expressionBag);
  const shuffledSyntax = cryptoShuffle(syntaxBag);
  const shuffledBrands = cryptoShuffle(brandVariantBag);
  const shuffledForms = cryptoShuffle(formsBag);
  const shuffledTextures = cryptoShuffle(texturesBag);

  // Resolution Algorithm for Incompatibilities
  // We need to ensure that isValidCombination(shuffledPairs[i].lengthMode, shuffledPunct[i], shuffledSyntax[i]) is true for all i.
  let unresolved = true;
  let attempts = 0;
  const maxAttempts = totalSlots * 10; // Reasonable upper bound to avoid infinite loop

  while (unresolved && attempts < maxAttempts) {
    unresolved = false;
    for (let i = 0; i < totalSlots; i++) {
      if (!isValidCombination(shuffledPairs[i].lengthMode, shuffledPunct[i], shuffledSyntax[i])) {
        unresolved = true;
        // Try to swap syntaxMode first with another valid syntax mode
        let swapped = false;
        for (let j = 0; j < totalSlots; j++) {
          if (i !== j) {
            // If swapping syntax modes makes BOTH i and j valid
            if (
              isValidCombination(shuffledPairs[i].lengthMode, shuffledPunct[i], shuffledSyntax[j]) &&
              isValidCombination(shuffledPairs[j].lengthMode, shuffledPunct[j], shuffledSyntax[i])
            ) {
              const temp = shuffledSyntax[i];
              shuffledSyntax[i] = shuffledSyntax[j];
              shuffledSyntax[j] = temp;
              swapped = true;
              break;
            }
          }
        }

        // If syntax swap didn't work, try swapping punctuationMode
        if (!swapped) {
          for (let j = 0; j < totalSlots; j++) {
            if (i !== j) {
              if (
                isValidCombination(shuffledPairs[i].lengthMode, shuffledPunct[j], shuffledSyntax[i]) &&
                isValidCombination(shuffledPairs[j].lengthMode, shuffledPunct[i], shuffledSyntax[j])
              ) {
                const temp = shuffledPunct[i];
                shuffledPunct[i] = shuffledPunct[j];
                shuffledPunct[j] = temp;
                swapped = true;
                break;
              }
            }
          }
        }
      }
    }
    attempts++;
  }

  if (unresolved) {
    // If we couldn't resolve perfectly (should be extremely rare with our weights),
    // fallback to making invalid slots safe (modifying counts slightly but preventing crash).
    for (let i = 0; i < totalSlots; i++) {
       if (!isValidCombination(shuffledPairs[i].lengthMode, shuffledPunct[i], shuffledSyntax[i])) {
         shuffledSyntax[i] = 'standard';
         shuffledPunct[i] = 'standard';
       }
    }
  }

  // Posts distribution
  const numPosts = campaignPostIds.length;
  const baseCount = Math.floor(totalSlots / numPosts);
  const remainder = totalSlots % numPosts;
  const postCounts = new Array<number>(numPosts).fill(baseCount);
  const postIndices = Array.from({ length: numPosts }, (_, idx) => idx);
  const shuffledPostIndices = cryptoShuffle(postIndices);
  for (let i = 0; i < remainder; i++) {
    postCounts[shuffledPostIndices[i]] += 1;
  }
  let assignedPosts: string[] = [];
  for (let i = 0; i < numPosts; i++) {
    const postId = campaignPostIds[i];
    const count = postCounts[i];
    for (let c = 0; c < count; c++) assignedPosts.push(postId);
  }
  assignedPosts = cryptoShuffle(assignedPosts);

  // Delivery order
  const deliveryOrders = cryptoShuffle(Array.from({ length: totalSlots }, (_, i) => i));

  // Combine
  const slotPlans: SlotPlanV2[] = [];
  let sfIndex = 0;
  for (let idx = 0; idx < totalSlots; idx++) {
    const isFirstPerson = shuffledVoice[idx] === 'first_person';
    const subfamily = isFirstPerson ? shuffledSubfamily[sfIndex++] : null;

    slotPlans.push({
      version: 2,
      slotIndex: idx,
      lengthMode: shuffledPairs[idx].lengthMode,
      emojiPolicy: shuffledPairs[idx].emojiPolicy,
      rhetoricalForm: shuffledForms[idx],
      texture: shuffledTextures[idx],
      voiceFamily: shuffledVoice[idx],
      firstPersonSubfamily: subfamily,
      emotionalTone: shuffledEmotion[idx],
      punctuationMode: shuffledPunct[idx],
      capitalizationMode: shuffledCap[idx],
      expressionMode: shuffledExpr[idx],
      syntaxMode: shuffledSyntax[idx],
      brandVariant: shuffledBrands[idx],
      deliveryOrder: deliveryOrders[idx],
      assignedPostId: assignedPosts[idx],
    });
  }

  return slotPlans;
}
