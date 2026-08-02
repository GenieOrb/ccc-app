import 'server-only';
import { z } from 'zod';
import { createHash } from 'node:crypto';

import { Type, GoogleGenAI } from '@google/genai';
import { getConfig } from '../config';

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
  input: MemeAnalysisInput
): Promise<MemePreflightAnalysis> {
  const config = getConfig();
  
  if (!config.googleAiApiKey) {
    throw new Error('Google AI API Key no configurada. (provider: google, phase: analysis)');
  }

  const client = new GoogleGenAI({ apiKey: config.googleAiApiKey });
  const modelName = config.memeAnalysisModel || 'gemini-3.1-flash-lite';

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

  const userContent = `Post original de X:\n\n${input.postText}`;

  const responseSchema = {
    type: Type.OBJECT,
    properties: {
      concept: { type: Type.STRING, description: "Idea general del meme y cómo se relaciona con el post original o la campaña." },
      subject_type: { type: Type.STRING, enum: ['brand_product', 'fictional_character', 'abstract_concept', 'text_only', 'reaction_face', 'animal'] },
      visual_style: { type: Type.STRING, enum: ['photorealistic', 'cartoon', 'illustration', '3d_render', 'pixel_art', 'mixed_media', 'lo-fi'] },
      tone: { type: Type.STRING, enum: ['humorous', 'sarcastic', 'wholesome', 'edgy', 'surreal', 'informative', 'ironic'] },
      suggested_text_top: { type: Type.STRING, description: "Texto superior sugerido para el meme (opcional, máximo 5-7 palabras)." },
      suggested_text_bottom: { type: Type.STRING, description: "Texto inferior sugerido (opcional, máximo 5-7 palabras)." },
      requires_asset: { type: Type.BOOLEAN, description: "Si el concepto requiere un activo de marca específico que se haya proveído." },
      selected_asset_id: { type: Type.STRING, description: "ID del asset seleccionado, si aplica y requires_asset es true." }
    },
    required: ["concept", "subject_type", "visual_style", "tone", "requires_asset"]
  };

  try {
    const response = await client.models.generateContent({
      model: modelName,
      contents: userContent,
      config: {
        systemInstruction: systemPrompt,
        responseMimeType: 'application/json',
        responseSchema: responseSchema
      }
    });

    if (!response.text) {
      throw new Error('Empty response from model');
    }

    const parsed = JSON.parse(response.text);
    return MemePreflightAnalysisSchema.parse(parsed);
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
    as: input.availableAssets.map(a => a.id).sort()
  });
  return createHash('sha256').update(str).digest('hex');
}
