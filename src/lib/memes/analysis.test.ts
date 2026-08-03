import { describe, it, expect, vi, beforeEach } from 'vitest';
import { performMemeAnalysis } from './analysis';
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
