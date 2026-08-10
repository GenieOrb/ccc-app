import 'server-only';
import path from 'node:path';
import sharp from 'sharp';

export interface MemeTemplateZone { id: string; x: number; y: number; width: number; height: number; align?: 'start' | 'middle' | 'end'; }
type Provider = 'openai' | 'google';
type TextMode = 'NO_TEXT' | 'ONE_CAPTION';
export interface MemeTemplateGuidance {
  purpose: string;
  mechanism: string;
  panelRoles: string[];
  promotedBrandRole: string;
  inferiorAlternativeRole: string;
  textModes: TextMode[];
  captionPosition: string;
  emotion: string[];
  compatibility: string[];
  useWhen: string[];
  rejectWhen: string[];
  visualInstruction: string;
  avoid: string[];
  validation: string[];
}
export interface MemeTemplate {
  id: string; name: string; version: 1; path: string;
  layout: 'top_bottom' | 'split' | 'multi_panel' | 'dialogue'; zones: MemeTemplateZone[];
  enabled: boolean; providers: Provider[]; guidance: MemeTemplateGuidance;
}

const globalCaption: MemeTemplateZone[] = [{ id: 'global-caption', x: 0.05, y: 0.03, width: 0.9, height: 0.14, align: 'middle' }];
const both: Provider[] = ['openai', 'google'];
const googleOnly: Provider[] = ['google'];

// This is intentionally a data-only visual-contract catalog. Campaigns supply the
// promoted brand, alternative, claim, and optional single caption at runtime.
export const MEME_TEMPLATES: MemeTemplate[] = [
  {
    id: 'switching_preference_3subjects', name: 'Switching preference', version: 1, path: '/meme-templates-v2/001_switching_preference_3subjects.jpg', layout: 'dialogue', zones: globalCaption, enabled: true, providers: googleOnly,
    guidance: { purpose: 'Show a preference changing after a more attractive option appears.', mechanism: 'A user shifts attention from a current option to a newly discovered alternative.', panelRoles: ['chooser', 'current option', 'attractive new option'], promotedBrandRole: "The promoted brand is the newly attractive option receiving the chooser's attention.", inferiorAlternativeRole: 'The inferior alternative is the current option being displaced.', textModes: ['NO_TEXT', 'ONE_CAPTION'], captionPosition: 'A single neutral global caption outside the subjects.', emotion: ['discovery', 'desire', 'temptation'], compatibility: ['switching tools', 'product discovery', 'replacement'], useWhen: ['the chooser, current option, and reason to switch are visually distinguishable'], rejectWhen: ['there is no genuine change of preference', 'three separate labels would be required'], visualInstruction: 'Depict three clear subjects: a chooser visibly turning interest away from the current option toward the promoted alternative, which is integrated as a product, service, interface, or result.', avoid: ['reversed gaze', 'floating logos', 'invented competitors', 'separate subject labels'], validation: ['the attention direction is unambiguous', 'the promoted brand is the new option', 'the scene works without reading the post'] },
  },
  {
    id: 'basic_vs_premium_2panel', name: 'Basic versus premium', version: 1, path: '/meme-templates-v2/002_basic_vs_premium_2panel.jpg', layout: 'top_bottom', zones: globalCaption, enabled: true, providers: googleOnly,
    guidance: { purpose: 'Contrast an ordinary experience with a more desirable, refined version.', mechanism: 'The same category appears first as basic and then as an elevated premium experience.', panelRoles: ['ordinary option', 'premium option'], promotedBrandRole: 'The promoted brand belongs only to the premium experience.', inferiorAlternativeRole: 'The inferior alternative is the ordinary or earlier version of the same category.', textModes: ['NO_TEXT', 'ONE_CAPTION'], captionPosition: 'One global caption or one caption in the premium region.', emotion: ['aspiration', 'status', 'humor'], compatibility: ['basic versus premium', 'standard versus refined', 'upgrade'], useWhen: ['both options are comparable versions of one category'], rejectWhen: ['the brand cannot be exclusively associated with the premium state', 'the distinction needs technical explanation'], visualInstruction: 'Show comparable basic and premium states, with the promoted brand naturally integrated only in the visibly more polished, confident, or desirable state.', avoid: ['comparison tables', 'feature lists', 'repeated logos', 'unsupported claims'], validation: ['the premium state is immediately more desirable', 'the brand is not in the basic state'] },
  },
  {
    id: 'progressive_superiority_4stage', name: 'Progressive superiority', version: 1, path: '/meme-templates-v2/003_progressive_superiority_4stage.jpg', layout: 'multi_panel', zones: globalCaption, enabled: true, providers: both,
    guidance: { purpose: 'Present a clear progression toward a more complete and desirable solution.', mechanism: 'Four escalating stages move from a limited approach to a culminating superior result.', panelRoles: ['limited starting point', 'incremental improvement', 'stronger approach', 'culminating result'], promotedBrandRole: 'The promoted brand occupies the culminating result or is integrated into it.', inferiorAlternativeRole: 'The inferior alternative is represented by the earlier, less complete stages.', textModes: ['NO_TEXT', 'ONE_CAPTION'], captionPosition: 'One global caption outside the stages.', emotion: ['revelation', 'ambition', 'superiority'], compatibility: ['maturity progression', 'expanding capability', 'graduated improvement'], useWhen: ['four distinct escalating states can be shown without labels'], rejectWhen: ['the stages repeat the same idea', 'the progression needs explanatory text'], visualInstruction: 'Compose four visually escalating states that lead coherently to a final integrated promoted solution, making the improvement readable through the imagery alone.', avoid: ['empty stages', 'infographic explanations', 'unrelated steps', 'brand in an early inferior stage'], validation: ['each stage advances the story', 'the final state is visibly the culmination'] },
  },
  {
    id: 'ignore_vs_attention_2panel', name: 'Ignore versus attention', version: 1, path: '/meme-templates-v2/004_ignore_vs_attention_2panel.jpg', layout: 'split', zones: globalCaption, enabled: true, providers: both,
    guidance: { purpose: 'Show that one option is ignored while the promoted option earns immediate attention.', mechanism: 'Parallel reactions contrast indifference with focused interest.', panelRoles: ['ignored alternative', 'attention-winning option'], promotedBrandRole: 'The promoted brand is the option naturally attracting attention.', inferiorAlternativeRole: 'The inferior alternative is the option receiving indifference.', textModes: ['NO_TEXT', 'ONE_CAPTION'], captionPosition: 'A single neutral caption above or below both panels.', emotion: ['recognition', 'desire', 'humor'], compatibility: ['attention shift', 'product appeal', 'preference'], useWhen: ['the difference between indifference and attention can be visualized'], rejectWhen: ['both options receive equal attention', 'the brand cannot be tied to the attention-worthy option'], visualInstruction: 'Create two comparable reactions: one visibly disengaged from the inferior alternative and one clearly engaged with the promoted option, integrated in the object of attention.', avoid: ['two captions', 'ambiguous reactions', 'floating logo treatment'], validation: ['attention is directed only to the promoted option', 'the comparison is legible without labels'] },
  },
  {
    id: 'sudden_exit_better_alternative', name: 'Sudden exit to a better alternative', version: 1, path: '/meme-templates-v2/005_sudden_exit_better_alternative.jpg', layout: 'split', zones: globalCaption, enabled: true, providers: googleOnly,
    guidance: { purpose: 'Show an immediate decision to abandon an inferior path for a better alternative.', mechanism: 'A decisive exit redirects motion from the current route to a clearly better destination.', panelRoles: ['abandoned route', 'decisive departure', 'better destination'], promotedBrandRole: 'The promoted brand is the destination or solution selected by the abrupt exit.', inferiorAlternativeRole: 'The inferior alternative is the route or option being left behind.', textModes: ['NO_TEXT', 'ONE_CAPTION'], captionPosition: 'One global caption in unused space.', emotion: ['decisiveness', 'surprise', 'relief'], compatibility: ['rapid switching', 'better choice', 'leaving a poor process'], useWhen: ['a sharp change in direction is truthful and visually clear'], rejectWhen: ['there is no meaningful alternative', 'the direction of departure is ambiguous'], visualInstruction: 'Show an unmistakable departure away from an inferior route and toward a promoted solution integrated naturally as the desired destination.', avoid: ['reversed direction', 'violence', 'multiple labels', 'invented claims'], validation: ['the promoted brand is the destination', 'the abandoned option is visually clear'] },
  },
  {
    id: 'chaotic_fan_vs_calm_enjoyer', name: 'Chaotic fan versus calm enjoyer', version: 1, path: '/meme-templates-v2/006_chaotic_fan_vs_calm_enjoyer.jpg', layout: 'split', zones: globalCaption, enabled: true, providers: googleOnly,
    guidance: { purpose: 'Contrast frantic overreaction with calm confidence in a better experience.', mechanism: 'Two parallel users react to comparable situations with chaos versus composed enjoyment.', panelRoles: ['chaotic user of inferior option', 'calm user of promoted option'], promotedBrandRole: 'The promoted brand is integrated with the calm, satisfied user.', inferiorAlternativeRole: 'The inferior alternative is associated with the frantic experience.', textModes: ['NO_TEXT', 'ONE_CAPTION'], captionPosition: 'One global caption that does not label both panels.', emotion: ['calm', 'confidence', 'humor'], compatibility: ['user experience', 'simplicity', 'confidence'], useWhen: ['a shared situation can plausibly produce calm versus chaos'], rejectWhen: ['the promoted brand would appear responsible for the chaos', 'the contrast requires factual performance claims'], visualInstruction: 'Show equivalent contexts: the inferior route creates an exaggerated frantic reaction, while the promoted solution is naturally used by a relaxed, secure user.', avoid: ['mocking people', 'medical claims', 'brand in chaotic role', 'two captions'], validation: ['the calm role belongs only to the promoted option', 'the contrast is empathetic and legible'] },
  },
  {
    id: 'refuse_easy_option_accept_burden', name: 'Refuse easy option and accept burden', version: 1, path: '/meme-templates-v2/007_refuse_easy_option_accept_burden.jpg', layout: 'split', zones: globalCaption, enabled: true, providers: googleOnly,
    guidance: { purpose: 'Show the absurdity of rejecting the promoted easy solution so the contrast clearly favors it.', mechanism: 'A person refuses that easy solution while voluntarily accepting a disproportionate burden.', panelRoles: ['promoted easy solution being refused', 'inferior alternative carrying the unnecessary burden'], promotedBrandRole: 'The promoted brand is the naturally integrated easy solution; the comic refusal makes its advantage obvious.', inferiorAlternativeRole: 'The inferior alternative owns the burdensome process voluntarily accepted instead.', textModes: ['NO_TEXT', 'ONE_CAPTION'], captionPosition: 'One global caption only.', emotion: ['absurdity', 'irony', 'frustration'], compatibility: ['automation', 'manual work', 'unnecessary complexity'], useWhen: ['the contrast between easy solution and burden is evident'], rejectWhen: ['the brand does not genuinely simplify the shown task', 'the comparison requires unsupported claims'], visualInstruction: 'Place a clear simple promoted solution beside a visually exaggerated burden that the subject accepts instead, preserving the comic imbalance.', avoid: ['brand as burden', 'two captions', 'floating brand name', 'invented benefits'], validation: ['the easier role belongs to the promoted brand', 'the burden belongs to the inferior alternative', 'the imbalance is obvious without explanation'] },
  },
  {
    id: 'off_vs_on_transformation', name: 'Off versus on transformation', version: 1, path: '/meme-templates-v2/009_off_vs_on_transformation.jpg', layout: 'split', zones: globalCaption, enabled: true, providers: both,
    guidance: { purpose: 'Show the same subject before and after a credible transformation.', mechanism: 'Equivalent panels contrast a limited state with a visibly improved state after applying a solution.', panelRoles: ['before or without solution', 'after or with solution'], promotedBrandRole: 'The promoted brand is the factor naturally integrated in the improved after state.', inferiorAlternativeRole: 'The inferior alternative is the prior state or lower-quality substitute.', textModes: ['NO_TEXT', 'ONE_CAPTION'], captionPosition: 'One global caption; do not label each state separately.', emotion: ['transformation', 'surprise', 'desire'], compatibility: ['before and after', 'optimization', 'improved result'], useWhen: ['the same concept can appear in two causally comparable states'], rejectWhen: ['the panels use different subjects', 'the enhancement would make an unsupported factual claim'], visualInstruction: 'Render the same subject or result in equivalent panels, with a clear visual improvement after the promoted solution is naturally applied.', avoid: ['multiple labels', 'changing the subject', 'false capability claims', 'text-dependent comparison'], validation: ['the panels depict the same concept', 'the promoted solution belongs only to the improved state'] },
  },
  {
    id: 'high_stress_vs_low_stress', name: 'High stress versus low stress', version: 1, path: '/meme-templates-v2/010_high_stress_vs_low_stress.jpg', layout: 'split', zones: globalCaption, enabled: true, providers: both,
    guidance: { purpose: 'Contrast a chaotic experience with a calm, controlled one.', mechanism: 'Parallel states make high friction visibly different from low-friction confidence.', panelRoles: ['high-friction experience', 'calm controlled experience'], promotedBrandRole: 'The promoted brand is integrated only in the calm, controlled experience.', inferiorAlternativeRole: 'The inferior alternative is the high-friction process or tool.', textModes: ['NO_TEXT', 'ONE_CAPTION'], captionPosition: 'One global caption, never separate high and low labels.', emotion: ['relief', 'calm', 'contrast'], compatibility: ['simplification', 'productivity', 'process improvement'], useWhen: ['the difference can be represented as visual stress versus calm without medical claims'], rejectWhen: ['a medical or physiological claim would be implied', 'the brand appears in the stressed state'], visualInstruction: 'Contrast a cluttered, frustrating inferior experience with a calm, clear promoted experience using non-medical visual cues and a naturally integrated solution.', avoid: ['clinical measurements', 'medical claims', 'scientific charts', 'two captions'], validation: ['the image reads as a metaphor for experience', 'the brand is exclusively associated with calm'] },
  },
  {
    id: 'fast_challenger_gaining_ground', name: 'Fast challenger gaining ground', version: 1, path: '/meme-templates-v2/011_fast_challenger_gaining_ground.jpg', layout: 'dialogue', zones: globalCaption, enabled: true, providers: both,
    guidance: { purpose: 'Show a strong challenger rapidly closing the gap to an established leader.', mechanism: 'A fast pursuer advances while the current leader notices the shrinking distance.', panelRoles: ['challenger gaining ground', 'current leader reacting'], promotedBrandRole: 'The promoted brand is the advancing challenger.', inferiorAlternativeRole: 'The inferior alternative is the leader or incumbent being caught.', textModes: ['NO_TEXT', 'ONE_CAPTION'], captionPosition: 'One global caption or a single neutral reaction remate.', emotion: ['ambition', 'momentum', 'competitive humor'], compatibility: ['emerging challenger', 'rapid progress', 'competitive pressure'], useWhen: ['there is a truthful challenger-to-leader narrative'], rejectWhen: ['the brand is already presented as the leader', 'growth metrics would need to be invented', 'the pursuit could portray the brand as losing'], visualInstruction: 'Depict the promoted brand as a powerful, clearly advancing challenger and an incumbent reacting to the rapidly closing distance; integrate identity in the advancing subject.', avoid: ['violence', 'unsupported rankings', 'brand as fleeing subject', 'invented competitors'], validation: ['the promoted brand is unmistakably gaining ground', 'motion and hierarchy are clear'] },
  },
];

export const DEFAULT_MEME_TEMPLATE = MEME_TEMPLATES[0];
export const ACTIVE_MEME_TEMPLATES = MEME_TEMPLATES.filter((template) => template.enabled);
export function getMemeTemplatesForProvider(provider: Provider): MemeTemplate[] { return ACTIVE_MEME_TEMPLATES.filter((template) => template.providers.includes(provider)); }
export function getMemeTemplate(id?: string, version?: number): MemeTemplate { return ACTIVE_MEME_TEMPLATES.find((template) => template.id === id && template.version === version) || DEFAULT_MEME_TEMPLATE; }
export function resolveMemeTemplateSelection(_selectedId: string | undefined, plannedId: string | undefined, plannedVersion: number | undefined): MemeTemplate { return getMemeTemplate(plannedId, plannedVersion); }

const esc = (value: string) => value.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]!));
function fit(text: string, width: number, height: number) { return Math.max(18, Math.min(72, Math.floor(Math.min(width / Math.max(1, text.length * 0.58), height * 0.72)))); }
export async function renderMemeTemplate(templateId: string | undefined, templateVersion: number | undefined, captions: string[] = []): Promise<{ imageBuffer: Buffer; mimeType: string; width: number; height: number }> {
  const template = getMemeTemplate(templateId, templateVersion);
  const source = path.join(process.cwd(), 'public', template.path.replace(/^\//, ''));
  const image = sharp(source); const metadata = await image.metadata(); const width = metadata.width || 1024; const height = metadata.height || 1024;
  const overlays = template.zones.map((zone, index) => {
    const caption = captions[index]?.trim(); if (!caption) return null;
    const w = Math.floor(zone.width * width); const h = Math.floor(zone.height * height); const font = fit(caption, w, h);
    const svg = `<svg width="${w}" height="${h}" xmlns="http://www.w3.org/2000/svg"><style>.t{font-family:Impact,Arial,sans-serif;font-size:${font}px;font-weight:900;fill:white;stroke:black;stroke-width:${Math.max(2, Math.floor(font / 12))}px;paint-order:stroke;text-anchor:middle}</style><text class="t" x="${w / 2}" y="${Math.floor(h * .65)}">${esc(caption.toUpperCase())}</text></svg>`;
    return { input: Buffer.from(svg), left: Math.floor(zone.x * width), top: Math.floor(zone.y * height) };
  }).filter(Boolean) as Array<{ input: Buffer; left: number; top: number }>;
  return { imageBuffer: await image.composite(overlays).png().toBuffer(), mimeType: 'image/png', width, height };
}
