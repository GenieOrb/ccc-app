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
  regenerateInstruction?: string,
  options?: { signal?: AbortSignal; timeoutMs?: number }
): Promise<MemeGenerationResult> {
  const modelDef = resolveImageModel(modelKey);
  const reqOpts = requestOptionsForDeadline();

  const basePrompt = `Create a viral meme image based on this analysis:
Immediate Joke: ${analysis.immediate_joke}
Single Visual Focus: ${analysis.single_visual_focus}
Familiar Physical Situation: ${analysis.familiar_physical_situation}
Post Connection (must be visually clear): ${analysis.post_connection}

Deterministic Constraints:
- Text Quantity: ${plan.textQuantity === 'no_text' ? (plan.brandText ? 'DO NOT RENDER ANY TEXT EXCEPT THE REQUIRED BRAND TEXT BELOW.' : 'DO NOT RENDER ANY CAPTIONS, LABELS, SIGNS, HEADINGS, OR WORDS.') : plan.textQuantity === 'short_text' ? 'RENDER EXACTLY 1 TO 5 WORDS TOTAL, AND NO OTHER GENERATED TEXT.' : plan.textQuantity}
- Visual Structure: ${plan.visualStructure}
- Humor Tone: ${plan.humorTone}
- Scene Complexity: ${plan.sceneComplexity}
- Post Relationship: ${plan.postRelationship}
${plan.brandText ? `- REQUIRED BRAND TEXT: Include "${plan.brandText}" exactly, with identical spelling and casing. Do not alter, omit, translate, or duplicate it.` : ''}

IMPORTANT GUIDELINES:
- NO ads.
- NO infographic.
- NO presentation.
- NO explainer graphic.
- NO product sheet.
- NO multi-paragraph text.
- NO tiny unreadable text.
- NO more than one main joke.
- AVOID visual clutter.
- Must be comprehensible on mobile in less than 2 seconds.
${plan.requiresAsset ? `- The meme MUST feature the provided brand asset visually integrated.` : ''}
${assetData?.instruction ? `- Asset Instructions: ${assetData.instruction}` : ''}`;

  const prompt = regenerateInstruction 
    ? `${basePrompt}\n\nCORRECTION INSTRUCTION (CRITICAL):\n${regenerateInstruction}`
    : basePrompt;

  if (modelDef.provider === 'openai') {
    const client = getOpenAIClient('openai');
    let imageBuffer: Buffer | undefined;
    try {
      if (plan.requiresAsset && assetData) {
        const file = await toFile(assetData.buffer, 'reference.png', { type: assetData.mimeType });
        const response = await client.images.edit(
          {
            model: modelDef.apiModel,
            image: file,
            prompt: prompt,
            n: 1,
            size: '1024x1024',
          },
          reqOpts
        );

        const data = response.data?.[0];
        if (!data || (!data.b64_json && !data.url)) {
          throw new Error('OpenAI returned empty image data.');
        }
        
        if (data.b64_json) {
          imageBuffer = Buffer.from(data.b64_json, 'base64');
        } else if (data.url) {
          const resp = await fetch(data.url);
          if (!resp.ok) throw new Error('Failed to fetch OpenAI image URL');
          imageBuffer = Buffer.from(await resp.arrayBuffer());
        } else {
          throw new Error('No valid image data found');
        }
      } else {
        const response = await client.images.generate(
          {
            model: modelDef.apiModel,
            prompt: prompt,
            n: 1,
            size: '1024x1024',
          },
          reqOpts
        );

        const data = response.data?.[0];
        if (!data || (!data.b64_json && !data.url)) {
          throw new Error('OpenAI returned empty image data.');
        }
        
        if (data.b64_json) {
          imageBuffer = Buffer.from(data.b64_json, 'base64');
        } else if (data.url) {
          const resp = await fetch(data.url);
          if (!resp.ok) throw new Error('Failed to fetch OpenAI image URL');
          imageBuffer = Buffer.from(await resp.arrayBuffer());
        } else {
          throw new Error('No valid image data found');
        }
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

    return {
      imageBuffer: imageBuffer!,
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

    let response: Awaited<typeof req>;
    const req = ai.models.generateContent({
      model: modelDef.apiModel,
      contents: parts,
    });
    try {
      if (options?.signal) {
        const sig = options.signal;
        response = await Promise.race([
          req,
          new Promise<never>((_, reject) => {
            if (sig.aborted) return reject(new Error('Aborted'));
            sig.addEventListener('abort', () => reject(new Error('Aborted')));
          })
        ]);
      } else {
        response = await req;
      }
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
    const imagePart = candidate?.content?.parts?.find((p: { inlineData?: { data?: string, mimeType?: string } }) => p.inlineData);
    
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
