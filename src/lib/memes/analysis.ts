import 'server-only';
import { z } from 'zod';
import { createHash } from 'node:crypto';

import { Type, GoogleGenAI } from '@google/genai';
import { getConfig } from '../config';

export const MemePreflightAnalysisSchema = z.object({
  a_quien_va_dirigido: z.string().describe("Target audience of the meme."),
  conflicto_o_contradiccion: z.string().describe("The conflict or contradiction that makes it funny."),
  escena_representada: z.string().describe("The visual scene to be represented."),
  como_se_relaciona_la_imagen_con_el_post_y_la_direccion: z.string().describe("How the scene relates to the original post and campaign direction."),
  nucleo_del_chiste: z.string().describe("The core of the visual joke."),
  disparador_emocional: z.string().describe("The emotional trigger of the meme."),
  arquetipo_de_meme_mas_adecuado: z.string().describe("The most suitable meme archetype."),
  que_elemento_visual_debe_ser_el_foco_principal: z.string().describe("The main visual focus element."),
  riesgos_de_sobrecarga_o_de_que_el_meme_necesite_demasiada_explicacion: z.string().describe("Risks of visual clutter or requiring too much explanation."),
  requires_asset: z.boolean().describe("Si el concepto requiere un activo de marca específico que se haya proveído."),
  selected_asset_id: z.string().optional().describe("ID del asset seleccionado, si aplica y requires_asset es true.")
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
Tu objetivo es analizar un post de la red social X y la dirección de campaña proporcionada, para conceptualizar un meme viral que maximice el engagement.

Dirección de campaña (contexto interno, NO para incluir textualmente):
${input.campaignDirection}
${assetsContext}

Debes estructurar tu análisis visual usando el esquema proporcionado. 
Si decides usar un asset, asegúrate de que requires_asset sea true y selected_asset_id coincida exactamente con uno de los IDs provistos.
El meme debe ser extremadamente simple, visual, con una única idea principal y enfocado en la viralidad rápida. No pienses en infografías ni en explicaciones corporativas.`;

  const userContent = `Post original de X:\n\n${input.postText}`;

  const responseSchema = {
    type: Type.OBJECT,
    properties: {
      a_quien_va_dirigido: { type: Type.STRING },
      conflicto_o_contradiccion: { type: Type.STRING },
      escena_representada: { type: Type.STRING },
      como_se_relaciona_la_imagen_con_el_post_y_la_direccion: { type: Type.STRING },
      nucleo_del_chiste: { type: Type.STRING },
      disparador_emocional: { type: Type.STRING },
      arquetipo_de_meme_mas_adecuado: { type: Type.STRING },
      que_elemento_visual_debe_ser_el_foco_principal: { type: Type.STRING },
      riesgos_de_sobrecarga_o_de_que_el_meme_necesite_demasiada_explicacion: { type: Type.STRING },
      requires_asset: { type: Type.BOOLEAN },
      selected_asset_id: { type: Type.STRING }
    },
    required: [
      "a_quien_va_dirigido", "conflicto_o_contradiccion", "escena_representada", 
      "como_se_relaciona_la_imagen_con_el_post_y_la_direccion", "nucleo_del_chiste",
      "disparador_emocional", "arquetipo_de_meme_mas_adecuado", 
      "que_elemento_visual_debe_ser_el_foco_principal", 
      "riesgos_de_sobrecarga_o_de_que_el_meme_necesite_demasiada_explicacion",
      "requires_asset"
    ]
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
