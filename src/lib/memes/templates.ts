import 'server-only';

export interface MemeTemplatePromotedBrandZone {
  id: string;
  meaning: string;
  semanticFunction: string;
  instruction: string;
  allowedRepresentation: 'logo' | 'name' | 'logo_or_name';
  required: boolean;
}

export interface MemeTemplateCompetitorZone {
  id: string;
  characterOrElement: string;
  semanticMeaning: string;
  instruction: string;
  required: boolean;
  allowedRepresentation: 'logo' | 'name' | 'logo_or_name';
  priority: number;
  functionRelativeToOtherZones: string;
}

export interface MemeTemplateTextZone {
  id: string;
  templatePart: string;
  meaning: string;
  conceptToContain: string;
  required: boolean;
  canBeEmpty: boolean;
  maxWords: number | null;
  instruction: string;
  postRelation: string;
  brandOrCompetitorRelation: string;
}

export interface MemeTemplatePostInterpretationRules {
  explicitCompetitor: string;
  implicitCompetitor: string;
  collectiveCompetitor: string;
  noCompetitor: string;
}

export interface MemeTemplateMetadata {
  schemaVersion: number;
  status: 'draft' | 'ready';

  templateMeaning: string;
  intention: string;
  tone: string;
  generalInstruction: string;
  negativeInstruction: string;

  promotedBrandZones: MemeTemplatePromotedBrandZone[];
  competitorZones: MemeTemplateCompetitorZone[];

  textZoneCount: number | null;
  textZones: MemeTemplateTextZone[];

  postInterpretationRules: MemeTemplatePostInterpretationRules;

  additionalData: Record<string, unknown>;
}

export interface MemeTemplateDefinition {
  id: string;
  name: string;
  imageRef: string;
  metadata: MemeTemplateMetadata;
}

export interface MemeTemplatePostContext {
  postText: string;
  authorName: string;
  authorUsername: string;
  canonicalUrl: string;
  threadContext: string[];
  quotedPostText: string | null;
  explicitEntities: string[];
  implicitEntities: string[];
  collectiveGroups: string[];
  mainCompetitor: string | null;
  secondaryCompetitors: string[];
  hasIdentifiableCompetitor: boolean;
}

export function createInitialTemplateMetadata(): MemeTemplateMetadata {
  return {
    schemaVersion: 1,
    status: 'draft',
    templateMeaning: '',
    intention: '',
    tone: '',
    generalInstruction: '',
    negativeInstruction: '',
    promotedBrandZones: [],
    competitorZones: [],
    textZoneCount: null,
    textZones: [],
    postInterpretationRules: {
      explicitCompetitor: '',
      implicitCompetitor: '',
      collectiveCompetitor: '',
      noCompetitor: ''
    },
    additionalData: {}
  };
}

export const MEME_TEMPLATES: readonly MemeTemplateDefinition[] = Object.freeze([
  {
    id: 'drake',
    name: 'Drake',
    imageRef: 'memes/templates/drake.png',
    metadata: createInitialTemplateMetadata()
  },
  {
    id: 'distracted-boyfriend',
    name: 'Distracted Boyfriend',
    imageRef: 'memes/templates/distracted-boyfriend.png',
    metadata: createInitialTemplateMetadata()
  },
  {
    id: 'two-buttons',
    name: 'Two Buttons',
    imageRef: 'memes/templates/two-buttons.png',
    metadata: createInitialTemplateMetadata()
  },
  {
    id: 'change-my-mind',
    name: 'Change My Mind',
    imageRef: 'memes/templates/change-my-mind.png',
    metadata: createInitialTemplateMetadata()
  },
  {
    id: 'expanding-brain',
    name: 'Expanding Brain',
    imageRef: 'memes/templates/expanding-brain.png',
    metadata: createInitialTemplateMetadata()
  },
  {
    id: 'woman-yelling-at-cat',
    name: 'Woman Yelling at a Cat',
    imageRef: 'memes/templates/woman-yelling-at-cat.png',
    metadata: createInitialTemplateMetadata()
  },
  {
    id: 'roll-safe',
    name: 'Roll Safe',
    imageRef: 'memes/templates/roll-safe.png',
    metadata: createInitialTemplateMetadata()
  },
  {
    id: 'disaster-girl',
    name: 'Disaster Girl',
    imageRef: 'memes/templates/disaster-girl.png',
    metadata: createInitialTemplateMetadata()
  },
  {
    id: 'success-kid',
    name: 'Success Kid',
    imageRef: 'memes/templates/success-kid.png',
    metadata: createInitialTemplateMetadata()
  },
  {
    id: 'bernie-sitting',
    name: 'Bernie Sitting',
    imageRef: 'memes/templates/bernie-sitting.png',
    metadata: createInitialTemplateMetadata()
  },
  {
    id: 'one-does-not-simply',
    name: 'One Does Not Simply',
    imageRef: 'memes/templates/one-does-not-simply.png',
    metadata: createInitialTemplateMetadata()
  },
  {
    id: 'trade-offer',
    name: 'Trade Offer',
    imageRef: 'memes/templates/trade-offer.png',
    metadata: createInitialTemplateMetadata()
  },
  {
    id: 'grus-plan',
    name: 'Gru\'s Plan',
    imageRef: 'memes/templates/grus-plan.png',
    metadata: createInitialTemplateMetadata()
  },
  {
    id: 'left-exit-12',
    name: 'Left Exit 12 Off Ramp',
    imageRef: 'memes/templates/left-exit-12.png',
    metadata: createInitialTemplateMetadata()
  },
  {
    id: 'is-this-a-pigeon',
    name: 'Is This a Pigeon?',
    imageRef: 'memes/templates/is-this-a-pigeon.png',
    metadata: createInitialTemplateMetadata()
  },
  {
    id: 'panik-kalm-panik',
    name: 'Panik Kalm Panik',
    imageRef: 'memes/templates/panik-kalm-panik.png',
    metadata: createInitialTemplateMetadata()
  },
  {
    id: 'buff-doge-vs-cheems',
    name: 'Buff Doge vs Cheems',
    imageRef: 'memes/templates/buff-doge-vs-cheems.png',
    metadata: createInitialTemplateMetadata()
  },
  {
    id: 'spiderman-pointing',
    name: 'Spider-Man Pointing at Spider-Man',
    imageRef: 'memes/templates/spiderman-pointing.png',
    metadata: createInitialTemplateMetadata()
  },
  {
    id: 'batman-slapping-robin',
    name: 'Batman Slapping Robin',
    imageRef: 'memes/templates/batman-slapping-robin.png',
    metadata: createInitialTemplateMetadata()
  },
  {
    id: 'guy-looking-back',
    name: 'Guy Looking Back',
    imageRef: 'memes/templates/guy-looking-back.png',
    metadata: createInitialTemplateMetadata()
  },
  {
    id: 'same-picture',
    name: 'They\'re The Same Picture',
    imageRef: 'memes/templates/same-picture.png',
    metadata: createInitialTemplateMetadata()
  },
  {
    id: 'epic-handshake',
    name: 'Epic Handshake',
    imageRef: 'memes/templates/epic-handshake.png',
    metadata: createInitialTemplateMetadata()
  },
  {
    id: 'mocking-spongebob',
    name: 'Mocking Spongebob',
    imageRef: 'memes/templates/mocking-spongebob.png',
    metadata: createInitialTemplateMetadata()
  },
  {
    id: 'waiting-skeleton',
    name: 'Waiting Skeleton',
    imageRef: 'memes/templates/waiting-skeleton.png',
    metadata: createInitialTemplateMetadata()
  },
  {
    id: 'brain-before-sleep',
    name: 'Brain Before Sleep',
    imageRef: 'memes/templates/brain-before-sleep.png',
    metadata: createInitialTemplateMetadata()
  },
  {
    id: 'boardroom-suggestion',
    name: 'Boardroom Suggestion',
    imageRef: 'memes/templates/boardroom-suggestion.png',
    metadata: createInitialTemplateMetadata()
  },
  {
    id: 'grim-reaper-knocking',
    name: 'Grim Reaper Knocking Door',
    imageRef: 'memes/templates/grim-reaper-knocking.png',
    metadata: createInitialTemplateMetadata()
  },
  {
    id: 'running-away-balloon',
    name: 'Running Away Balloon',
    imageRef: 'memes/templates/running-away-balloon.png',
    metadata: createInitialTemplateMetadata()
  },
  {
    id: 'car-swerving',
    name: 'Car Swerving',
    imageRef: 'memes/templates/car-swerving.png',
    metadata: createInitialTemplateMetadata()
  },
  {
    id: 'always-has-been',
    name: 'Always Has Been',
    imageRef: 'memes/templates/always-has-been.png',
    metadata: createInitialTemplateMetadata()
  }
]);

export function buildMemeTemplatePostContext(storedPost: {
  xPostId: string;
  postText: string;
  authorName?: string;
  authorUsername?: string;
  accessibleContext?: Record<string, unknown>;
}): MemeTemplatePostContext {
  const contextObj = storedPost.accessibleContext || {};
  const threadContext = Array.isArray(contextObj.threadContext)
    ? contextObj.threadContext.map(String)
    : Array.isArray(contextObj.parents)
    ? contextObj.parents.map((p: unknown) => typeof p === 'object' && p !== null && 'text' in p ? String((p as { text: unknown }).text) : String(p))
    : [];

  const quotedPostText = typeof contextObj.quotedPostText === 'string'
    ? contextObj.quotedPostText
    : typeof contextObj.quoted_text === 'string'
    ? contextObj.quoted_text
    : null;

  const explicitEntities = Array.isArray(contextObj.explicitEntities)
    ? contextObj.explicitEntities.map(String)
    : [];

  const implicitEntities = Array.isArray(contextObj.implicitEntities)
    ? contextObj.implicitEntities.map(String)
    : [];

  const collectiveGroups = Array.isArray(contextObj.collectiveGroups)
    ? contextObj.collectiveGroups.map(String)
    : [];

  const mainCompetitor = typeof contextObj.mainCompetitor === 'string'
    ? contextObj.mainCompetitor
    : explicitEntities[0] || implicitEntities[0] || null;

  const secondaryCompetitors = Array.isArray(contextObj.secondaryCompetitors)
    ? contextObj.secondaryCompetitors.map(String)
    : explicitEntities.slice(1);

  return {
    postText: storedPost.postText || '',
    authorName: storedPost.authorName || '',
    authorUsername: storedPost.authorUsername || '',
    canonicalUrl: `https://x.com/${storedPost.authorUsername || 'i'}/status/${storedPost.xPostId}`,
    threadContext,
    quotedPostText,
    explicitEntities,
    implicitEntities,
    collectiveGroups,
    mainCompetitor,
    secondaryCompetitors,
    hasIdentifiableCompetitor: Boolean(mainCompetitor || secondaryCompetitors.length > 0 || collectiveGroups.length > 0)
  };
}

export function validateMemeTemplateMetadata(
  metadata: MemeTemplateMetadata,
  options?: { hasVisualRef?: boolean }
): { isValid: boolean; errors: string[] } {
  const errors: string[] = [];

  if (options?.hasVisualRef === false) {
    errors.push('Falta la referencia visual o imagen de la plantilla.');
  }

  if (metadata.status === 'draft') {
    return { isValid: errors.length === 0, errors };
  }

  if (metadata.status !== 'ready') {
    errors.push(`Estado inválido: ${metadata.status}`);
    return { isValid: false, errors };
  }

  if (!metadata.templateMeaning || metadata.templateMeaning.trim().length === 0) {
    errors.push('templateMeaning no puede estar vacío en estado ready.');
  }
  if (!metadata.intention || metadata.intention.trim().length === 0) {
    errors.push('intention no puede estar vacío en estado ready.');
  }
  if (!metadata.tone || metadata.tone.trim().length === 0) {
    errors.push('tone no puede estar vacío en estado ready.');
  }
  if (!metadata.generalInstruction || metadata.generalInstruction.trim().length === 0) {
    errors.push('generalInstruction no puede estar vacío en estado ready.');
  }

  if (!metadata.promotedBrandZones || metadata.promotedBrandZones.length === 0) {
    errors.push('Una ficha ready debe tener al menos una zona para la marca promocionada.');
  } else {
    const hasRequiredBrandZone = metadata.promotedBrandZones.some(z => z.required);
    if (!hasRequiredBrandZone) {
      errors.push('Una ficha ready debe tener al menos una zona obligatoria para la marca promocionada.');
    }
  }

  const allZoneIds = new Set<string>();
  
  for (const zone of metadata.promotedBrandZones || []) {
    if (allZoneIds.has(zone.id)) {
      errors.push(`Identificador de zona duplicado: ${zone.id}`);
    }
    allZoneIds.add(zone.id);

    const validReps = ['logo', 'name', 'logo_or_name'];
    if (!validReps.includes(zone.allowedRepresentation as string)) {
      errors.push(`Representación de marca promocionada no válida: ${zone.allowedRepresentation}`);
    }
  }

  for (const zone of metadata.competitorZones || []) {
    if (allZoneIds.has(zone.id)) {
      errors.push(`Identificador de zona duplicado: ${zone.id}`);
    }
    allZoneIds.add(zone.id);
  }

  if (metadata.textZoneCount === null || metadata.textZoneCount === undefined) {
    errors.push('textZoneCount no puede ser null en estado ready.');
  } else if (metadata.textZoneCount !== (metadata.textZones ? metadata.textZones.length : 0)) {
    errors.push(`textZoneCount (${metadata.textZoneCount}) no coincide con textZones.length (${metadata.textZones ? metadata.textZones.length : 0}).`);
  }

  for (const zone of metadata.textZones || []) {
    if (allZoneIds.has(zone.id)) {
      errors.push(`Identificador de zona duplicado: ${zone.id}`);
    }
    allZoneIds.add(zone.id);

    if (zone.required && (!zone.instruction || zone.instruction.trim().length === 0)) {
      errors.push(`La zona de texto obligatoria ${zone.id} no tiene instrucción.`);
    }
  }

  return { isValid: errors.length === 0, errors };
}

export function isMemeTemplateMetadataReady(
  metadata: MemeTemplateMetadata,
  options?: { hasVisualRef?: boolean }
): boolean {
  if (metadata.status !== 'ready') return false;
  const validation = validateMemeTemplateMetadata(metadata, options);
  return validation.isValid;
}

export function getMemeTemplateDefinition(templateId: string): MemeTemplateDefinition | null {
  const found = MEME_TEMPLATES.find(t => t.id === templateId);
  return found || null;
}

export function getMemeTemplateMetadata(templateId: string): MemeTemplateMetadata | null {
  const def = getMemeTemplateDefinition(templateId);
  return def ? def.metadata : null;
}

export function getReadyMemeTemplateMetadata(templateId: string): MemeTemplateMetadata | null {
  const def = getMemeTemplateDefinition(templateId);
  if (!def) return null;
  const isReady = isMemeTemplateMetadataReady(def.metadata, { hasVisualRef: Boolean(def.imageRef) });
  return isReady ? def.metadata : null;
}
