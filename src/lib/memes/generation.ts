import 'server-only';
import { createRequestDeadline, getOpenAIClient, requestOptionsForDeadline } from '../openai';
import { resolveImageModel } from '../ai/image-models';
import { GoogleGenAI } from '@google/genai';
import { getConfig } from '../config';
import { MemeSlotPlan } from './planner';
import { MemePreflightAnalysis, normalizeMemeCaptions } from './analysis';
import { getMemeTemplate, type MemeTemplate } from './templates';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { toFile } from 'openai';

export interface MemeGenerationResult {
  imageBuffer: Buffer;
  mimeType: string;
  cost: string;
  width: number;
  height: number;
}

interface MemeTemplateReference {
  buffer: Buffer;
  mimeType: 'image/jpeg' | 'image/png';
  filename: string;
}

export interface MemeGenerationReference {
  buffer: Buffer;
  mimeType: string;
  instruction?: string;
  assetType?: string;
}

async function loadMemeTemplateReference(template: MemeTemplate): Promise<MemeTemplateReference> {
  const filename = path.basename(template.path);
  const mimeType = path.extname(filename).toLowerCase() === '.png' ? 'image/png' : 'image/jpeg';

  try {
    return {
      buffer: await readFile(path.join(process.cwd(), 'public', template.path.replace(/^\//, ''))),
      mimeType,
      filename,
    };
  } catch (error) {
    throw new Error(`Meme template reference is unavailable (phase: generation, template: ${template.id})`, { cause: error });
  }
}

interface ProviderAttemptScope {
  signal: AbortSignal;
  cleanup(): void;
}

function createProviderAttemptScope(deadline: number | undefined, externalSignal?: AbortSignal): ProviderAttemptScope {
  if (externalSignal?.aborted) throw new Error('Aborted');
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const abortFromCaller = () => controller.abort(externalSignal?.reason);
  if (externalSignal) externalSignal.addEventListener('abort', abortFromCaller, { once: true });
  if (deadline !== undefined) {
    const remainingMs = Math.floor(deadline - Date.now());
    if (remainingMs <= 0) {
      if (externalSignal) externalSignal.removeEventListener('abort', abortFromCaller);
      throw new Error('Provider request time budget exhausted.');
    }
    timer = setTimeout(() => controller.abort(new Error('Provider request time budget exhausted.')), remainingMs);
  }
  return {
    signal: controller.signal,
    cleanup: () => {
      if (timer) clearTimeout(timer);
      if (externalSignal) externalSignal.removeEventListener('abort', abortFromCaller);
    },
  };
}

function throwIfAttemptAborted(signal: AbortSignal) {
  if (!signal.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  throw new Error('Aborted');
}

function providerStatusCode(error: unknown): number | undefined {
  const candidate = error as { status?: unknown; message?: unknown };
  if (candidate.status === 429 || candidate.status === 503) return candidate.status;
  const serialized = typeof candidate.message === 'string' ? candidate.message : String(error);
  const match = serialized.match(/"code"\s*:\s*(429|503)/);
  return match ? Number(match[1]) : undefined;
}

export async function generateMemeImage(
  plan: MemeSlotPlan,
  analysis: MemePreflightAnalysis,
  modelKey: string,
  assetReferences: readonly MemeGenerationReference[] = [],
  regenerateInstruction?: string,
  options?: { signal?: AbortSignal; timeoutMs?: number }
): Promise<MemeGenerationResult> {
  const requestDeadline = createRequestDeadline(options?.timeoutMs);
  const modelDef = resolveImageModel(modelKey);
  const template = getMemeTemplate(plan.templateId, plan.templateVersion);
  const templateReference = await loadMemeTemplateReference(template);
  const captions = normalizeMemeCaptions(plan.textQuantity, analysis.captions);
  const captionInstructions = captions.length === 1
    ? `- Render EXACTLY this one authorized caption: "${captions[0]}". Add no other visible text.`
    : '- Render ZERO visible words, letters, numbers, labels, watermarks, or captions.';

  const basePrompt = `Create a viral meme image based on this analysis:
Immediate Joke: ${analysis.immediate_joke}
Single Visual Focus: ${analysis.single_visual_focus}
Familiar Physical Situation: ${analysis.familiar_physical_situation}
Post Connection (must be visually clear): ${analysis.post_connection}

Deterministic Constraints:
- Text Quantity: ${plan.textQuantity}
- Visual Structure: ${plan.visualStructure}
- Humor Tone: ${plan.humorTone}
- Scene Complexity: ${plan.sceneComplexity}
- Post Relationship: ${plan.postRelationship}

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
\nTemplate and caption requirements:
- The attached image is the selected meme template. Use it as the visual reference and generate the final meme from that template.
- Preserve the original canvas, panel geometry, characters, crop, and visual hierarchy. Do not create white sidebars, graphs, extra panels, replacement scenes, or explanatory icons.
- Before rendering, remove all pre-existing text from the reference image and reconstruct the covered background naturally.
- Do not copy, transcribe, preserve, or reproduce any text from the reference image.
- Template purpose: ${template.guidance.purpose}
- Template panel roles: ${template.guidance.panelRoles.join(' / ')}
- Promoted brand role: ${template.guidance.promotedBrandRole}
- Inferior alternative role: ${template.guidance.inferiorAlternativeRole}
- Complete visual guidance: ${JSON.stringify(template.guidance)}
${captionInstructions}
- Never use these artificial marketing terms: multi-view, multi-logic, multi-lens, multi-insight, synthesis, combined, vision.
${plan.brandText ? `- Internal promoted brand context (semantic role only; not authorized visible text): ${plan.brandText}\n- Never render the promoted brand name as visible text unless it exactly matches the authorized caption.` : ''}
${assetReferences.length ? `- Integrate the provided brand references in their supplied order as narrative elements. Never use them as floating stickers, watermarks, separate badges, or cover a face or caption.\n${assetReferences.map((reference, index) => `- Asset reference ${index + 1} instructions: ${reference.instruction || 'Use as supplied.'}`).join('\n')}` : ''}`;

  const prompt = regenerateInstruction 
    ? `${basePrompt}\n\nCORRECTION INSTRUCTION (CRITICAL):\n${regenerateInstruction}`
    : basePrompt;

  if (modelDef.provider === 'openai') {
    const client = getOpenAIClient('openai');
    let imageBuffer: Buffer | undefined;
    let attemptScope: ProviderAttemptScope | undefined;
    try {
      const templateFile = await toFile(templateReference.buffer, templateReference.filename, { type: templateReference.mimeType });
      const referenceFiles = await Promise.all(assetReferences.map((reference, index) => toFile(reference.buffer, `asset-reference-${index + 1}`, { type: reference.mimeType })));
      const images = referenceFiles.length > 0
        ? [templateFile, ...referenceFiles]
        : templateFile;

      // File preparation has no provider abort hook. Re-check the shared deadline
      // immediately before starting billable work so expired preparation never
      // opens an images.edit request.
      attemptScope = createProviderAttemptScope(requestDeadline, options?.signal);
      throwIfAttemptAborted(attemptScope.signal);
      const reqOpts = { ...requestOptionsForDeadline(requestDeadline), signal: attemptScope.signal };
      const response = await client.images.edit(
        {
          model: modelDef.apiModel,
          image: images,
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
        throwIfAttemptAborted(attemptScope.signal);
        const resp = await fetch(data.url, { signal: attemptScope.signal });
        if (!resp.ok) throw new Error('Failed to fetch OpenAI image URL');
        imageBuffer = Buffer.from(await resp.arrayBuffer());
      } else {
        throw new Error('No valid image data found');
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
    } finally {
      attemptScope?.cleanup();
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
    
    const parts: ({ text: string } | { inlineData: { mimeType: string, data: string } })[] = [
      { text: prompt },
      { inlineData: { data: templateReference.buffer.toString('base64'), mimeType: templateReference.mimeType } },
    ];
    
    for (const reference of assetReferences) {
      parts.push({
        inlineData: {
          data: reference.buffer.toString('base64'),
          mimeType: reference.mimeType
        }
      });
    }

    let response: Awaited<ReturnType<typeof ai.models.generateContent>> | undefined;
    for (let providerAttempt = 1; providerAttempt <= 2; providerAttempt++) {
      let attemptScope: ProviderAttemptScope | undefined;
      try {
        attemptScope = createProviderAttemptScope(requestDeadline, options?.signal);
        throwIfAttemptAborted(attemptScope.signal);
        response = await ai.models.generateContent({
          model: modelDef.apiModel,
          contents: parts,
          config: { abortSignal: attemptScope.signal },
        });
        break;
      } catch (error: unknown) {
        const err = error as Error & { status?: number };
        const status = providerStatusCode(error);
        const isTransient = status === 429 || status === 503;
        if (isTransient && providerAttempt === 1) continue;
        if (err.status === 403) throw new Error(`Acceso denegado a modelo de imagen Google: ${modelDef.apiModel} (403)`);
        if (err.status === 429) throw new Error(`Rate limit excedido en modelo de imagen Google: ${modelDef.apiModel} (429)`);
        throw error;
      } finally {
        attemptScope?.cleanup();
      }
    }

    if (!response) throw new Error(`Google GenAI returned no response after retry: ${modelDef.apiModel}`);

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
