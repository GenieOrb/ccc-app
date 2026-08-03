import 'server-only';
import * as simpleIcons from 'simple-icons';

export interface ResolvedEntityLogo {
  entity: string;
  slug: string;
  svg: string;
}

export interface EntityLogoEvidence {
  canonicalEntity: string;
  postJustification: string;
}

export interface EntityLogoResolutionInput {
  postText: string;
  externalLogoIntent: boolean;
  entityEvidence: readonly EntityLogoEvidence[];
}

type LocalSimpleIcon = { title: string; slug: string; path: string; hex: string };

function isSimpleIcon(value: unknown): value is LocalSimpleIcon {
  return !!value
    && typeof value === 'object'
    && typeof (value as LocalSimpleIcon).title === 'string'
    && typeof (value as LocalSimpleIcon).slug === 'string'
    && typeof (value as LocalSimpleIcon).path === 'string'
    && typeof (value as LocalSimpleIcon).hex === 'string';
}

function toSvg(icon: LocalSimpleIcon): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path fill="#${icon.hex}" d="${icon.path}"/></svg>`;
}

function hasWholeWord(value: string, word: string): boolean {
  return new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(word)}(?![\\p{L}\\p{N}])`, 'iu').test(value);
}

/** Resolves exact local titles, or a uniquely matching local title for a canonical entity. */
export function resolveCanonicalEntityLogos(canonicalEntities: readonly string[]): ResolvedEntityLogo[] {
  const requested = [...new Set(canonicalEntities.map((entity) => entity.trim().normalize('NFKC')).filter(Boolean))];
  if (requested.length === 0) return [];

  const icons = Object.values(simpleIcons)
    .reduce<LocalSimpleIcon[]>((installed, value) => {
      if (isSimpleIcon(value)) installed.push(value);
      return installed;
    }, [])
    .sort((a, b) => a.title.localeCompare(b.title));

  return requested
    .flatMap((entity) => {
      const exact = icons.find((icon) => icon.title.normalize('NFKC') === entity);
      if (exact) return [{ entity: exact.title, slug: exact.slug, svg: toSvg(exact) }];

      const matches = icons.filter((icon) => hasWholeWord(icon.title.normalize('NFKC'), entity));
      return matches.length === 1
        ? [{ entity: matches[0].title, slug: matches[0].slug, svg: toSvg(matches[0]) }]
        : [];
    })
    .sort((a, b) => a.entity.localeCompare(b.entity));
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function hasWholeWordPostEvidence(postText: string, justification: string): boolean {
  const normalizedPostText = postText.normalize('NFKC');
  const normalizedJustification = justification.trim().normalize('NFKC');
  if (!normalizedPostText || !normalizedJustification) return false;
  return hasWholeWord(normalizedPostText, normalizedJustification);
}

/** Resolves at most two locally installed icons backed by explicit model evidence in the post. */
export function resolveEntityLogos(input: EntityLogoResolutionInput): ResolvedEntityLogo[] {
  if (!input.externalLogoIntent || !input.postText) return [];

  const qualifiedCanonicalEntities = input.entityEvidence
    .filter((evidence) => evidence.canonicalEntity.trim() && hasWholeWordPostEvidence(input.postText, evidence.postJustification))
    .map((evidence) => evidence.canonicalEntity.trim().normalize('NFKC'));

  return resolveCanonicalEntityLogos(qualifiedCanonicalEntities).slice(0, 2);
}
