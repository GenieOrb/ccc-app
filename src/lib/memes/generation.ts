import 'server-only';
import { getOpenAIClient, requestOptionsForDeadline } from '../openai';
import { resolveImageModel } from '../ai/image-models';
import { GoogleGenAI } from '@google/genai';
import { getConfig } from '../config';
import { MemeSlotPlan } from './planner';
import { MemePreflightAnalysis } from './analysis';

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
`;

  if (modelDef.provider === 'openai') {
    const client = getOpenAIClient('openai');
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
    const b64 = response.data[0].b64_json;

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
    
    const response = await ai.models.generateContent({
      model: modelDef.apiModel,
      contents: prompt,
    });

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
