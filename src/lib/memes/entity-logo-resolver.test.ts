import { describe, expect, it, vi } from 'vitest';

vi.mock('simple-icons', () => ({
  siGoogleGemini: { title: 'Google Gemini', slug: 'googlegemini', path: 'M0 0h24v24H0z', hex: '000000' },
  siGoogle: { title: 'Google', slug: 'google', path: 'M1 1h22v22H1z', hex: '4285F4' },
  siUnrelated: { title: 'Unrelated', slug: 'unrelated', path: 'M2 2h20v20H2z', hex: 'FFFFFF' },
}));

import { resolveEntityLogos } from './entity-logo-resolver';

describe('resolveEntityLogos', () => {
  it('resolves only entities with explicit intent and literal post evidence, allowing an unambiguous local title from structured evidence', () => {
    const logos = resolveEntityLogos({
      postText: 'Gemini just changed the way our team writes release notes.',
      externalLogoIntent: true,
      entityEvidence: [
        { canonicalEntity: 'Gemini', postJustification: 'Gemini' },
        { canonicalEntity: 'Google', postJustification: 'release notes' },
        { canonicalEntity: 'Unrelated', postJustification: 'team' },
      ],
    });

    expect(logos.map((logo) => [logo.entity, logo.slug])).toEqual([
      ['Google', 'google'],
      ['Google Gemini', 'googlegemini'],
    ]);
    expect(logos.every((logo) => logo.svg.startsWith('<svg'))).toBe(true);
  });

  it('rejects absent evidence, false intent, missing post text, empty justification, and partial-substring justifications without fetching', () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    expect(resolveEntityLogos({ postText: 'Gemini', externalLogoIntent: false, entityEvidence: [{ canonicalEntity: 'Gemini', postJustification: 'Gemini' }] })).toEqual([]);
    expect(resolveEntityLogos({ postText: '', externalLogoIntent: true, entityEvidence: [{ canonicalEntity: 'Gemini', postJustification: 'Gemini' }] })).toEqual([]);
    expect(resolveEntityLogos({ postText: 'Gemini', externalLogoIntent: true, entityEvidence: [] })).toEqual([]);
    expect(resolveEntityLogos({ postText: 'Gemini', externalLogoIntent: true, entityEvidence: [{ canonicalEntity: 'Gemini', postJustification: '  ' }] })).toEqual([]);
    expect(resolveEntityLogos({ postText: 'GoogleGemini', externalLogoIntent: true, entityEvidence: [{ canonicalEntity: 'Gemini', postJustification: 'Gemini' }] })).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it('caps qualified local logos at two', () => {
    expect(resolveEntityLogos({
      postText: 'Gemini, Google and Unrelated are all mentioned.',
      externalLogoIntent: true,
      entityEvidence: [
        { canonicalEntity: 'Gemini', postJustification: 'Gemini' },
        { canonicalEntity: 'Google', postJustification: 'Google' },
        { canonicalEntity: 'Unrelated', postJustification: 'Unrelated' },
      ],
    })).toHaveLength(2);
  });
});
