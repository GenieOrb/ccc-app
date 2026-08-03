import { describe, it, expect, vi, beforeEach } from 'vitest';
import { generateMemeImage } from './generation';
import * as config from '@/lib/config';
import { GoogleGenAI } from '@google/genai';

vi.mock('@/lib/config');

// Mock GoogleGenAI properly
vi.mock('@google/genai', () => {
  const mockGenerateContent = vi.fn();
  const mockModels = {
    generateContent: mockGenerateContent,
    generateImages: vi.fn(),
  };
  return {
    GoogleGenAI: class {
      models = mockModels;
    }
  };
});

describe('generateMemeImage (Gemini adapter)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('usa generateContent en lugar de generateImages y devuelve la imagen correctamente', async () => {
    vi.mocked(config.getConfig).mockReturnValue({
      databaseUrl: '', appBaseUrl: '', openaiApiKey: '', openaiModel: '', deepseekApiKey: '', deepseekBaseUrl: '', dashscopeApiKey: '', qwenBaseUrl: '',
      googleAiApiKey: 'valid-key', xBearerToken: '', adminPasswordHash: '', adminSessionSecret: '', visitorCookieSecret: '', securityHmacSecret: '', internalProcessSecret: '', cronSecret: ''
    });

    // We can get the instance of the mock
    const genAiInstance = new GoogleGenAI({ apiKey: 'valid-key' });
    const mockGenerateContent = genAiInstance.models.generateContent as unknown as ReturnType<typeof vi.fn>;
    
    mockGenerateContent.mockResolvedValue({
      candidates: [
        {
          content: {
            parts: [
              { inlineData: { data: 'YmFzZTY0dGVzdA==', mimeType: 'image/jpeg' } }
            ]
          }
        }
      ]
    });

    const result = await generateMemeImage(
      { mechanism: 'Test', format: 'Test', tone: 'Test', requiresAsset: false },
      { concept: 'Test', suggested_text_top: null, suggested_text_bottom: null, visual_description: 'Test' },
      'gemini-3.1-flash-image'
    );

    expect(result.mimeType).toBe('image/jpeg');
    expect(result.imageBuffer.toString('base64')).toBe('YmFzZTY0dGVzdA==');
    expect(mockGenerateContent).toHaveBeenCalledWith({
      model: 'gemini-3.1-flash-image',
      contents: expect.arrayContaining([
        expect.objectContaining({ text: expect.any(String) })
      ])
    });
    // Check generateImages was NOT called
    expect(genAiInstance.models.generateImages).not.toHaveBeenCalled();
  });

  it('incluye la marca exacta y la relaciÃ³n obligatoria con el post en el prompt', async () => {
    vi.mocked(config.getConfig).mockReturnValue({
      databaseUrl: '', appBaseUrl: '', openaiApiKey: '', openaiModel: '', deepseekApiKey: '', deepseekBaseUrl: '', dashscopeApiKey: '', qwenBaseUrl: '',
      googleAiApiKey: 'valid-key', xBearerToken: '', adminPasswordHash: '', adminSessionSecret: '', visitorCookieSecret: '', securityHmacSecret: '', internalProcessSecret: '', cronSecret: '',
      memeAnalysisModel: '', memeValidationModel: ''
    });
    const genAiInstance = new GoogleGenAI({ apiKey: 'valid-key' });
    const mockGenerateContent = genAiInstance.models.generateContent as unknown as ReturnType<typeof vi.fn>;
    mockGenerateContent.mockResolvedValue({ candidates: [{ content: { parts: [{ inlineData: { data: 'aW1hZ2U=', mimeType: 'image/png' } }] } }] });

    await generateMemeImage(
      { textQuantity: 'short_text', visualStructure: 'single_scene', humorTone: 'subtle', sceneComplexity: 'simple', postRelationship: 'direct_reaction', requiresAsset: false, brandText: 'GenieOrb™' } as never,
      { immediate_joke: 'joke', single_visual_focus: 'focus', familiar_physical_situation: 'situation', post_connection: 'React to the post\'s delayed launch.', requires_asset: false },
      'gemini-3.1-flash-image'
    );

    const prompt = (mockGenerateContent.mock.calls[0][0].contents[0] as { text: string }).text;
    expect(prompt).toContain('GenieOrb™');
    expect(prompt).toContain("React to the post's delayed launch.");
    expect(prompt).toContain('direct_reaction');
  });
});
