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
        a_quien_va_dirigido: 'test',
        conflicto_o_contradiccion: 'test',
        escena_representada: 'test',
        como_se_relaciona_la_imagen_con_el_post_y_la_direccion: 'test',
        nucleo_del_chiste: 'test core joke',
        disparador_emocional: 'test',
        arquetipo_de_meme_mas_adecuado: 'test',
        que_elemento_visual_debe_ser_el_foco_principal: 'test',
        riesgos_de_sobrecarga_o_de_que_el_meme_necesite_demasiada_explicacion: 'test',
        requires_asset: false
      })
    });

    const result = await performMemeAnalysis({
      postText: 'test post',
      campaignDirection: 'test direction',
      availableAssets: []
    });

    expect(result.nucleo_del_chiste).toBe('test core joke');
    expect(mockGenerateContent).toHaveBeenCalledWith({
      model: 'gemini-3.1-flash-lite',
      contents: expect.stringContaining('test post'),
      config: expect.objectContaining({
        responseMimeType: 'application/json'
      })
    });
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
