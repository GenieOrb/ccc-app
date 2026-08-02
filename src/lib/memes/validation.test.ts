import { describe, it, expect, vi, beforeEach } from 'vitest';
import { validateMemeImage } from './validation';
import * as config from '../config';
import { GoogleGenAI } from '@google/genai';
import { MemeSlotPlan } from './planner';

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
        detected_word_count: 0,
        panel_count: 1,
        looks_like_infographic: false,
        clutter_score: 3,
        reason: 'Looks good'
      })
    });

    const plan: MemeSlotPlan = {
      plannerVersion: 2,
      seed: 'test',
      slotIndex: 0,
      textQuantity: 'short_text',
      visualStructure: 'single_scene',
      humorTone: 'subtle',
      postRelationship: 'direct_reaction',
      sceneComplexity: 'simple',
      requiresAsset: false,
      deliveryOrder: 0
    };

    const result = await validateMemeImage(
      Buffer.from('fake image'),
      'image/jpeg',
      plan,
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
            expect.objectContaining({ text: expect.stringContaining('Verifica esta imagen generada bajo las estrictas reglas de rechazo') }),
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
