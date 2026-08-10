import { access } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ACTIVE_MEME_TEMPLATES, MEME_TEMPLATES, getMemeTemplate, getMemeTemplatesForProvider, renderMemeTemplate, resolveMemeTemplateSelection } from './templates';

const V2_IDS = [
  'switching_preference_3subjects',
  'basic_vs_premium_2panel',
  'progressive_superiority_4stage',
  'ignore_vs_attention_2panel',
  'sudden_exit_better_alternative',
  'chaotic_fan_vs_calm_enjoyer',
  'refuse_easy_option_accept_burden',
  'off_vs_on_transformation',
  'high_stress_vs_low_stress',
  'fast_challenger_gaining_ground',
] as const;

describe('meme template catalog', () => {
  it('ships the ten editable V2 visual contracts with local references', async () => {
    expect(MEME_TEMPLATES).toHaveLength(10);
    expect(ACTIVE_MEME_TEMPLATES).toHaveLength(10);
    expect(MEME_TEMPLATES.map((template) => template.id)).toEqual(V2_IDS);
    expect(MEME_TEMPLATES.some((template) => template.id.includes('classic') || template.id.includes('008'))).toBe(false);
    expect(MEME_TEMPLATES.every((template) => template.path.startsWith('/meme-templates-v2/'))).toBe(true);
    await Promise.all(MEME_TEMPLATES.map((template) => access(path.join(process.cwd(), 'public', template.path))));

    for (const template of MEME_TEMPLATES) {
      expect(template.providers.length).toBeGreaterThan(0);
      expect(template.guidance).toMatchObject({
        purpose: expect.any(String),
        mechanism: expect.any(String),
        panelRoles: expect.any(Array),
        promotedBrandRole: expect.any(String),
        inferiorAlternativeRole: expect.any(String),
        textModes: expect.arrayContaining(['NO_TEXT', 'ONE_CAPTION']),
        captionPosition: expect.any(String),
        emotion: expect.any(Array),
        compatibility: expect.any(Array),
        useWhen: expect.any(Array),
        rejectWhen: expect.any(Array),
        visualInstruction: expect.any(String),
        avoid: expect.any(Array),
        validation: expect.any(Array),
      });
      expect(template.guidance.purpose).not.toMatch(/genieorb/i);
      expect(template.guidance.visualInstruction).not.toMatch(/genieorb/i);
    }

    expect(getMemeTemplatesForProvider('openai').map((template) => template.id)).toEqual(expect.arrayContaining([
      'progressive_superiority_4stage', 'off_vs_on_transformation',
    ]));
    expect(getMemeTemplatesForProvider('google').map((template) => template.id)).toEqual(expect.arrayContaining([
      'switching_preference_3subjects', 'fast_challenger_gaining_ground',
    ]));
    expect(getMemeTemplate('classic-01', 1)).toEqual(MEME_TEMPLATES[0]);
    const switching = getMemeTemplate('switching_preference_3subjects', 1);
    const transformation = getMemeTemplate('off_vs_on_transformation', 1);
    expect(resolveMemeTemplateSelection('basic_vs_premium_2panel', switching.id, 1)).toEqual(switching);
    expect(switching.providers).not.toContain('openai');
    expect(transformation.providers).toContain('openai');
    expect(resolveMemeTemplateSelection(switching.id, transformation.id, 1)).toEqual(transformation);

    const refusal = getMemeTemplate('refuse_easy_option_accept_burden', 1).guidance;
    expect(`${refusal.purpose} ${refusal.mechanism} ${refusal.promotedBrandRole}`).toMatch(/absurd.*reject.*promoted.*easy solution.*favor/i);
    expect(refusal.inferiorAlternativeRole).toMatch(/inferior alternative.*burden/i);
    expect(JSON.stringify(switching.guidance)).not.toMatch(/[\u2019Ãâ]/u);
    const rendered = await renderMemeTemplate('switching_preference_3subjects', 1, ['choose better']);
    expect(rendered.mimeType).toBe('image/png');
    expect(rendered.imageBuffer.length).toBeGreaterThan(1000);
  });
});
