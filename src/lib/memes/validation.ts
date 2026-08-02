import 'server-only';
import { z } from 'zod';
import { MemeSlotPlan } from './planner';
import { Type, GoogleGenAI } from '@google/genai';
import { getConfig } from '../config';

export const MemeValidationSchema = z.object({
  detected_word_count: z.number().describe("Cantidad exacta de palabras legibles detectadas en la imagen."),
  panel_count: z.number().describe("Cantidad de viñetas o paneles separados en la imagen."),
  looks_like_infographic: z.boolean().describe("True si parece una infografía, diagrama, gráfico, o dashboard corporativo."),
  clutter_score: z.number().min(1).max(10).describe("Nivel de saturación visual (1=limpio/simple, 10=saturado/caótico)."),
  reason: z.string().describe("Detalles visuales observados que justifican las métricas anteriores.")
});

export type MemeValidationMetrics = z.infer<typeof MemeValidationSchema>;

export interface MemeValidationResult {
  is_valid: boolean;
  reason: string;
  metrics: MemeValidationMetrics;
}

export async function validateMemeImage(
  imageBuffer: Buffer,
  mimeType: string,
  plan: MemeSlotPlan,
  _campaignDirection: string,
  options?: { signal?: AbortSignal; timeoutMs?: number }
): Promise<MemeValidationResult> {
  const config = getConfig();
  
  if (!config.googleAiApiKey) {
    throw new Error('Google AI API Key no configurada. (provider: google, phase: validation)');
  }

  const client = new GoogleGenAI({ apiKey: config.googleAiApiKey });
  const modelName = config.memeValidationModel || 'gemini-3.1-flash-lite';

  const systemPrompt = `Eres un sistema de visión artificial puro, encargado exclusivamente de reportar métricas objetivas de la imagen suministrada.
No debes decidir si el meme es bueno o malo, solo extraer los siguientes datos con máxima precisión:

1. detected_word_count: Cuenta exactamente cuántas palabras legibles hay en TODA la imagen (incluyendo texto generado por el modelo de IA). Si no hay texto, pon 0.
2. panel_count: Cuenta cuántas viñetas, paneles o divisiones tiene la imagen. Una imagen normal es 1.
3. looks_like_infographic: Determina si la imagen tiene un estilo visual de presentación corporativa, infografía de datos, dashboard, gráficas o diagramas. True si es así, False si es una escena natural o dibujo normal.
4. clutter_score: Del 1 al 10, qué tan recargada, caótica o saturada está la composición visual. (1 = muy limpio, un solo sujeto claro; 10 = caótico, demasiados elementos, denso).
5. reason: Una breve descripción de lo que ves que justifica los números anteriores.`;

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
      detected_word_count: { type: Type.INTEGER, description: "Cantidad exacta de palabras legibles detectadas." },
      panel_count: { type: Type.INTEGER, description: "Cantidad de paneles o viñetas." },
      looks_like_infographic: { type: Type.BOOLEAN, description: "True si parece infografía o dashboard." },
      clutter_score: { type: Type.INTEGER, description: "Del 1 al 10, saturación visual." },
      reason: { type: Type.STRING, description: "Razón detallada de las métricas." }
    },
    required: ["detected_word_count", "panel_count", "looks_like_infographic", "clutter_score", "reason"]
  };

  try {
    let response;
    const req = client.models.generateContent({
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
    const metrics = MemeValidationSchema.parse(parsed);

    let is_valid = true;
    let finalReason = metrics.reason;

    if (metrics.looks_like_infographic) {
      is_valid = false;
      finalReason = 'Rechazado: Parece una infografía o diagrama corporativo.';
    } else if (metrics.clutter_score > 6) {
      is_valid = false;
      finalReason = `Rechazado: Demasiado saturado visualmente (clutter_score: ${metrics.clutter_score}).`;
    } else if (plan.textQuantity === 'no_text' && metrics.detected_word_count > 0) {
      is_valid = false;
      finalReason = `Rechazado: Se encontraron ${metrics.detected_word_count} palabras, pero se solicitó 'no_text'.`;
    } else if (plan.textQuantity === 'short_text' && metrics.detected_word_count > 5) {
      is_valid = false;
      finalReason = `Rechazado: Se encontraron ${metrics.detected_word_count} palabras, excediendo el límite de 5 para 'short_text'.`;
    }

    return { is_valid, reason: finalReason, metrics };
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
