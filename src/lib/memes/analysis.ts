import 'server-only';
import { z } from 'zod';
import { createHash } from 'node:crypto';

import { Type, GoogleGenAI } from '@google/genai';
import { getConfig } from '../config';
import type { TextQuantity } from './planner';
import type { MemeTemplateGuidance } from './templates';

export const MEME_CAPTION_MAX_CHARS = 25;
export const DEFAULT_MEME_ANALYSIS_MODEL = 'gemini-3.1-flash-lite';
export function resolveMemeAnalysisModel(): string { return getConfig().memeAnalysisModel || DEFAULT_MEME_ANALYSIS_MODEL; }
const compactCaption = (value: string) => {
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (normalized.length <= MEME_CAPTION_MAX_CHARS) return normalized;
  const bounded = normalized.slice(0, MEME_CAPTION_MAX_CHARS + 1);
  const lastSpace = bounded.lastIndexOf(' ');
  return (lastSpace > 0 ? bounded.slice(0, lastSpace) : bounded.slice(0, MEME_CAPTION_MAX_CHARS)).trim();
};

export function normalizeMemeCaptions(textQuantity: TextQuantity | undefined, captions: readonly unknown[] | undefined): string[] {
  if (textQuantity === 'no_text') return [];
  const firstCaption = captions?.find((caption): caption is string => typeof caption === 'string' && caption.trim().length > 0);
  if (!firstCaption) return [];
  const fiveWords = firstCaption.replace(/\s+/g, ' ').trim().split(' ').slice(0, 5).join(' ');
  const normalized = compactCaption(fiveWords);
  return normalized ? [normalized] : [];
}

export const MemePreflightAnalysisSchema = z.object({
  template_id: z.string().optional(),
  captions: z.array(z.string().max(200)).default([]),
  immediate_joke: z.string().describe("What is the immediate visual joke that takes 1 second to understand?"),
  single_visual_focus: z.string().describe("What is the SINGLE main visual focus of the image? (e.g. A cat staring at a screen)"),
  familiar_physical_situation: z.string().describe("What familiar, physical, real-world situation represents this? NO abstract concepts, NO diagrams, NO text."),
  post_connection: z.string().min(1).describe("The specific detail from the original post that the visual joke reacts to."),
  requires_asset: z.boolean().describe("Si el concepto requiere un activo de marca específico que se haya proveído."),
  selected_asset_id: z.string().optional().describe("ID del asset seleccionado, si aplica y requires_asset es true."),
  entityEvidence: z.object({
    postJustification: z.string().min(1),
    externalLogoIntent: z.boolean()
  }).optional(),
  canonicalEntities: z.array(z.string().min(1)).max(2).optional()
});

export type MemePreflightAnalysis = z.infer<typeof MemePreflightAnalysisSchema>;

export interface MemeAnalysisInput {
  postText: string;
  postImageUrls?: string[];
  campaignDirection: string;
  availableAssets: { id: string; instruction: string; assetType: string }[];
  brandContext?: string;
  textQuantity?: TextQuantity;
  templates?: { id: string; name: string; layout: string; zones: string[]; guidance?: MemeTemplateGuidance }[];
}

export async function performMemeAnalysis(
  input: MemeAnalysisInput,
  options?: { signal?: AbortSignal; timeoutMs?: number; modelName?: string }
): Promise<MemePreflightAnalysis> {
  const config = getConfig();
  
  if (!config.googleAiApiKey) {
    throw new Error('Google AI API Key no configurada. (provider: google, phase: analysis)');
  }

  const client = new GoogleGenAI({ apiKey: config.googleAiApiKey });
  const modelName = options?.modelName || resolveMemeAnalysisModel();

  const assetsContext = input.availableAssets.length > 0
    ? `\n\nBrand Assets Disponibles:\n${input.availableAssets.map(a => `- [ID: ${a.id}] Tipo: ${a.assetType}. Instrucciones de uso: ${a.instruction}`).join('\n')}`
    : '\n\nNo hay Brand Assets disponibles. Crea un concepto genérico independiente de assets específicos.';

  const systemPrompt = `Actúas como un estratega jefe de marketing viral. 
Tu objetivo es analizar un post de la red social X y la dirección de campaña proporcionada, para conceptualizar un meme viral que maximice el engagement.

Dirección de campaña (contexto interno, NO para incluir textualmente):
${input.campaignDirection}
${input.brandContext ? `\nSelected brand (internal context only):\n${input.brandContext}` : ''}
${input.templates?.length ? `\nUse exactly the supplied template_id and follow its complete semantic guidance: ${input.templates.map((template) => `${template.id} (${template.name}; layout: ${template.layout}; zones: ${template.zones.join(' / ')}; guidance: ${JSON.stringify(template.guidance || {})})`).join(' | ')}. ${input.textQuantity === 'no_text' ? 'Return zero captions because this slot is NO_TEXT.' : `Return zero captions or exactly one caption of at most ${MEME_CAPTION_MAX_CHARS} characters and five natural words.`} Never write sentences, explanations, feature names, instructions, or context. Never use: multi-view, multi-logic, multi-lens, multi-insight, synthesis, combined, vision. Do not invent a template id.` : ''}
${assetsContext}
canonicalEntities may contain at most two exact canonical organization names from the post, only when externalLogoIntent is true. Do not infer aliases, competitors, or entities not explicitly supported by the post.

Debes estructurar tu análisis visual usando el esquema proporcionado. 
Si decides usar un asset, asegúrate de que requires_asset sea true y selected_asset_id coincida exactamente con uno de los IDs provistos.
El meme debe ser extremadamente simple, visual, con una única idea principal y enfocado en la viralidad rápida. No pienses en infografías ni en explicaciones corporativas. El texto debe captar la atención al primer vistazo y nunca superar ${MEME_CAPTION_MAX_CHARS} caracteres por caption.`;

  const userContent = `Post original de X:\n\n${input.postText}\n\nEntity evidence requirements: postJustification must identify the exact post detail that justifies the concept; externalLogoIntent is true only when the selected brand or logo is intended for use.`;

  const responseSchema = {
    type: Type.OBJECT,
    properties: {
      template_id: { type: Type.STRING },
      captions: { type: Type.ARRAY, items: { type: Type.STRING }, maxItems: 1 },
      immediate_joke: { type: Type.STRING },
      single_visual_focus: { type: Type.STRING },
      familiar_physical_situation: { type: Type.STRING },
      post_connection: { type: Type.STRING },
      requires_asset: { type: Type.BOOLEAN },
      selected_asset_id: { type: Type.STRING },
      entityEvidence: {
        type: Type.OBJECT,
        properties: {
          postJustification: { type: Type.STRING },
          externalLogoIntent: { type: Type.BOOLEAN }
        },
        required: ["postJustification", "externalLogoIntent"]
      },
      canonicalEntities: { type: Type.ARRAY, items: { type: Type.STRING }, maxItems: 2 }
    },
    required: [
      "captions", "immediate_joke", "single_visual_focus", "familiar_physical_situation", "post_connection", "requires_asset", "entityEvidence"
    ]
  };

  try {
    const deadline = options?.timeoutMs === undefined
      ? undefined
      : Date.now() + Math.max(0, options.timeoutMs);
    if (options?.signal?.aborted || (deadline !== undefined && Date.now() > deadline)) {
      throw new Error('Analysis aborted before dispatch');
    }

    const controller = new AbortController();
    const abort = () => controller.abort();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    if (options?.signal) options.signal.addEventListener('abort', abort, { once: true });
    if (deadline !== undefined) timeout = setTimeout(abort, Math.max(0, deadline - Date.now()));

    let response;
    try {
      response = await client.models.generateContent({
      model: modelName,
      contents: userContent,
      config: {
        systemInstruction: systemPrompt,
        responseMimeType: 'application/json',
        responseSchema: responseSchema,
        abortSignal: controller.signal
      }
      });
    } finally {
      if (timeout) clearTimeout(timeout);
      if (options?.signal) options.signal.removeEventListener('abort', abort);
    }

    if (!response.text) {
      throw new Error('Empty response from model');
    }

    const parsed = MemePreflightAnalysisSchema.parse(JSON.parse(response.text));
    return { ...parsed, captions: normalizeMemeCaptions(input.textQuantity, parsed.captions) };
  } catch (error: unknown) {
    const err = error as Error & { status?: number };
    let code = 500;
    let type = 'content';
    if (err.status === 403) code = 403;
    if (err.status === 429) code = 429;
    if (code === 403) type = 'acceso denegado';
    else if (code === 429) type = 'rate limit';
    
    throw new Error(`No se pudo analizar el contenido con ${modelName}: ${type}. (phase: analysis, provider: google, status: ${code})`);
  }
}

export function hashMemeInputs(input: MemeAnalysisInput): string {
  const str = JSON.stringify({
    pt: input.postText,
    pi: input.postImageUrls || [],
    cd: input.campaignDirection,
    as: input.availableAssets.map(a => a.id).sort(),
    bc: input.brandContext || ''
  });
  return createHash('sha256').update(str).digest('hex');
}
