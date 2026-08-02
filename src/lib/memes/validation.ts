import 'server-only';
import { z } from 'zod';
import { MemeSlotPlan } from './planner';
import { Type, GoogleGenAI } from '@google/genai';
import { getConfig } from '../config';

export const MemeValidationSchema = z.object({
  is_valid: z.boolean().describe("True si la imagen cumple con todos los requisitos visuales, de texto y de seguridad. False si viola reglas de diseño o seguridad."),
  reason: z.string().describe("Razón detallada de la validación o el motivo exacto del rechazo."),
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

  const systemPrompt = `Eres un estricto auditor de calidad visual y seguridad para marketing viral. 
Tu tarea es auditar críticamente esta imagen generada y rechazarla (is_valid = false) si detectas CUALQUIERA de estos problemas:

REGLAS DE RECHAZO VISUAL (CRÍTICO):
1. Demasiado texto o texto ilegible/diminuto.
2. Texto renderizado cuando la restricción era 'no_text' (${plan.textQuantity === 'no_text' ? '¡ALERTA ROJA! Se esperaba CERO texto' : 'OK'}).
3. Más de 5 palabras en total (cuando la restricción es 'short_text').
4. Aspecto de infografía, presentación corporativa o anuncio publicitario.
5. Más de una idea principal o composición visualmente recargada.
6. Salida que vuelca textualmente la dirección de la campaña en la imagen.
7. Parece requerir demasiada lectura o tiempo para entenderse.

REGLAS DE SEGURIDAD (CRÍTICO):
8. Contenido ilegal.
9. Odio severo.
10. Sexual explícito no permitido.
11. Presencia indebida de menores.
12. Violencia gráfica extrema.
13. Doxxing o contenido gravemente ofensivo.

Dirección de Campaña (contexto): ${campaignDirection}
Estructura Visual Esperada: ${plan.visualStructure}
Complejidad Esperada: ${plan.sceneComplexity}

Se implacable. Si la imagen parece un diagrama explicativo o tiene más de 5 palabras, recházala.`;

  const userContent = `Verifica esta imagen generada bajo las estrictas reglas de rechazo.`;
  
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
      is_valid: { type: Type.BOOLEAN, description: "True si la imagen cumple con todos los requisitos visuales, de texto y de seguridad. False si viola reglas de diseño o seguridad." },
      reason: { type: Type.STRING, description: "Razón detallada de la validación o el motivo exacto del rechazo." }
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
