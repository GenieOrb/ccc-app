import 'server-only';
import { z } from 'zod';
import { MemeSlotPlan } from './planner';
import { Type, GoogleGenAI } from '@google/genai';
import { getConfig } from '../config';

export const MemeValidationSchema = z.object({
  is_valid: z.boolean().describe("True si la imagen cumple con todos los requisitos y es segura, false de lo contrario."),
  reason: z.string().describe("Razón de la validación o rechazo."),
});

export type MemeValidationResult = z.infer<typeof MemeValidationSchema>;

export async function validateMemeImage(
  imageBuffer: Buffer,
  mimeType: string,
  plan: MemeSlotPlan,
  campaignDirection: string
): Promise<MemeValidationResult> {
  const config = getConfig();
  
  if (!config.googleAiApiKey) {
    throw new Error('Google AI API Key no configurada. (provider: google, phase: validation)');
  }

  const client = new GoogleGenAI({ apiKey: config.googleAiApiKey });
  const modelName = config.memeValidationModel || 'gemini-3.1-flash-lite';

  const systemPrompt = `Eres un auditor de calidad y seguridad de marketing. 
Tu tarea es analizar una imagen generada para un meme y asegurarte de que:
1. No contiene texto ilegible o sin sentido (gibberish).
2. Es segura (sin contenido NSFW, violencia o elementos inapropiados explícitos).
3. Tiene coherencia con el formato visual: ${plan.format} y tono: ${plan.tone}.
4. Respeta la dirección de la campaña: ${campaignDirection}

Devuelve is_valid = false si hay texto ilegible flagrante, problemas graves de seguridad, o es completamente incoherente con el estilo/tono. De lo contrario, true.`;

  const userContent = `Verifica esta imagen generada.`;
  
  const base64Image = imageBuffer.toString('base64');
  const imagePart = {
    inlineData: {
      data: base64Image,
      mimeType
    }
  };

  const responseSchema = {
    type: Type.OBJECT,
    properties: {
      is_valid: { type: Type.BOOLEAN, description: "True si la imagen cumple con todos los requisitos y es segura, false de lo contrario." },
      reason: { type: Type.STRING, description: "Razón de la validación o rechazo." }
    },
    required: ["is_valid", "reason"]
  };

  try {
    const response = await client.models.generateContent({
      model: modelName,
      contents: [
        { role: 'user', parts: [{ text: userContent }, imagePart] }
      ],
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
    return MemeValidationSchema.parse(parsed);
  } catch (error: unknown) {
    const err = error as Error & { status?: number };
    let code = 500;
    let type = 'content';
    if (err.status === 403) code = 403;
    if (err.status === 429) code = 429;
    if (code === 403) type = 'acceso denegado';
    else if (code === 429) type = 'rate limit';
    
    throw new Error(`No se pudo validar el contenido con ${modelName}: ${type}. (phase: validation, provider: google, status: ${code})`);
  }
}
