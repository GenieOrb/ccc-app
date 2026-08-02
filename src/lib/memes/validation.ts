import 'server-only';
import { z } from 'zod';
import { getOpenAIClient, requestOptionsForDeadline } from '../openai';
import { zodResponseFormat } from 'openai/helpers/zod';
import type { ChatCompletionContentPart } from 'openai/resources/index.mjs';
import { MemeSlotPlan } from './planner';

export const MemeValidationSchema = z.object({
  is_valid: z.boolean().describe("True si la imagen cumple con todos los requisitos y es segura, false de lo contrario."),
  reason: z.string().describe("Razón de la validación o rechazo."),
});

export type MemeValidationResult = z.infer<typeof MemeValidationSchema>;

export async function validateMemeImage(
  imageBuffer: Buffer,
  mimeType: string,
  plan: MemeSlotPlan,
  campaignDirection: string,
  deadline?: number
): Promise<MemeValidationResult> {
  const client = getOpenAIClient('openai');
  const reqOpts = requestOptionsForDeadline(deadline);

  const base64Image = imageBuffer.toString('base64');
  const dataUrl = `data:${mimeType};base64,${base64Image}`;

  const systemPrompt = `Eres un auditor de calidad y seguridad de marketing. 
Tu tarea es analizar una imagen generada para un meme y asegurarte de que:
1. No contiene texto ilegible o sin sentido (gibberish).
2. Es segura (sin contenido NSFW, violencia o elementos inapropiados explícitos).
3. Tiene coherencia con el formato visual: ${plan.format} y tono: ${plan.tone}.
4. Respeta la dirección de la campaña: ${campaignDirection}

Devuelve is_valid = false si hay texto ilegible flagrante, problemas graves de seguridad, o es completamente incoherente con el estilo/tono. De lo contrario, true.`;

  const userContent: ChatCompletionContentPart[] = [
    { type: 'text', text: `Verifica esta imagen generada.` },
    {
      type: 'image_url',
      image_url: { url: dataUrl, detail: 'low' } // Use low detail for cost efficiency in validation
    }
  ];

  const completion = await client.beta.chat.completions.parse({
    model: 'gpt-4o-mini',
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userContent }
    ],
    response_format: zodResponseFormat(MemeValidationSchema, 'meme_validation'),
    ...reqOpts
  });

  if (!completion.choices[0].message.parsed) {
    throw new Error('Failed to parse meme validation analysis');
  }

  return completion.choices[0].message.parsed;
}
