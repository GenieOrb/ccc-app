import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GoogleGenAI } from '@google/genai';
import * as config from '@/lib/config';
import { generateMemeImage } from './generation';

const { imagesEdit, createRequestDeadline, requestOptionsForDeadline, toFile } = vi.hoisted(() => ({ imagesEdit: vi.fn(), createRequestDeadline: vi.fn(), requestOptionsForDeadline: vi.fn(), toFile: vi.fn() }));
vi.mock('@/lib/config');
vi.mock('@/lib/openai', () => ({ getOpenAIClient: () => ({ images: { edit: imagesEdit } }), createRequestDeadline, requestOptionsForDeadline }));
vi.mock('openai', () => ({ toFile }));
vi.mock('@google/genai', () => {
  const mockModels = { generateContent: vi.fn(), generateImages: vi.fn() };
  return { GoogleGenAI: class { models = mockModels; } };
});

const googleConfig = () => vi.mocked(config.getConfig).mockReturnValue({
  databaseUrl: '', appBaseUrl: '', openaiApiKey: '', openaiModel: '', deepseekApiKey: '', deepseekBaseUrl: '', dashscopeApiKey: '', qwenBaseUrl: '',
  googleAiApiKey: 'valid-key', xBearerToken: '', adminPasswordHash: '', adminSessionSecret: '', visitorCookieSecret: '', securityHmacSecret: '', internalProcessSecret: '', cronSecret: '',
  memeAnalysisModel: '', memeValidationModel: ''
});
const googleMock = () => new GoogleGenAI({ apiKey: 'valid-key' }).models.generateContent as unknown as ReturnType<typeof vi.fn>;
const plan = (overrides: Record<string, unknown> = {}) => ({
  textQuantity: 'short_text', visualStructure: 'single_scene', humorTone: 'subtle', sceneComplexity: 'simple', postRelationship: 'direct_reaction',
  requiresAsset: false, templateId: 'switching_preference_3subjects', templateVersion: 1, ...overrides,
}) as never;
const analysis = (captions: string[] = []) => ({ immediate_joke: 'joke', single_visual_focus: 'focus', familiar_physical_situation: 'situation', post_connection: 'connection', requires_asset: false, captions });
const references = [
  { buffer: Buffer.from('primary-reference'), mimeType: 'image/png', instruction: 'PRIMARY REFERENCE INSTRUCTION' },
  { buffer: Buffer.from('secondary-reference'), mimeType: 'image/jpeg', instruction: 'SECONDARY REFERENCE INSTRUCTION' },
];

describe('generateMemeImage provider adapters', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    googleConfig();
    createRequestDeadline.mockImplementation((timeoutMs?: number) => timeoutMs === undefined ? undefined : Date.now() + timeoutMs);
    requestOptionsForDeadline.mockReturnValue({ timeout: 2_000, maxRetries: 0 });
    toFile.mockImplementation(async (_buffer: Buffer, name: string, options: { type: string }) => ({ name, type: options.type }));
  });

  it('uses Google generateContent, enforces zero text, and returns the provider binary', async () => {
    const generateContent = googleMock();
    generateContent.mockResolvedValue({ candidates: [{ content: { parts: [{ inlineData: { data: 'YmFzZTY0dGVzdA==', mimeType: 'image/jpeg' } }] } }] });
    const result = await generateMemeImage(plan({ textQuantity: 'no_text' }), analysis(), 'gemini-3.1-flash-image');
    const prompt = generateContent.mock.calls[0][0].contents[0].text as string;
    expect(result).toMatchObject({ mimeType: 'image/jpeg' });
    expect(result.imageBuffer.toString('base64')).toBe('YmFzZTY0dGVzdA==');
    expect(prompt).toContain('Render ZERO visible words');
    expect(prompt).toContain('remove all pre-existing text');
    expect(new GoogleGenAI({ apiKey: 'valid-key' }).models.generateImages).not.toHaveBeenCalled();
  });

  it('keeps brandText as internal promoted-role context and never authorizes it as visible text', async () => {
    const generateContent = googleMock();
    generateContent.mockResolvedValue({ candidates: [{ content: { parts: [{ inlineData: { data: 'aW1hZ2U=', mimeType: 'image/png' } }] } }] });
    await generateMemeImage(plan({ brandText: 'INTERNAL_BRAND' }), analysis(), 'gemini-3.1-flash-image');
    const prompt = generateContent.mock.calls[0][0].contents[0].text as string;
    expect(prompt.match(/INTERNAL_BRAND/g)).toHaveLength(1);
    expect(prompt).toContain('Internal promoted brand context (semantic role only; not authorized visible text): INTERNAL_BRAND');
    expect(prompt).toContain('Never render the promoted brand name as visible text unless it exactly matches the authorized caption');
  });

  it('revalida no_text y elimina una caption FORBIDDEN antes del prompt', async () => {
    const generateContent = googleMock();
    generateContent.mockResolvedValue({ candidates: [{ content: { parts: [{ inlineData: { data: 'aW1hZ2U=', mimeType: 'image/png' } }] } }] });
    await generateMemeImage(plan({ textQuantity: 'no_text' }), analysis(['FORBIDDEN']), 'gemini-3.1-flash-image');
    const prompt = generateContent.mock.calls[0][0].contents[0].text as string;
    expect(prompt).toContain('Render ZERO visible words');
    expect(prompt).not.toContain('FORBIDDEN');
  });

  it('revalida short_text a la primera caption y sus primeras cinco palabras', async () => {
    const generateContent = googleMock();
    generateContent.mockResolvedValue({ candidates: [{ content: { parts: [{ inlineData: { data: 'aW1hZ2U=', mimeType: 'image/png' } }] } }] });
    await generateMemeImage(plan(), analysis(['one two three four five six', 'SECOND FORBIDDEN']), 'gemini-3.1-flash-image');
    const prompt = generateContent.mock.calls[0][0].contents[0].text as string;
    expect(prompt).toContain('Render EXACTLY this one authorized caption: "one two three four five"');
    expect(prompt).not.toContain('six');
    expect(prompt).not.toContain('SECOND FORBIDDEN');
  });

  it('revalida una palabra larga a exactamente 25 caracteres', async () => {
    const generateContent = googleMock();
    generateContent.mockResolvedValue({ candidates: [{ content: { parts: [{ inlineData: { data: 'aW1hZ2U=', mimeType: 'image/png' } }] } }] });
    const longWord = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ123456789';
    await generateMemeImage(plan(), analysis([longWord]), 'gemini-3.1-flash-image');
    const prompt = generateContent.mock.calls[0][0].contents[0].text as string;
    expect(prompt).toContain(`Render EXACTLY this one authorized caption: "${longWord.slice(0, 25)}"`);
    expect(prompt).not.toContain(longWord.slice(0, 26));
  });

  it('sends template, primary, and secondary references to Google in order with all instructions', async () => {
    const generateContent = googleMock();
    generateContent.mockResolvedValue({ candidates: [{ content: { parts: [{ inlineData: { data: 'aW1hZ2U=', mimeType: 'image/png' } }] } }] });
    await generateMemeImage(plan({ requiresAsset: true }), analysis(['BUILD PASSES']), 'gemini-3.1-flash-image', references);
    const request = generateContent.mock.calls[0][0];
    const prompt = request.contents[0].text as string;
    expect(prompt).toContain('Render EXACTLY this one authorized caption: "BUILD PASSES"');
    expect(prompt).toContain('Do not copy, transcribe, preserve, or reproduce any text from the reference image');
    expect(prompt).toContain("The promoted brand is the newly attractive option receiving the chooser's attention.");
    expect(prompt).toContain('PRIMARY REFERENCE INSTRUCTION');
    expect(prompt).toContain('SECONDARY REFERENCE INSTRUCTION');
    expect(request.contents.slice(1).map((part: { inlineData: { data: string; mimeType: string } }) => part.inlineData)).toEqual([
      expect.objectContaining({ mimeType: 'image/jpeg' }),
      { data: Buffer.from('primary-reference').toString('base64'), mimeType: 'image/png' },
      { data: Buffer.from('secondary-reference').toString('base64'), mimeType: 'image/jpeg' },
    ]);
  });

  it('sends template, primary, and secondary references to OpenAI images.edit in order', async () => {
    imagesEdit.mockResolvedValue({ data: [{ b64_json: 'b3BlbmFpLWltYWdl' }] });
    const result = await generateMemeImage(plan({ requiresAsset: true, templateId: 'off_vs_on_transformation', visualStructure: 'direct_comparison' }), analysis(['BETTER NOW']), 'gpt-image-2', references, undefined, { timeoutMs: 2_500 });
    const request = imagesEdit.mock.calls[0][0];
    expect(result.imageBuffer.toString()).toBe('openai-image');
    expect(request.image.map((file: { name: string; type: string }) => ({ name: file.name, type: file.type }))).toEqual([
      { name: '009_off_vs_on_transformation.jpg', type: 'image/jpeg' },
      { name: 'asset-reference-1', type: 'image/png' },
      { name: 'asset-reference-2', type: 'image/jpeg' },
    ]);
    expect(request.prompt).toContain('PRIMARY REFERENCE INSTRUCTION');
    expect(request.prompt).toContain('SECONDARY REFERENCE INSTRUCTION');
    expect(createRequestDeadline).toHaveBeenCalledOnce();
    expect(createRequestDeadline).toHaveBeenCalledWith(2_500);
    expect(requestOptionsForDeadline).toHaveBeenCalledWith(createRequestDeadline.mock.results[0].value);
    expect(imagesEdit.mock.calls[0][1]).toEqual(expect.objectContaining({ timeout: 2_000, maxRetries: 0, signal: expect.any(AbortSignal) }));
  });

  it('prepares OpenAI files but never starts images.edit after that preparation exhausts its deadline', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValueOnce(1_000).mockReturnValueOnce(2_001);
    await expect(generateMemeImage(plan(), analysis(['SHORT']), 'gpt-image-2', [], undefined, { timeoutMs: 1_000 })).rejects.toThrow(/time budget exhausted/i);
    expect(toFile).toHaveBeenCalledOnce();
    expect(imagesEdit).not.toHaveBeenCalled();
    now.mockRestore();
  });

  it('retries Google once on a transient 503', async () => {
    const generateContent = googleMock();
    generateContent.mockRejectedValueOnce(new Error('{"error":{"code":503,"status":"UNAVAILABLE"}}')).mockResolvedValueOnce({ candidates: [{ content: { parts: [{ inlineData: { data: 'aW1hZ2U=', mimeType: 'image/png' } }] } }] });
    const controller = new AbortController();
    const addListener = vi.spyOn(controller.signal, 'addEventListener');
    const removeListener = vi.spyOn(controller.signal, 'removeEventListener');
    await expect(generateMemeImage(plan(), analysis(['SHORT']), 'gemini-3.1-flash-lite-image', [], undefined, { signal: controller.signal, timeoutMs: 2_500 })).resolves.toMatchObject({ mimeType: 'image/png' });
    expect(generateContent).toHaveBeenCalledTimes(2);
    expect(createRequestDeadline).toHaveBeenCalledOnce();
    expect(createRequestDeadline).toHaveBeenCalledWith(2_500);
    expect(addListener).toHaveBeenCalledTimes(2);
    expect(removeListener).toHaveBeenCalledTimes(2);
  });

  it('does not invoke Google when the caller has already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(generateMemeImage(plan(), analysis(['SHORT']), 'gemini-3.1-flash-lite-image', [], undefined, { signal: controller.signal, timeoutMs: 2_500 })).rejects.toThrow(/aborted/i);
    expect(googleMock()).not.toHaveBeenCalled();
  });

  it('passes a real per-attempt abort signal to Google and removes listeners after it settles', async () => {
    const generateContent = googleMock();
    generateContent.mockResolvedValue({ candidates: [{ content: { parts: [{ inlineData: { data: 'aW1hZ2U=', mimeType: 'image/png' } }] } }] });
    const controller = new AbortController();
    const removeListener = vi.spyOn(controller.signal, 'removeEventListener');
    await generateMemeImage(plan(), analysis(['SHORT']), 'gemini-3.1-flash-lite-image', [], undefined, { signal: controller.signal, timeoutMs: 2_500 });
    const attemptSignal = generateContent.mock.calls[0][0].config.abortSignal as AbortSignal;
    expect(attemptSignal).toBeInstanceOf(AbortSignal);
    expect(attemptSignal).not.toBe(controller.signal);
    expect(removeListener).toHaveBeenCalled();
  });

  it('does not start a second Google retry after the total deadline is exhausted', async () => {
    const generateContent = googleMock();
    generateContent.mockRejectedValue(new Error('{"error":{"code":503,"status":"UNAVAILABLE"}}'));
    const now = vi.spyOn(Date, 'now').mockReturnValueOnce(1_000).mockReturnValueOnce(1_000).mockReturnValueOnce(3_000);
    await expect(generateMemeImage(plan(), analysis(['SHORT']), 'gemini-3.1-flash-lite-image', [], undefined, { timeoutMs: 1_000 })).rejects.toThrow(/time budget exhausted/i);
    expect(generateContent).toHaveBeenCalledTimes(1);
    now.mockRestore();
  });

  it('uses the same deadline scope for OpenAI URL download and never starts expired work', async () => {
    imagesEdit.mockResolvedValue({ data: [{ url: 'https://images.example.test/meme.png' }] });
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, arrayBuffer: async () => Buffer.from('url-image') });
    vi.stubGlobal('fetch', fetchMock);
    const controller = new AbortController();
    await generateMemeImage(plan(), analysis(['SHORT']), 'gpt-image-2', [], undefined, { signal: controller.signal, timeoutMs: 2_500 });
    expect(fetchMock).toHaveBeenCalledWith('https://images.example.test/meme.png', expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect((fetchMock.mock.calls[0][1] as RequestInit).signal).not.toBe(controller.signal);
  });
});
