import 'server-only';
import { getOpenAIClient, requestOptionsForDeadline } from '../openai';
import { resolveImageModel } from '../ai/image-models';
import { GoogleGenAI } from '@google/genai';
import { getConfig } from '../config';
import { MemeSlotPlan } from './planner';
import { MemePreflightAnalysis } from './analysis';

import { toFile } from 'openai';

export interface MemeGenerationResult {
  imageBuffer: Buffer;
  mimeType: string;
  cost: string;
  width: number;
  height: number;
}

export async function generateMemeImage(
  plan: MemeSlotPlan,
  analysis: MemePreflightAnalysis,
  modelKey: string,
  assetData?: { buffer: Buffer; mimeType: string; instruction?: string },
  deadline?: number
): Promise<MemeGenerationResult> {
  const modelDef = resolveImageModel(modelKey);
  const reqOpts = requestOptionsForDeadline(deadline);

  const prompt = `Create a meme image based on this concept:
Concept: ${analysis.concept}
Mechanism: ${plan.mechanism}
Format: ${plan.format}
Tone: ${plan.tone}
${analysis.suggested_text_top ? `Top Text: "${analysis.suggested_text_top}"` : ''}
${analysis.suggested_text_bottom ? `Bottom Text: "${analysis.suggested_text_bottom}"` : ''}

IMPORTANT GUIDELINES:
- No text in the image unless strictly necessary for the meme format.
- Ensure the image matches the tone and visual style precisely.
${plan.requiresAsset ? `- The meme MUST feature the provided brand asset visually integrated.` : ''}
${assetData?.instruction ? `- Asset Instructions: ${assetData.instruction}` : ''}
`;

  if (modelDef.provider === 'openai') {
    const client = getOpenAIClient('openai');
    let b64: string;
    
    try {
      if (plan.requiresAsset && assetData) {
        // Usa image edit si hay asset de referencia
        const file = await toFile(assetData.buffer, 'reference.png', { type: assetData.mimeType });
        const response = await client.images.edit(
          {
            model: modelDef.apiModel,
            image: file,
            prompt: prompt,
            n: 1,
            size: '1024x1024',
            response_format: 'b64_json',
          },
          reqOpts
        );

        if (!response.data || !response.data[0] || !response.data[0].b64_json) {
          throw new Error('OpenAI returned empty image data.');
        }
        b64 = response.data[0].b64_json;
      } else {
        // Generación normal
        const response = await client.images.generate(
          {
            model: modelDef.apiModel,
            prompt: prompt,
            n: 1,
            size: '1024x1024',
            response_format: 'b64_json',
          },
          reqOpts
        );

        if (!response.data || !response.data[0] || !response.data[0].b64_json) {
          throw new Error('OpenAI returned empty image data.');
        }
        b64 = response.data[0].b64_json;
      }
    } catch (error: unknown) {
      const err = error as Error & { status?: number; error?: { code?: string } };
      if (err.status === 403) {
        throw new Error(`Acceso denegado a modelo de imagen OpenAI: ${modelDef.apiModel} (403)`);
      }
      if (err.status === 429) {
        throw new Error(`Rate limit excedido en modelo de imagen OpenAI: ${modelDef.apiModel} (429)`);
      }
      if (err.error?.code === 'content_policy_violation') {
        throw new Error(`Rechazo de contenido por política en modelo de imagen OpenAI: ${modelDef.apiModel}`);
      }
      throw err;
    }

    const imageBuffer = Buffer.from(b64, 'base64');
    return {
      imageBuffer,
      mimeType: 'image/png',
      cost: modelDef.resolutions[0].costPerImage,
      width: 1024,
      height: 1024,
    };
  } else if (modelDef.provider === 'google') {
    const config = getConfig();
    if (!config.googleAiApiKey) throw new Error('GOOGLE_AI_API_KEY is not configured');
    const ai = new GoogleGenAI({ apiKey: config.googleAiApiKey });
    
    const parts: ({ text: string } | { inlineData: { mimeType: string, data: string } })[] = [{ text: prompt }];
    
    if (plan.requiresAsset && assetData) {
      parts.push({
        inlineData: {
          data: assetData.buffer.toString('base64'),
          mimeType: assetData.mimeType
        }
      });
    }

    let response;
    try {
      response = await ai.models.generateContent({
        model: modelDef.apiModel,
        contents: parts,
      });
    } catch (error: unknown) {
      const err = error as Error & { status?: number };
      if (err.status === 403) {
        throw new Error(`Acceso denegado a modelo de imagen Google: ${modelDef.apiModel} (403)`);
      }
      if (err.status === 429) {
        throw new Error(`Rate limit excedido en modelo de imagen Google: ${modelDef.apiModel} (429)`);
      }
      throw error;
    }

    const candidate = response.candidates?.[0];
    const imagePart = candidate?.content?.parts?.find(p => p.inlineData);
    
    if (!imagePart || !imagePart.inlineData || !imagePart.inlineData.data) {
      throw new Error('Google GenAI returned empty image data.');
    }
    const b64 = imagePart.inlineData.data;
    const returnedMime = imagePart.inlineData.mimeType || 'image/png';

    const imageBuffer = Buffer.from(b64, 'base64');
    return {
      imageBuffer,
      mimeType: returnedMime,
      cost: modelDef.resolutions[0].costPerImage,
      width: modelDef.defaultResolution.width,
      height: modelDef.defaultResolution.height,
    };
  }

  throw new Error(`Unsupported provider: ${modelDef.provider}`);
}
