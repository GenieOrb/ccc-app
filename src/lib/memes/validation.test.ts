import { describe, it, expect, vi, beforeEach } from 'vitest';
import { validateMemeImage } from './validation';
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

describe('validateMemeImage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('usa GoogleGenAI con la clave configurada y retorna validación', async () => {
    vi.mocked(config.getConfig).mockReturnValue({
      databaseUrl: '', appBaseUrl: '', openaiApiKey: '', openaiModel: '', deepseekApiKey: '', deepseekBaseUrl: '', dashscopeApiKey: '', qwenBaseUrl: '',
      googleAiApiKey: 'fake-google-key', xBearerToken: '', adminPasswordHash: '', adminSessionSecret: '', visitorCookieSecret: '', securityHmacSecret: '', internalProcessSecret: '', cronSecret: '',
      memeAnalysisModel: '', memeValidationModel: 'gemini-3.1-flash-lite'
    });

    const genAiInstance = new GoogleGenAI({ apiKey: 'fake-google-key' });
    const mockGenerateContent = genAiInstance.models.generateContent as unknown as ReturnType<typeof vi.fn>;

    mockGenerateContent.mockResolvedValue({
      text: JSON.stringify({
        is_valid: true,
        reason: 'Looks good'
      })
    });

    const result = await validateMemeImage(
      Buffer.from('fake image'),
      'image/jpeg',
      { format: 'square', tone: 'humorous' },
      'test direction'
    );

    expect(result.is_valid).toBe(true);
    expect(result.reason).toBe('Looks good');
    expect(mockGenerateContent).toHaveBeenCalledWith({
      model: 'gemini-3.1-flash-lite',
      contents: expect.arrayContaining([
        expect.objectContaining({
          role: 'user',
          parts: expect.arrayContaining([
            expect.objectContaining({ text: 'Verifica esta imagen generada.' }),
            expect.objectContaining({ inlineData: { data: expect.any(String), mimeType: 'image/jpeg' } })
          ])
        })
      ]),
      config: expect.objectContaining({
        responseMimeType: 'application/json'
      })
    });
  });
});
