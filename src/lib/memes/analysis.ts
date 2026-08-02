import 'server-only';
import { z } from 'zod';
import { createHash } from 'node:crypto';

import { Type, GoogleGenAI } from '@google/genai';
import { getConfig } from '../config';

export const MemePreflightAnalysisSchema = z.object({
  immediate_joke: z.string().describe("What is the immediate visual joke that takes 1 second to understand?"),
  single_visual_focus: z.string().describe("What is the SINGLE main visual focus of the image? (e.g. A cat staring at a screen)"),
  familiar_physical_situation: z.string().describe("What familiar, physical, real-world situation represents this? NO abstract concepts, NO diagrams, NO text."),
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
  input: MemeAnalysisInput,
  options?: { signal?: AbortSignal; timeoutMs?: number }
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
      immediate_joke: { type: Type.STRING },
      single_visual_focus: { type: Type.STRING },
      familiar_physical_situation: { type: Type.STRING },
      requires_asset: { type: Type.BOOLEAN },
      selected_asset_id: { type: Type.STRING }
    },
    required: [
      "immediate_joke", "single_visual_focus", "familiar_physical_situation", "requires_asset"
    ]
  };

  try {
    let response;
    const req = client.models.generateContent({
      model: modelName,
      contents: userContent,
      config: {
        systemInstruction: systemPrompt,
        responseMimeType: 'application/json',
        responseSchema: responseSchema
      }
    });
    if (options?.signal) {
      response = await Promise.race([
        req,
        new Promise<never>((_, reject) => {
          if (options.signal!.aborted) return reject(new Error('Aborted'));
          options.signal!.addEventListener('abort', () => reject(new Error('Aborted')));
        })
      ]);
    } else {
      response = await req;
    }

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
