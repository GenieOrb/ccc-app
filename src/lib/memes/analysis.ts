import 'server-only';
import { z } from 'zod';
import { getOpenAIClient, requestOptionsForDeadline } from '../openai';
import { zodResponseFormat } from 'openai/helpers/zod';
import { createHash } from 'node:crypto';
import type { ChatCompletionContentPart } from 'openai/resources/index.mjs';

export const MemePreflightAnalysisSchema = z.object({
  concept: z.string().describe("Idea general del meme y cómo se relaciona con el post original o la campaña."),
  subject_type: z.enum(['brand_product', 'fictional_character', 'abstract_concept', 'text_only', 'reaction_face', 'animal']),
  visual_style: z.enum(['photorealistic', 'cartoon', 'illustration', '3d_render', 'pixel_art', 'mixed_media', 'lo-fi']),
  tone: z.enum(['humorous', 'sarcastic', 'wholesome', 'edgy', 'surreal', 'informative', 'ironic']),
  suggested_text_top: z.string().optional().describe("Texto superior sugerido para el meme (opcional, máximo 5-7 palabras)."),
  suggested_text_bottom: z.string().optional().describe("Texto inferior sugerido (opcional, máximo 5-7 palabras)."),
  requires_asset: z.boolean().describe("Si el concepto requiere un activo de marca específico que se haya proveído."),
  selected_asset_id: z.string().optional().describe("ID del asset seleccionado, si aplica y requires_asset es true."),
});

export type MemePreflightAnalysis = z.infer<typeof MemePreflightAnalysisSchema>;

export interface MemeAnalysisInput {
  postText: string;
  postImageUrls?: string[];
  campaignDirection: string;
  availableAssets: { id: string; instruction: string; assetType: string }[];
}

export async function performMemeAnalysis(
  input: MemeAnalysisInput,
  deadline?: number
): Promise<MemePreflightAnalysis> {
  const client = getOpenAIClient('openai');
  const reqOpts = requestOptionsForDeadline(deadline);

  const assetsContext = input.availableAssets.length > 0
    ? `\n\nBrand Assets Disponibles:\n${input.availableAssets.map(a => `- [ID: ${a.id}] Tipo: ${a.assetType}. Instrucciones de uso: ${a.instruction}`).join('\n')}`
    : '\n\nNo hay Brand Assets disponibles. Crea un concepto genérico independiente de assets específicos.';

  const systemPrompt = `Actúas como un estratega jefe de marketing viral. 
Tu objetivo es analizar un post de la red social X y la dirección de campaña proporcionada, para conceptualizar un meme que maximice el engagement y cumpla con los objetivos de la marca.

Dirección de campaña:
${input.campaignDirection}
${assetsContext}

Debes estructurar tu análisis visual usando el esquema proporcionado. 
Si decides usar un asset, asegúrate de que requires_asset sea true y selected_asset_id coincida exactamente con uno de los IDs provistos.
Sé creativo, irreverente (si el tono lo permite) y preciso en tus instrucciones visuales.`;

  const userContent: ChatCompletionContentPart[] = [
    { type: 'text', text: `Post original de X:\n\n${input.postText}` }
  ];

  if (input.postImageUrls && input.postImageUrls.length > 0) {
    for (const url of input.postImageUrls) {
      userContent.push({
        type: 'image_url',
        image_url: { url, detail: 'low' }
      });
    }
  }

  const completion = await client.beta.chat.completions.parse({
    model: 'gpt-4o-mini',
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userContent }
    ],
    response_format: zodResponseFormat(MemePreflightAnalysisSchema, 'meme_analysis'),
    ...reqOpts
  });

  if (!completion.choices[0].message.parsed) {
    throw new Error('Failed to parse meme preflight analysis');
  }

  return completion.choices[0].message.parsed;
}

export function hashMemeInputs(input: MemeAnalysisInput): string {
  const str = JSON.stringify({
    pt: input.postText,
    pi: input.postImageUrls || [],
    cd: input.campaignDirection,
    as: input.availableAssets.map(a => a.id).sort()
  });
  return createHash('sha256').update(str).digest('hex');
}
