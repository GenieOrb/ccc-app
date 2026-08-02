import 'server-only';
import { createHash } from 'node:crypto';

export class DeterministicPRNG {
  private state: number;

  constructor(seedString: string) {
    const hash = createHash('sha256').update(seedString).digest('hex');
    this.state = parseInt(hash.substring(0, 8), 16);
  }

  next(): number {
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

export type TextQuantity = 'no_text' | 'short_text';
export type VisualStructure = 'single_scene' | 'direct_comparison' | 'simple_split';
export type HumorTone = 'subtle' | 'clearly_humorous' | 'exaggerated' | 'absurd';
export type PostRelationship = 'direct_reaction' | 'contradiction_visual' | 'metaphor' | 'simplified_scenario';
export type SceneComplexity = 'ultra_simple' | 'simple';

export interface MemeSlotPlan {
  plannerVersion: 2;
  seed: string;
  campaignId?: string;
  draftId?: string;
  assignedPostId?: string;
  slotIndex: number;
  
  textQuantity: TextQuantity;
  visualStructure: VisualStructure;
  humorTone: HumorTone;
  postRelationship: PostRelationship;
  sceneComplexity: SceneComplexity;
  
  requiresAsset: boolean;
  assetId?: string;
  deliveryOrder: number;
}

export const TEXT_QUANTITIES: { id: TextQuantity, weight: number }[] = [
  { id: 'no_text', weight: 70 },
  { id: 'short_text', weight: 30 }
];

export const VISUAL_STRUCTURES: { id: VisualStructure, weight: number }[] = [
  { id: 'single_scene', weight: 70 },
  { id: 'direct_comparison', weight: 20 },
  { id: 'simple_split', weight: 10 }
];

export const HUMOR_TONES: { id: HumorTone, weight: number }[] = [
  { id: 'subtle', weight: 20 },
  { id: 'clearly_humorous', weight: 35 },
  { id: 'exaggerated', weight: 30 },
  { id: 'absurd', weight: 15 }
];

export const POST_RELATIONSHIPS: { id: PostRelationship, weight: number }[] = [
  { id: 'direct_reaction', weight: 35 },
  { id: 'contradiction_visual', weight: 30 },
  { id: 'metaphor', weight: 20 },
  { id: 'simplified_scenario', weight: 15 }
];

export const SCENE_COMPLEXITIES: { id: SceneComplexity, weight: number }[] = [
  { id: 'ultra_simple', weight: 65 },
  { id: 'simple', weight: 35 }
];

export const TEXT_STRUCTURE_MATRIX: Record<TextQuantity, Record<VisualStructure, 0 | 1 | 2>> = {
  'no_text': {
    'single_scene': 2,
    'direct_comparison': 1,
    'simple_split': 1
  },
  'short_text': {
    'single_scene': 1,
    'direct_comparison': 2,
    'simple_split': 2
  }
};

export function pickCompatibleStructure(textQuantity: TextQuantity, prng: DeterministicPRNG): VisualStructure {
  const row = TEXT_STRUCTURE_MATRIX[textQuantity];
  const candidates = VISUAL_STRUCTURES.map(f => ({ id: f.id, weight: f.weight * row[f.id] })).filter(c => c.weight > 0);
  if (candidates.length === 0) return VISUAL_STRUCTURES[0].id;
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

  const textAlloc = allocateByLargestRemainder(TEXT_QUANTITIES, totalSlots);
  const toneAlloc = allocateByLargestRemainder(HUMOR_TONES, totalSlots);
  const relationAlloc = allocateByLargestRemainder(POST_RELATIONSHIPS, totalSlots);
  const complexityAlloc = allocateByLargestRemainder(SCENE_COMPLEXITIES, totalSlots);

  let textBag = textAlloc.flatMap(m => Array(m.count).fill(m.id as TextQuantity));
  let toneBag = toneAlloc.flatMap(i => Array(i.count).fill(i.id as HumorTone));
  let relationBag = relationAlloc.flatMap(e => Array(e.count).fill(e.id as PostRelationship));
  let complexityBag = complexityAlloc.flatMap(t => Array(t.count).fill(t.id as SceneComplexity));

  textBag = deterministicShuffle(textBag, prng);
  toneBag = deterministicShuffle(toneBag, prng);
  relationBag = deterministicShuffle(relationBag, prng);
  complexityBag = deterministicShuffle(complexityBag, prng);
  
  const postsBag = campaignPostIds.length > 0 
    ? deterministicShuffle(Array.from({ length: totalSlots }).map((_, i) => campaignPostIds[i % campaignPostIds.length]), prng)
    : Array(totalSlots).fill(undefined);

  const plans: MemeSlotPlan[] = [];
  for (let i = 0; i < totalSlots; i++) {
    const textQuantity = textBag[i];
    const visualStructure = pickCompatibleStructure(textQuantity, prng);
    
    plans.push({
      plannerVersion: 2,
      seed: seedString,
      campaignId: campaignId || undefined,
      draftId: draftId || undefined,
      assignedPostId: postsBag[i],
      slotIndex: i,
      textQuantity,
      visualStructure,
      humorTone: toneBag[i],
      postRelationship: relationBag[i],
      sceneComplexity: complexityBag[i],
      requiresAsset: false,
      deliveryOrder: i
    });
  }

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
