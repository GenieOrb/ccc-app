import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GET } from './route';
import { IMAGE_MODELS } from '@/lib/ai/image-models';
import * as auth from '@/lib/auth';
import * as config from '@/lib/config';

vi.mock('@/lib/auth');
vi.mock('@/lib/config');

describe('GET /api/admin/image-models', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(auth.isAdminAuthenticated).mockResolvedValue(true);
  });

  it('habilita ambos modelos Gemini si GOOGLE_AI_API_KEY existe, y verifica que apiModel coincide con key', async () => {
    vi.mocked(config.getConfig).mockReturnValue({
      databaseUrl: '', appBaseUrl: '', openaiApiKey: '', openaiModel: '', deepseekApiKey: '', deepseekBaseUrl: '', dashscopeApiKey: '', qwenBaseUrl: '',
      googleAiApiKey: 'fake-google-key', xBearerToken: '', adminPasswordHash: '', adminSessionSecret: '', visitorCookieSecret: '', securityHmacSecret: '', internalProcessSecret: '', cronSecret: ''
    });

    const res = await GET();
    const data = await res.json();
    
    expect(res.status).toBe(200);
    expect(data.models).toBeDefined();

    // The key never gets returned in the JSON!
    expect(JSON.stringify(data)).not.toContain('fake-google-key');

    const flash = data.models.find((m: { key: string; configured: boolean; }) => m.key === 'gemini-3.1-flash-image');
    const flashLite = data.models.find((m: { key: string; configured: boolean; }) => m.key === 'gemini-3.1-flash-lite-image');

    expect(flash).toBeDefined();
    expect(flash.configured).toBe(true);
    expect(IMAGE_MODELS[flash.key].apiModel).toBe(flash.key);
    
    expect(flashLite).toBeDefined();
    expect(flashLite.configured).toBe(true);
    expect(IMAGE_MODELS[flashLite.key].apiModel).toBe(flashLite.key);
  });

  it('aparecen como no configurados si GOOGLE_AI_API_KEY no existe', async () => {
    vi.mocked(config.getConfig).mockReturnValue({
      databaseUrl: '', appBaseUrl: '', openaiApiKey: '', openaiModel: '', deepseekApiKey: '', deepseekBaseUrl: '', dashscopeApiKey: '', qwenBaseUrl: '',
      googleAiApiKey: '', xBearerToken: '', adminPasswordHash: '', adminSessionSecret: '', visitorCookieSecret: '', securityHmacSecret: '', internalProcessSecret: '', cronSecret: ''
    });

    const res = await GET();
    const data = await res.json();
    
    const flash = data.models.find((m: { key: string; configured: boolean; }) => m.key === 'gemini-3.1-flash-image');
    expect(flash.configured).toBe(false);
  });

  it('habilita gpt-image-2 si OPENAI_API_KEY existe, sin confirmar acceso', async () => {
    vi.mocked(config.getConfig).mockReturnValue({
      databaseUrl: '', appBaseUrl: '', openaiApiKey: 'fake-openai', openaiModel: '', deepseekApiKey: '', deepseekBaseUrl: '', dashscopeApiKey: '', qwenBaseUrl: '',
      googleAiApiKey: '', xBearerToken: '', adminPasswordHash: '', adminSessionSecret: '', visitorCookieSecret: '', securityHmacSecret: '', internalProcessSecret: '', cronSecret: ''
    });

    const res = await GET();
    const data = await res.json();
    
    const gpt2 = data.models.find((m: { key: string; configured: boolean; }) => m.key === 'gpt-image-2');
    expect(gpt2.configured).toBe(true);
  });
});
