import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { DEFAULT_MEME_ANALYSIS_MODEL, normalizeMemeCaptions, performMemeAnalysis, resolveMemeAnalysisModel } from './analysis';
import * as config from '../config';
import { GoogleGenAI } from '@google/genai';

vi.mock('../config');

vi.mock('@google/genai', () => {
  const mockGenerateContent = vi.fn();
  return {
    GoogleGenAI: class {
      models = {
        generateContent: mockGenerateContent
      };
    },
    Type: {
      OBJECT: 'OBJECT',
      STRING: 'STRING',
      BOOLEAN: 'BOOLEAN',
    }
  };
});

describe('performMemeAnalysis', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const configureGoogle = () => {
    vi.mocked(config.getConfig).mockReturnValue({
      databaseUrl: '', appBaseUrl: '', openaiApiKey: '', openaiModel: '', deepseekApiKey: '', deepseekBaseUrl: '', dashscopeApiKey: '', qwenBaseUrl: '',
      googleAiApiKey: 'fake-google-key', xBearerToken: '', adminPasswordHash: '', adminSessionSecret: '', visitorCookieSecret: '', securityHmacSecret: '', internalProcessSecret: '', cronSecret: '',
      memeAnalysisModel: 'gemini-3.1-flash-lite', memeValidationModel: ''
    });
  };

  const input = { postText: 'test post', campaignDirection: 'test direction', availableAssets: [] };

  it('no despacha Google cuando la senal externa ya esta abortada', async () => {
    configureGoogle();
    const controller = new AbortController();
    controller.abort();
    const mockGenerateContent = new GoogleGenAI({ apiKey: 'fake-google-key' }).models.generateContent as unknown as ReturnType<typeof vi.fn>;

    await expect(performMemeAnalysis(input, { signal: controller.signal })).rejects.toThrow('(phase: analysis, provider: google, status: 500)');
    expect(mockGenerateContent).not.toHaveBeenCalled();
  });

  it('propaga el timeout al proveedor mediante abortSignal', async () => {
    configureGoogle();
    vi.useFakeTimers();
    vi.spyOn(Date, 'now').mockReturnValue(100);
    const mockGenerateContent = new GoogleGenAI({ apiKey: 'fake-google-key' }).models.generateContent as unknown as ReturnType<typeof vi.fn>;
    mockGenerateContent.mockImplementation(({ config: requestConfig }) => new Promise((_, reject) => {
      requestConfig.abortSignal.addEventListener('abort', () => reject(new Error('provider aborted')), { once: true });
    }));

    const result = performMemeAnalysis(input, { timeoutMs: 0 });
    const assertion = expect(result).rejects.toThrow('(phase: analysis, provider: google, status: 500)');
    await vi.advanceTimersByTimeAsync(0);

    await assertion;
    expect(mockGenerateContent).toHaveBeenCalledTimes(1);
    expect(mockGenerateContent.mock.calls[0][0].config.abortSignal.aborted).toBe(true);
  });

  it('equilibra listeners de abort externo tras cancelar la peticion', async () => {
    configureGoogle();
    const controller = new AbortController();
    const addEventListener = vi.spyOn(controller.signal, 'addEventListener');
    const removeEventListener = vi.spyOn(controller.signal, 'removeEventListener');
    const mockGenerateContent = new GoogleGenAI({ apiKey: 'fake-google-key' }).models.generateContent as unknown as ReturnType<typeof vi.fn>;
    mockGenerateContent.mockImplementation(({ config: requestConfig }) => new Promise((_, reject) => {
      requestConfig.abortSignal.addEventListener('abort', () => reject(new Error('provider aborted')), { once: true });
    }));

    const result = performMemeAnalysis(input, { signal: controller.signal });
    controller.abort();

    await expect(result).rejects.toThrow('(phase: analysis, provider: google, status: 500)');
    expect(addEventListener).toHaveBeenCalledTimes(1);
    expect(removeEventListener).toHaveBeenCalledTimes(1);
  });

  it('limpia los listeners externos al completar con exito', async () => {
    configureGoogle();
    const controller = new AbortController();
    const addEventListener = vi.spyOn(controller.signal, 'addEventListener');
    const removeEventListener = vi.spyOn(controller.signal, 'removeEventListener');
    const mockGenerateContent = new GoogleGenAI({ apiKey: 'fake-google-key' }).models.generateContent as unknown as ReturnType<typeof vi.fn>;
    mockGenerateContent.mockResolvedValue({ text: JSON.stringify({
      immediate_joke: 'joke', single_visual_focus: 'focus', familiar_physical_situation: 'situation', post_connection: 'connection', requires_asset: false
    }) });

    await expect(performMemeAnalysis(input, { signal: controller.signal })).resolves.toMatchObject({ immediate_joke: 'joke' });
    expect(addEventListener).toHaveBeenCalledTimes(1);
    expect(removeEventListener).toHaveBeenCalledTimes(1);
  });

  it('no despacha Google cuando el deadline ya vencio antes de la solicitud', async () => {
    configureGoogle();
    vi.spyOn(Date, 'now').mockReturnValueOnce(100).mockReturnValueOnce(101);
    const mockGenerateContent = new GoogleGenAI({ apiKey: 'fake-google-key' }).models.generateContent as unknown as ReturnType<typeof vi.fn>;

    await expect(performMemeAnalysis(input, { timeoutMs: 0 })).rejects.toThrow('(phase: analysis, provider: google, status: 500)');
    expect(mockGenerateContent).not.toHaveBeenCalled();
  });

  it('normaliza el modo de texto a cero o una caption corta de hasta cinco palabras', () => {
    expect(normalizeMemeCaptions('no_text', ['THIS MUST DISAPPEAR'])).toEqual([]);
    const captions = normalizeMemeCaptions('short_text', ['  one   two three four five six seven  ', 'SECOND CAPTION']);
    expect(captions).toHaveLength(1);
    expect(captions[0].split(/\s+/)).toHaveLength(5);
    expect(captions[0].length).toBeLessThanOrEqual(25);
  });

  it('resuelve modelo configurado o default desde un unico contrato autoritativo', () => {
    vi.mocked(config.getConfig).mockReturnValue({ memeAnalysisModel: '' } as ReturnType<typeof config.getConfig>);
    expect(resolveMemeAnalysisModel()).toBe(DEFAULT_MEME_ANALYSIS_MODEL);
    vi.mocked(config.getConfig).mockReturnValue({ memeAnalysisModel: 'configured-analysis-model' } as ReturnType<typeof config.getConfig>);
    expect(resolveMemeAnalysisModel()).toBe('configured-analysis-model');
  });

  it('usa GoogleGenAI con la clave configurada y retorna el análisis parseado', async () => {
    vi.mocked(config.getConfig).mockReturnValue({
      databaseUrl: '', appBaseUrl: '', openaiApiKey: '', openaiModel: '', deepseekApiKey: '', deepseekBaseUrl: '', dashscopeApiKey: '', qwenBaseUrl: '',
      googleAiApiKey: 'fake-google-key', xBearerToken: '', adminPasswordHash: '', adminSessionSecret: '', visitorCookieSecret: '', securityHmacSecret: '', internalProcessSecret: '', cronSecret: '',
      memeAnalysisModel: 'gemini-3.1-flash-lite', memeValidationModel: ''
    });

    const genAiInstance = new GoogleGenAI({ apiKey: 'fake-google-key' });
    const mockGenerateContent = genAiInstance.models.generateContent as unknown as ReturnType<typeof vi.fn>;

    mockGenerateContent.mockResolvedValue({
      text: JSON.stringify({
        immediate_joke: 'test joke',
        single_visual_focus: 'test focus',
        familiar_physical_situation: 'test situation',
        post_connection: 'reacts to the post',
        requires_asset: false
      })
    });

    const result = await performMemeAnalysis({
      postText: 'test post',
      campaignDirection: 'test direction',
      availableAssets: []
    });

    expect(result.immediate_joke).toBe('test joke');
    expect(mockGenerateContent).toHaveBeenCalledWith({
      model: 'gemini-3.1-flash-lite',
      contents: expect.stringContaining('test post'),
      config: expect.objectContaining({
        responseMimeType: 'application/json'
      })
    });
  });

  it('requires structured entity evidence and gives the selected brand context to the analysis', async () => {
    vi.mocked(config.getConfig).mockReturnValue({
      databaseUrl: '', appBaseUrl: '', openaiApiKey: '', openaiModel: '', deepseekApiKey: '', deepseekBaseUrl: '', dashscopeApiKey: '', qwenBaseUrl: '',
      googleAiApiKey: 'fake-google-key', xBearerToken: '', adminPasswordHash: '', adminSessionSecret: '', visitorCookieSecret: '', securityHmacSecret: '', internalProcessSecret: '', cronSecret: '',
      memeAnalysisModel: 'gemini-3.1-flash-lite', memeValidationModel: ''
    });
    const genAiInstance = new GoogleGenAI({ apiKey: 'fake-google-key' });
    const mockGenerateContent = genAiInstance.models.generateContent as unknown as ReturnType<typeof vi.fn>;
    mockGenerateContent.mockResolvedValue({
      text: JSON.stringify({
        immediate_joke: 'test joke',
        single_visual_focus: 'test focus',
        familiar_physical_situation: 'test situation',
        post_connection: 'reacts to the post',
        requires_asset: false,
        entityEvidence: {
          postJustification: 'The post names the launch delay.',
          externalLogoIntent: true
        }
      })
    });

    await expect(performMemeAnalysis({
      postText: 'test post', campaignDirection: 'test direction', availableAssets: [], brandContext: 'GenieOrb'
    })).resolves.toMatchObject({
      entityEvidence: { postJustification: 'The post names the launch delay.', externalLogoIntent: true }
    });
    expect(mockGenerateContent).toHaveBeenCalledWith(expect.objectContaining({
      config: expect.objectContaining({ systemInstruction: expect.stringContaining('GenieOrb') })
    }));
  });

  it('transporta la guia visual completa, el rol de marca y normaliza la respuesta postparse', async () => {
    vi.mocked(config.getConfig).mockReturnValue({
      databaseUrl: '', appBaseUrl: '', openaiApiKey: '', openaiModel: '', deepseekApiKey: '', deepseekBaseUrl: '', dashscopeApiKey: '', qwenBaseUrl: '',
      googleAiApiKey: 'fake-google-key', xBearerToken: '', adminPasswordHash: '', adminSessionSecret: '', visitorCookieSecret: '', securityHmacSecret: '', internalProcessSecret: '', cronSecret: '',
      memeAnalysisModel: 'gemini-3.1-flash-lite', memeValidationModel: ''
    });
    const guidance = {
      purpose: 'purpose-full', mechanism: 'mechanism-full', panelRoles: ['inferior', 'promoted'],
      promotedBrandRole: 'brand-role-full', inferiorAlternativeRole: 'alternative-role-full',
      textModes: ['NO_TEXT', 'ONE_CAPTION'], captionPosition: 'caption-position-full',
      emotion: ['emotion-full'], compatibility: ['compatibility-full'], useWhen: ['use-full'], rejectWhen: ['reject-full'],
      visualInstruction: 'visual-instruction-full', avoid: ['avoid-full'], validation: ['validation-full'],
    };
    const genAiInstance = new GoogleGenAI({ apiKey: 'fake-google-key' });
    const mockGenerateContent = genAiInstance.models.generateContent as unknown as ReturnType<typeof vi.fn>;
    mockGenerateContent.mockResolvedValue({ text: JSON.stringify({
      captions: ['one two three four five six', 'discard me'], immediate_joke: 'joke', single_visual_focus: 'focus',
      familiar_physical_situation: 'situation', post_connection: 'connection', requires_asset: false,
    }) });

    const result = await performMemeAnalysis({
      postText: 'post', campaignDirection: 'direction', availableAssets: [], brandContext: 'Promoted Brand', textQuantity: 'short_text',
      templates: [{ id: 'template-v2', name: 'Template V2', layout: 'split', zones: ['left', 'right'], guidance }],
    });

    expect(result.captions).toEqual(['one two three four five']);
    const instruction = mockGenerateContent.mock.calls[0][0].config.systemInstruction as string;
    expect(instruction).toContain('Promoted Brand');
    for (const value of ['purpose-full', 'mechanism-full', 'brand-role-full', 'alternative-role-full', 'caption-position-full', 'emotion-full', 'compatibility-full', 'use-full', 'reject-full', 'visual-instruction-full', 'avoid-full', 'validation-full']) {
      expect(instruction).toContain(value);
    }
  });

  it('requires up to two canonical entities and instructs the analysis to use only canonical names', async () => {
    vi.mocked(config.getConfig).mockReturnValue({
      databaseUrl: '', appBaseUrl: '', openaiApiKey: '', openaiModel: '', deepseekApiKey: '', deepseekBaseUrl: '', dashscopeApiKey: '', qwenBaseUrl: '',
      googleAiApiKey: 'fake-google-key', xBearerToken: '', adminPasswordHash: '', adminSessionSecret: '', visitorCookieSecret: '', securityHmacSecret: '', internalProcessSecret: '', cronSecret: '',
      memeAnalysisModel: 'gemini-3.1-flash-lite', memeValidationModel: ''
    });
    const genAiInstance = new GoogleGenAI({ apiKey: 'fake-google-key' });
    const mockGenerateContent = genAiInstance.models.generateContent as unknown as ReturnType<typeof vi.fn>;
    mockGenerateContent.mockResolvedValue({ text: JSON.stringify({
      immediate_joke: 'test joke', single_visual_focus: 'test focus', familiar_physical_situation: 'test situation', post_connection: 'reacts to the post', requires_asset: false,
      entityEvidence: { postJustification: 'The post names both companies.', externalLogoIntent: true }, canonicalEntities: ['OpenAI', 'Google']
    }) });

    await expect(performMemeAnalysis({ postText: 'test post', campaignDirection: 'test direction', availableAssets: [] })).resolves.toMatchObject({ canonicalEntities: ['OpenAI', 'Google'] });
    const request = mockGenerateContent.mock.calls[0][0];
    expect(request.config.systemInstruction).toContain('canonicalEntities');
    expect(request.config.responseSchema.properties.canonicalEntities).toEqual(expect.objectContaining({ maxItems: 2 }));
  });

  it('sanitiza los errores de GoogleGenAI', async () => {
    vi.mocked(config.getConfig).mockReturnValue({
      databaseUrl: '', appBaseUrl: '', openaiApiKey: '', openaiModel: '', deepseekApiKey: '', deepseekBaseUrl: '', dashscopeApiKey: '', qwenBaseUrl: '',
      googleAiApiKey: 'fake-google-key', xBearerToken: '', adminPasswordHash: '', adminSessionSecret: '', visitorCookieSecret: '', securityHmacSecret: '', internalProcessSecret: '', cronSecret: '',
      memeAnalysisModel: 'gemini-3.1-flash-lite', memeValidationModel: ''
    });

    const genAiInstance = new GoogleGenAI({ apiKey: 'fake-google-key' });
    const mockGenerateContent = genAiInstance.models.generateContent as unknown as ReturnType<typeof vi.fn>;

    mockGenerateContent.mockRejectedValue({ status: 403 });

    await expect(performMemeAnalysis({
      postText: 'test post',
      campaignDirection: 'test direction',
      availableAssets: []
    })).rejects.toThrow('No se pudo analizar el contenido con gemini-3.1-flash-lite: acceso denegado. (phase: analysis, provider: google, status: 403)');
  });
});
