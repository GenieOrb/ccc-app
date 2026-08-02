import 'server-only';
import { createHash } from 'node:crypto';

// 6. PLANNER DETERMINISTA CORRECTO
// No uses Math.random()

export class DeterministicPRNG {
  private state: number;

  constructor(seedString: string) {
    const hash = createHash('sha256').update(seedString).digest('hex');
    this.state = parseInt(hash.substring(0, 8), 16);
  }

  next(): number {
    // Simple LCG
    this.state = (this.state * 1664525 + 1013904223) >>> 0;
    return this.state / 4294967296;
  }
}

export function allocateByLargestRemainder(items: { id: string, weight: number }[], total: number): { id: string, count: number }[] {
  const totalWeight = items.reduce((sum, item) => sum + item.weight, 0);
  if (totalWeight <= 0) return items.map(i => ({ id: i.id, count: 0 }));

  let remaining = total;
  const exact = items.map(item => {
    const share = (item.weight / totalWeight) * total;
    const floor = Math.floor(share);
    remaining -= floor;
    return { id: item.id, count: floor, remainder: share - floor };
  });

  exact.sort((a, b) => b.remainder - a.remainder);
  for (let i = 0; i < remaining; i++) {
    exact[i % exact.length].count += 1;
  }

  return exact.map(e => ({ id: e.id, count: e.count }));
}

export function deterministicShuffle<T>(array: T[], prng: DeterministicPRNG): T[] {
  const result = [...array];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(prng.next() * (i + 1));
    const temp = result[i];
    result[i] = result[j];
    result[j] = temp;
  }
  return result;
}

export type MemeMechanism = 
  | 'expectation_vs_reality' | 'shared_frustration' | 'exaggerated_consequence' 
  | 'absurd_but_logical' | 'visual_metaphor' | 'self_aware_confidence' 
  | 'dry_humor' | 'superiority_comparison' | 'progressive_escalation' | 'literal_interpretation' 
  | 'disproportionate_importance' | 'anticlimax' | 'hyperspecific_identification' | 'personification';

export type MemeFormat = 
  | 'reaction_image' | 'original_single_scene' | 'two_panel_comparison' | 'object_labeling_format' 
  | 'before_and_after' | 'pov' | 'short_conversation' | 'subtitled_cinematic_frame' 
  | 'sign_in_scene' | 'found_photography' | 'three_panel_comic' | 'fictional_app_capture' 
  | 'absurd_chart' | 'starter_pack' | 'tier_list' | 'parody_ad';

export type MemeIntensity = 'subtle' | 'clearly_humorous' | 'exaggerated' | 'completely_absurd';
export type MemeEmotion = 'identification' | 'enthusiasm' | 'satisfaction' | 'superiority' | 'frustration' | 'disbelief' | 'surprise';
export type MemeTone = 'playful' | 'sarcastic' | 'dry' | 'irreverent' | 'acid' | 'triumphant' | 'dark_moderate';

export interface MemeSlotPlan {
  plannerVersion: 1;
  seed: string;
  campaignId?: string;
  draftId?: string;
  assignedPostId?: string;
  slotIndex: number;
  mechanism: MemeMechanism;
  format: MemeFormat;
  intensity: MemeIntensity;
  emotion: MemeEmotion;
  tone: MemeTone;
  requiresAsset: boolean;
  assetId?: string;
  deliveryOrder: number;
}

export const MECHANISMS: { id: MemeMechanism, weight: number }[] = [
  { id: 'hyperspecific_identification', weight: 10 },
  { id: 'expectation_vs_reality', weight: 10 },
  { id: 'exaggerated_consequence', weight: 9 },
  { id: 'shared_frustration', weight: 8 },
  { id: 'absurd_but_logical', weight: 9 },
  { id: 'visual_metaphor', weight: 8 },
  { id: 'self_aware_confidence', weight: 7 },
  { id: 'dry_humor', weight: 7 },
  { id: 'superiority_comparison', weight: 7 },
  { id: 'progressive_escalation', weight: 6 },
  { id: 'literal_interpretation', weight: 5 },
  { id: 'disproportionate_importance', weight: 4 },
  { id: 'anticlimax', weight: 4 },
  { id: 'personification', weight: 6 }
];

export const FORMATS: { id: MemeFormat, weight: number }[] = [
  { id: 'reaction_image', weight: 17 },
  { id: 'original_single_scene', weight: 16 },
  { id: 'two_panel_comparison', weight: 12 },
  { id: 'object_labeling_format', weight: 10 },
  { id: 'before_and_after', weight: 7 },
  { id: 'pov', weight: 7 },
  { id: 'short_conversation', weight: 6 },
  { id: 'subtitled_cinematic_frame', weight: 5 },
  { id: 'sign_in_scene', weight: 4 },
  { id: 'found_photography', weight: 4 },
  { id: 'three_panel_comic', weight: 3 },
  { id: 'fictional_app_capture', weight: 3 },
  { id: 'absurd_chart', weight: 2 },
  { id: 'starter_pack', weight: 2 },
  { id: 'tier_list', weight: 1 },
  { id: 'parody_ad', weight: 1 }
];

export const INTENSITIES: { id: MemeIntensity, weight: number }[] = [
  { id: 'subtle', weight: 15 },
  { id: 'clearly_humorous', weight: 50 },
  { id: 'exaggerated', weight: 25 },
  { id: 'completely_absurd', weight: 10 }
];

export const EMOTIONS: { id: MemeEmotion, weight: number }[] = [
  { id: 'identification', weight: 28 },
  { id: 'enthusiasm', weight: 22 },
  { id: 'satisfaction', weight: 16 },
  { id: 'superiority', weight: 12 },
  { id: 'frustration', weight: 10 },
  { id: 'disbelief', weight: 7 },
  { id: 'surprise', weight: 5 }
];

export const TONES: { id: MemeTone, weight: number }[] = [
  { id: 'playful', weight: 24 },
  { id: 'sarcastic', weight: 18 },
  { id: 'dry', weight: 16 },
  { id: 'irreverent', weight: 14 },
  { id: 'acid', weight: 10 },
  { id: 'triumphant', weight: 10 },
  { id: 'dark_moderate', weight: 8 }
];

export const MECHANISM_FORMAT_MATRIX: Record<MemeMechanism, Record<MemeFormat, 0 | 1 | 2>> = {
  'expectation_vs_reality': {
    'reaction_image': 1, 'original_single_scene': 0, 'two_panel_comparison': 2, 'object_labeling_format': 0,
    'before_and_after': 2, 'pov': 1, 'short_conversation': 1, 'subtitled_cinematic_frame': 1,
    'sign_in_scene': 0, 'found_photography': 1, 'three_panel_comic': 2, 'fictional_app_capture': 1,
    'absurd_chart': 1, 'starter_pack': 0, 'tier_list': 0, 'parody_ad': 0
  },
  'shared_frustration': {
    'reaction_image': 2, 'original_single_scene': 1, 'two_panel_comparison': 1, 'object_labeling_format': 1,
    'before_and_after': 1, 'pov': 2, 'short_conversation': 2, 'subtitled_cinematic_frame': 1,
    'sign_in_scene': 0, 'found_photography': 1, 'three_panel_comic': 1, 'fictional_app_capture': 1,
    'absurd_chart': 0, 'starter_pack': 1, 'tier_list': 1, 'parody_ad': 0
  },
  'exaggerated_consequence': {
    'reaction_image': 1, 'original_single_scene': 2, 'two_panel_comparison': 1, 'object_labeling_format': 1,
    'before_and_after': 1, 'pov': 1, 'short_conversation': 1, 'subtitled_cinematic_frame': 2,
    'sign_in_scene': 0, 'found_photography': 1, 'three_panel_comic': 2, 'fictional_app_capture': 0,
    'absurd_chart': 1, 'starter_pack': 0, 'tier_list': 0, 'parody_ad': 1
  },
  'absurd_but_logical': {
    'reaction_image': 1, 'original_single_scene': 1, 'two_panel_comparison': 1, 'object_labeling_format': 2,
    'before_and_after': 0, 'pov': 1, 'short_conversation': 2, 'subtitled_cinematic_frame': 1,
    'sign_in_scene': 1, 'found_photography': 1, 'three_panel_comic': 1, 'fictional_app_capture': 0,
    'absurd_chart': 2, 'starter_pack': 0, 'tier_list': 1, 'parody_ad': 0
  },
  'visual_metaphor': {
    'reaction_image': 0, 'original_single_scene': 2, 'two_panel_comparison': 1, 'object_labeling_format': 2,
    'before_and_after': 0, 'pov': 0, 'short_conversation': 0, 'subtitled_cinematic_frame': 1,
    'sign_in_scene': 2, 'found_photography': 2, 'three_panel_comic': 1, 'fictional_app_capture': 0,
    'absurd_chart': 1, 'starter_pack': 0, 'tier_list': 0, 'parody_ad': 1
  },
  'self_aware_confidence': {
    'reaction_image': 2, 'original_single_scene': 1, 'two_panel_comparison': 1, 'object_labeling_format': 1,
    'before_and_after': 1, 'pov': 2, 'short_conversation': 1, 'subtitled_cinematic_frame': 2,
    'sign_in_scene': 0, 'found_photography': 1, 'three_panel_comic': 1, 'fictional_app_capture': 0,
    'absurd_chart': 0, 'starter_pack': 1, 'tier_list': 1, 'parody_ad': 0
  },
  'dry_humor': {
    'reaction_image': 1, 'original_single_scene': 2, 'two_panel_comparison': 0, 'object_labeling_format': 1,
    'before_and_after': 0, 'pov': 1, 'short_conversation': 2, 'subtitled_cinematic_frame': 2,
    'sign_in_scene': 2, 'found_photography': 1, 'three_panel_comic': 1, 'fictional_app_capture': 1,
    'absurd_chart': 1, 'starter_pack': 0, 'tier_list': 0, 'parody_ad': 1
  },
  'superiority_comparison': {
    'reaction_image': 1, 'original_single_scene': 0, 'two_panel_comparison': 2, 'object_labeling_format': 1,
    'before_and_after': 1, 'pov': 0, 'short_conversation': 1, 'subtitled_cinematic_frame': 1,
    'sign_in_scene': 0, 'found_photography': 0, 'three_panel_comic': 1, 'fictional_app_capture': 0,
    'absurd_chart': 0, 'starter_pack': 1, 'tier_list': 2, 'parody_ad': 0
  },
  'progressive_escalation': {
    'reaction_image': 0, 'original_single_scene': 0, 'two_panel_comparison': 1, 'object_labeling_format': 1,
    'before_and_after': 1, 'pov': 0, 'short_conversation': 1, 'subtitled_cinematic_frame': 1,
    'sign_in_scene': 0, 'found_photography': 0, 'three_panel_comic': 2, 'fictional_app_capture': 0,
    'absurd_chart': 1, 'starter_pack': 0, 'tier_list': 0, 'parody_ad': 0
  },
  'literal_interpretation': {
    'reaction_image': 1, 'original_single_scene': 2, 'two_panel_comparison': 0, 'object_labeling_format': 2,
    'before_and_after': 0, 'pov': 1, 'short_conversation': 1, 'subtitled_cinematic_frame': 1,
    'sign_in_scene': 2, 'found_photography': 2, 'three_panel_comic': 1, 'fictional_app_capture': 0,
    'absurd_chart': 0, 'starter_pack': 0, 'tier_list': 0, 'parody_ad': 1
  },
  'disproportionate_importance': {
    'reaction_image': 2, 'original_single_scene': 1, 'two_panel_comparison': 1, 'object_labeling_format': 1,
    'before_and_after': 0, 'pov': 2, 'short_conversation': 1, 'subtitled_cinematic_frame': 1,
    'sign_in_scene': 0, 'found_photography': 1, 'three_panel_comic': 1, 'fictional_app_capture': 1,
    'absurd_chart': 2, 'starter_pack': 0, 'tier_list': 0, 'parody_ad': 0
  },
  'anticlimax': {
    'reaction_image': 1, 'original_single_scene': 2, 'two_panel_comparison': 1, 'object_labeling_format': 0,
    'before_and_after': 1, 'pov': 1, 'short_conversation': 2, 'subtitled_cinematic_frame': 1,
    'sign_in_scene': 1, 'found_photography': 1, 'three_panel_comic': 2, 'fictional_app_capture': 1,
    'absurd_chart': 0, 'starter_pack': 0, 'tier_list': 0, 'parody_ad': 1
  },
  'hyperspecific_identification': {
    'reaction_image': 1, 'original_single_scene': 1, 'two_panel_comparison': 0, 'object_labeling_format': 1,
    'before_and_after': 0, 'pov': 2, 'short_conversation': 1, 'subtitled_cinematic_frame': 1,
    'sign_in_scene': 0, 'found_photography': 2, 'three_panel_comic': 1, 'fictional_app_capture': 2,
    'absurd_chart': 0, 'starter_pack': 2, 'tier_list': 1, 'parody_ad': 0
  },
  'personification': {
    'reaction_image': 1, 'original_single_scene': 2, 'two_panel_comparison': 1, 'object_labeling_format': 2,
    'before_and_after': 0, 'pov': 1, 'short_conversation': 2, 'subtitled_cinematic_frame': 1,
    'sign_in_scene': 1, 'found_photography': 1, 'three_panel_comic': 1, 'fictional_app_capture': 0,
    'absurd_chart': 0, 'starter_pack': 0, 'tier_list': 0, 'parody_ad': 1
  }
};

export function pickCompatibleFormat(mechId: MemeMechanism, prng: DeterministicPRNG): MemeFormat {
  const row = MECHANISM_FORMAT_MATRIX[mechId];
  const candidates = FORMATS.map(f => ({ id: f.id, weight: f.weight * row[f.id] })).filter(c => c.weight > 0);
  if (candidates.length === 0) return FORMATS[0].id; // Fallback
  const total = candidates.reduce((s, c) => s + c.weight, 0);
  let roll = prng.next() * total;
  for (const c of candidates) {
    roll -= c.weight;
    if (roll <= 0) return c.id;
  }
  return candidates[0].id;
}

export function generateDeterministicMemeSlotPlans(
  campaignId: string | null,
  draftId: string | null,
  campaignPostIds: string[],
  totalSlots: number,
  availableAssets: { id: string, appearancePercentage: number }[]
): MemeSlotPlan[] {
  const seedString = `${campaignId || 'none'}-${draftId || 'none'}-${campaignPostIds.join('-')}-${totalSlots}`;
  const prng = new DeterministicPRNG(seedString);

  // Generate distributions independently for the dimensions that don't depend on matrix
  const mechsAlloc = allocateByLargestRemainder(MECHANISMS, totalSlots);
  const intensitiesAlloc = allocateByLargestRemainder(INTENSITIES, totalSlots);
  const emotionsAlloc = allocateByLargestRemainder(EMOTIONS, totalSlots);
  const tonesAlloc = allocateByLargestRemainder(TONES, totalSlots);

  let mechsBag = mechsAlloc.flatMap(m => Array(m.count).fill(m.id as MemeMechanism));
  let intensitiesBag = intensitiesAlloc.flatMap(i => Array(i.count).fill(i.id as MemeIntensity));
  let emotionsBag = emotionsAlloc.flatMap(e => Array(e.count).fill(e.id as MemeEmotion));
  let tonesBag = tonesAlloc.flatMap(t => Array(t.count).fill(t.id as MemeTone));

  mechsBag = deterministicShuffle(mechsBag, prng);
  intensitiesBag = deterministicShuffle(intensitiesBag, prng);
  emotionsBag = deterministicShuffle(emotionsBag, prng);
  tonesBag = deterministicShuffle(tonesBag, prng);
  
  const postsBag = campaignPostIds.length > 0 
    ? deterministicShuffle(Array.from({ length: totalSlots }).map((_, i) => campaignPostIds[i % campaignPostIds.length]), prng)
    : Array(totalSlots).fill(undefined);

  const plans: MemeSlotPlan[] = [];
  for (let i = 0; i < totalSlots; i++) {
    const mechanism = mechsBag[i];
    // La selección del formato debe ocurrir después del mecanismo
    const format = pickCompatibleFormat(mechanism, prng);
    
    // Allocate assets deterministic using largest remainder across slots
    // To ensure exact percentages, we should allocate assets globally, but since we are iterating
    // we can use a pre-allocated bag of assets.
    // Wait, the prompt says "Suma de porcentajes activa máximo 100. Resto hasta 100 significa meme sin asset."
    // Let's create an asset bag.
    
    plans.push({
      plannerVersion: 1,
      seed: seedString,
      campaignId: campaignId || undefined,
      draftId: draftId || undefined,
      assignedPostId: postsBag[i],
      slotIndex: i,
      mechanism,
      format,
      intensity: intensitiesBag[i],
      emotion: emotionsBag[i],
      tone: tonesBag[i],
      requiresAsset: false,
      deliveryOrder: i
    });
  }

  // Determine assets
  const assetWeights = availableAssets.map(a => ({ id: a.id, weight: a.appearancePercentage }));
  const totalAssetPercentage = assetWeights.reduce((s, a) => s + a.weight, 0);
  if (totalAssetPercentage < 100) {
    assetWeights.push({ id: 'NONE', weight: 100 - totalAssetPercentage });
  }

  const assetAlloc = allocateByLargestRemainder(assetWeights, totalSlots);
  let assetsBag = assetAlloc.flatMap(a => Array(a.count).fill(a.id));
  assetsBag = deterministicShuffle(assetsBag, prng);

  for (let i = 0; i < totalSlots; i++) {
    const assetId = assetsBag[i];
    if (assetId && assetId !== 'NONE') {
      plans[i].requiresAsset = true;
      plans[i].assetId = assetId;
    }
  }

  return plans;
}
