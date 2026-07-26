import 'server-only';
import { randomBytes } from 'node:crypto';

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

export interface SlotPlan {
  slotIndex: number;
  lengthMode: LengthMode;
  emojiPolicy: EmojiPolicy;
  rhetoricalForm: RhetoricalForm;
  texture: Textures;
  deliveryOrder: number;
  assignedPostId: string; // Campaign post UUID
}

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
  totalSlots: number = 50
): SlotPlan[] {
  if (!campaignPostIds || campaignPostIds.length === 0) {
    throw new Error('At least one campaign post ID is required for slot planning.');
  }

  // Build an arbitrarily sized, balanced plan. The former fixed 50-entry
  // bags made previews and five-comment batches index undefined entries.
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

  // 2. Build rhetorical forms distribution (10 forms x 5 slots = 50)
  const formsList: RhetoricalForm[] = [
    'direct_reaction',
    'specific_observation',
    'concrete_consequence',
    'contrast_or_tension',
    'genuine_question',
    'clear_position',
    'call_to_action',
    'practical_angle',
    'community_angle',
    'future_implication',
  ];
  const formsBag: RhetoricalForm[] = [];
  for (let i = 0; i < totalSlots; i++) formsBag.push(formsList[i % formsList.length]);

  // 3. Build textures distribution (5 textures x 10 slots = 50)
  const texturesList: Textures[] = ['plain', 'warm', 'firm', 'energetic', 'reflective'];
  const texturesBag: Textures[] = [];
  for (let i = 0; i < totalSlots; i++) texturesBag.push(texturesList[i % texturesList.length]);

  // 4. Shuffle each dimension independently with crypto
  const shuffledPairs = cryptoShuffle(lengthEmojiPairs);
  const shuffledForms = cryptoShuffle(formsBag);
  const shuffledTextures = cryptoShuffle(texturesBag);

  // 5. Distribute post assignments balanced across posts
  // E.g., 3 posts => base = 16, remainder = 2 => [17, 17, 16]
  const numPosts = campaignPostIds.length;
  const baseCount = Math.floor(totalSlots / numPosts);
  const remainder = totalSlots % numPosts;

  const postCounts = new Array<number>(numPosts).fill(baseCount);
  // Pick remainder posts randomly
  const postIndices = Array.from({ length: numPosts }, (_, idx) => idx);
  const shuffledPostIndices = cryptoShuffle(postIndices);
  for (let i = 0; i < remainder; i++) {
    postCounts[shuffledPostIndices[i]] += 1;
  }

  // Expand assigned posts list
  let assignedPosts: string[] = [];
  for (let i = 0; i < numPosts; i++) {
    const postId = campaignPostIds[i];
    const count = postCounts[i];
    for (let c = 0; c < count; c++) {
      assignedPosts.push(postId);
    }
  }
  assignedPosts = cryptoShuffle(assignedPosts);

  // 6. Delivery order shuffling (0 to 49)
  const deliveryOrders = cryptoShuffle(Array.from({ length: totalSlots }, (_, i) => i));

  // 7. Combine into 50 immutable slot plans
  const slotPlans: SlotPlan[] = [];
  for (let idx = 0; idx < totalSlots; idx++) {
    slotPlans.push({
      slotIndex: idx,
      lengthMode: shuffledPairs[idx].lengthMode,
      emojiPolicy: shuffledPairs[idx].emojiPolicy,
      rhetoricalForm: shuffledForms[idx],
      texture: shuffledTextures[idx],
      deliveryOrder: deliveryOrders[idx],
      assignedPostId: assignedPosts[idx],
    });
  }

  return slotPlans;
}
