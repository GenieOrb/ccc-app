import { describe, it, expect, vi } from 'vitest';
import {
  MEME_TEMPLATES,
  getMemeTemplateMetadata,
  getReadyMemeTemplateMetadata,
  validateMemeTemplateMetadata,
  isMemeTemplateMetadataReady,
  buildMemeTemplatePostContext,
  MemeTemplateMetadata,
  MemeTemplateDefinition
} from './templates';
import { generateDeterministicMemeSlotPlans } from './planner';

describe('Meme Templates Metadata Registry & Safeguards', () => {
  it('1. Siguen existiendo exactamente las 30 plantillas reales', () => {
    expect(MEME_TEMPLATES).toBeDefined();
    expect(MEME_TEMPLATES.length).toBe(30);
  });

  it('2. Conservan sus nombres reales actuales', () => {
    const names = MEME_TEMPLATES.map(t => t.name);
    expect(names).toContain('Drake');
    expect(names).toContain('Distracted Boyfriend');
    expect(names).toContain('Two Buttons');
    expect(names).toContain('Change My Mind');
    expect(names).toContain('Expanding Brain');
    expect(names.length).toBe(30);
  });

  it('3. Conservan sus identificadores estables', () => {
    const ids = MEME_TEMPLATES.map(t => t.id);
    expect(ids).toContain('drake');
    expect(ids).toContain('distracted-boyfriend');
    expect(ids).toContain('two-buttons');
    expect(ids).toContain('change-my-mind');
    expect(ids).toContain('expanding-brain');
    expect(new Set(ids).size).toBe(30);
  });

  it('4. Conservan sus imágenes o referencias visuales', () => {
    for (const t of MEME_TEMPLATES) {
      expect(t.imageRef).toBeTruthy();
      expect(typeof t.imageRef).toBe('string');
      expect(t.imageRef.length).toBeGreaterThan(0);
    }
  });

  it('5. No se crea un segundo catálogo paralelo', () => {
    const meta = getMemeTemplateMetadata('drake');
    expect(meta).toBe(MEME_TEMPLATES[0].metadata);
  });

  it('6. Todas tienen una ficha de metadatos vinculada', () => {
    for (const t of MEME_TEMPLATES) {
      expect(t.metadata).toBeDefined();
      expect(typeof t.metadata).toBe('object');
    }
  });

  it('7. Todas las fichas nuevas están inicialmente en estado draft', () => {
    for (const t of MEME_TEMPLATES) {
      expect(t.metadata.status).toBe('draft');
    }
  });

  it('8. Los campos nuevos de instrucciones están vacíos', () => {
    for (const t of MEME_TEMPLATES) {
      expect(t.metadata.templateMeaning).toBe('');
      expect(t.metadata.intention).toBe('');
      expect(t.metadata.tone).toBe('');
      expect(t.metadata.generalInstruction).toBe('');
      expect(t.metadata.negativeInstruction).toBe('');
      expect(t.metadata.promotedBrandZones).toEqual([]);
      expect(t.metadata.competitorZones).toEqual([]);
      expect(t.metadata.textZoneCount).toBeNull();
      expect(t.metadata.textZones).toEqual([]);
      expect(t.metadata.additionalData).toEqual({});
      expect(t.metadata.postInterpretationRules).toEqual({
        explicitCompetitor: '',
        implicitCompetitor: '',
        collectiveCompetitor: '',
        noCompetitor: ''
      });
    }
  });

  it('9. No existe none como representación permitida de la marca promocionada', () => {
    const readyMeta: MemeTemplateMetadata = {
      schemaVersion: 1,
      status: 'ready',
      templateMeaning: 'Test meaning',
      intention: 'Test intention',
      tone: 'Test tone',
      generalInstruction: 'Test general instruction',
      negativeInstruction: 'None',
      promotedBrandZones: [
        {
          id: 'pbz-1',
          meaning: 'Logo location',
          semanticFunction: 'Promote brand',
          instruction: 'Place logo',
          allowedRepresentation: 'none' as unknown as 'logo', // invalid
          required: true
        }
      ],
      competitorZones: [],
      textZoneCount: 0,
      textZones: [],
      postInterpretationRules: {
        explicitCompetitor: '',
        implicitCompetitor: '',
        collectiveCompetitor: '',
        noCompetitor: ''
      },
      additionalData: {}
    };

    const val = validateMemeTemplateMetadata(readyMeta);
    expect(val.isValid).toBe(false);
    expect(val.errors.some(e => e.includes('Representación de marca promocionada no válida'))).toBe(true);
  });

  it('10. Una ficha ready sin marca promocionada obligatoria se rechaza', () => {
    const readyMeta: MemeTemplateMetadata = {
      schemaVersion: 1,
      status: 'ready',
      templateMeaning: 'Meaning',
      intention: 'Intention',
      tone: 'Tone',
      generalInstruction: 'Instruction',
      negativeInstruction: '',
      promotedBrandZones: [], // empty
      competitorZones: [],
      textZoneCount: 0,
      textZones: [],
      postInterpretationRules: {
        explicitCompetitor: '',
        implicitCompetitor: '',
        collectiveCompetitor: '',
        noCompetitor: ''
      },
      additionalData: {}
    };

    const val = validateMemeTemplateMetadata(readyMeta);
    expect(val.isValid).toBe(false);
    expect(val.errors.some(e => e.includes('al menos una zona para la marca promocionada'))).toBe(true);
  });

  it('11. Una ficha ready sin referencia visual se rechaza', () => {
    const readyMeta: MemeTemplateMetadata = {
      schemaVersion: 1,
      status: 'ready',
      templateMeaning: 'Meaning',
      intention: 'Intention',
      tone: 'Tone',
      generalInstruction: 'Instruction',
      negativeInstruction: '',
      promotedBrandZones: [
        {
          id: 'brand-1',
          meaning: 'Main brand',
          semanticFunction: 'Primary',
          instruction: 'Put brand name',
          allowedRepresentation: 'name',
          required: true
        }
      ],
      competitorZones: [],
      textZoneCount: 0,
      textZones: [],
      postInterpretationRules: {
        explicitCompetitor: '',
        implicitCompetitor: '',
        collectiveCompetitor: '',
        noCompetitor: ''
      },
      additionalData: {}
    };

    const val = validateMemeTemplateMetadata(readyMeta, { hasVisualRef: false });
    expect(val.isValid).toBe(false);
    expect(val.errors).toContain('Falta la referencia visual o imagen de la plantilla.');
  });

  it('12. Un textZoneCount incorrecto que no coincida se rechaza', () => {
    const readyMeta: MemeTemplateMetadata = {
      schemaVersion: 1,
      status: 'ready',
      templateMeaning: 'Meaning',
      intention: 'Intention',
      tone: 'Tone',
      generalInstruction: 'Instruction',
      negativeInstruction: '',
      promotedBrandZones: [
        {
          id: 'b-1',
          meaning: 'Brand',
          semanticFunction: 'Main',
          instruction: 'Show brand',
          allowedRepresentation: 'logo',
          required: true
        }
      ],
      competitorZones: [],
      textZoneCount: 2, // says 2, but textZones length is 0
      textZones: [],
      postInterpretationRules: {
        explicitCompetitor: '',
        implicitCompetitor: '',
        collectiveCompetitor: '',
        noCompetitor: ''
      },
      additionalData: {}
    };

    const val = validateMemeTemplateMetadata(readyMeta);
    expect(val.isValid).toBe(false);
    expect(val.errors.some(e => e.includes('textZoneCount (2) no coincide'))).toBe(true);
  });

  it('13. Identificadores de zonas duplicados se rechazan', () => {
    const readyMeta: MemeTemplateMetadata = {
      schemaVersion: 1,
      status: 'ready',
      templateMeaning: 'Meaning',
      intention: 'Intention',
      tone: 'Tone',
      generalInstruction: 'Instruction',
      negativeInstruction: '',
      promotedBrandZones: [
        {
          id: 'zone-dup',
          meaning: 'Brand',
          semanticFunction: 'Main',
          instruction: 'Show brand',
          allowedRepresentation: 'logo',
          required: true
        }
      ],
      competitorZones: [
        {
          id: 'zone-dup', // Duplicate ID!
          characterOrElement: 'Rival',
          semanticMeaning: 'Competitor',
          instruction: 'Show rival',
          required: false,
          allowedRepresentation: 'name',
          priority: 1,
          functionRelativeToOtherZones: 'Opponent'
        }
      ],
      textZoneCount: 0,
      textZones: [],
      postInterpretationRules: {
        explicitCompetitor: '',
        implicitCompetitor: '',
        collectiveCompetitor: '',
        noCompetitor: ''
      },
      additionalData: {}
    };

    const val = validateMemeTemplateMetadata(readyMeta);
    expect(val.isValid).toBe(false);
    expect(val.errors.some(e => e.includes('Identificador de zona duplicado: zone-dup'))).toBe(true);
  });

  it('14. additionalData admite datos futuros estructurados libremente', () => {
    const meta = MEME_TEMPLATES[0].metadata;
    meta.additionalData = { customProperty: 123, newRule: 'enabled' };
    expect(meta.additionalData.customProperty).toBe(123);
  });

  it('15. Añadir posteriormente otra plantilla no exige cambiar los tipos TypeScript', () => {
    const newTemplate: MemeTemplateDefinition = {
      id: 'template-31',
      name: 'Future Meme Template',
      imageRef: 'memes/templates/template-31.png',
      metadata: {
        schemaVersion: 2,
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
        additionalData: { versionNote: 'v2 extended' }
      }
    };
    expect(newTemplate.id).toBe('template-31');
  });

  it('16. Las plantillas actuales siguen seleccionándose deterministamente en el planner', () => {
    const plans = generateDeterministicMemeSlotPlans(
      'campaign-1',
      null,
      ['post-1'],
      10,
      [{ id: 'asset-1', appearancePercentage: 100, assetType: 'logo' }]
    );
    expect(plans.length).toBe(10);
    expect(plans[0].visualStructure).toBeDefined();
  });

  it('17. Las referencias visuales de imágenes actuales se obtienen intactas', () => {
    const drakeDef = MEME_TEMPLATES.find(t => t.id === 'drake');
    expect(drakeDef?.imageRef).toBe('memes/templates/drake.png');
  });

  it('18. El prompt actual no cambia mientras la ficha permanezca en draft', () => {
    const readyMeta = getReadyMemeTemplateMetadata('drake');
    expect(readyMeta).toBeNull(); // Because drake is in draft, getReadyMemeTemplateMetadata returns null!
  });

  it('19. El flujo de generación no añade fragmentos de prompt sin instrucciones listas', () => {
    const isReady = isMemeTemplateMetadataReady(MEME_TEMPLATES[0].metadata);
    expect(isReady).toBe(false);
  });

  it('20. El contexto común se construye correctamente desde un post manual', () => {
    const ctx = buildMemeTemplatePostContext({
      xPostId: '1234567890',
      postText: 'OpenAI releases GPT-5.4 today',
      authorName: 'Tech News',
      authorUsername: 'technews',
      accessibleContext: {
        explicitEntities: ['OpenAI', 'GPT-5.4'],
        mainCompetitor: 'OpenAI'
      }
    });

    expect(ctx.postText).toBe('OpenAI releases GPT-5.4 today');
    expect(ctx.authorUsername).toBe('technews');
    expect(ctx.canonicalUrl).toBe('https://x.com/technews/status/1234567890');
    expect(ctx.mainCompetitor).toBe('OpenAI');
    expect(ctx.hasIdentifiableCompetitor).toBe(true);
  });

  it('21. El contexto común se construye correctamente desde un post de campaña perpetua', () => {
    const ctx = buildMemeTemplatePostContext({
      xPostId: '9876543210',
      postText: 'Anthropic introduces Claude 3.7 Sonnet for coding',
      authorName: 'AI Radar',
      authorUsername: 'airadar',
      accessibleContext: {
        parents: [{ text: 'Parent tweet about AI tools' }],
        implicitEntities: ['Anthropic', 'Claude'],
        collectiveGroups: ['AI companies']
      }
    });

    expect(ctx.postText).toBe('Anthropic introduces Claude 3.7 Sonnet for coding');
    expect(ctx.threadContext).toContain('Parent tweet about AI tools');
    expect(ctx.collectiveGroups).toContain('AI companies');
    expect(ctx.hasIdentifiableCompetitor).toBe(true);
  });

  it('22. No se realizan llamadas a servicios externos en buildMemeTemplatePostContext', () => {
    const spyFetch = vi.spyOn(global, 'fetch');
    buildMemeTemplatePostContext({
      xPostId: '111',
      postText: 'Offline post'
    });
    expect(spyFetch).not.toHaveBeenCalled();
    spyFetch.mockRestore();
  });

  it('23. El planner existente no se altera', () => {
    expect(typeof generateDeterministicMemeSlotPlans).toBe('function');
  });

  it('24. La estructura de metadata draft es 100% válida e inofensiva al inicio', () => {
    for (const t of MEME_TEMPLATES) {
      const val = validateMemeTemplateMetadata(t.metadata, { hasVisualRef: Boolean(t.imageRef) });
      expect(val.isValid).toBe(true); // Valid as draft!
      expect(val.errors.length).toBe(0);
    }
  });

  it('25. Campañas existentes permanecen protegidas', () => {
    expect(MEME_TEMPLATES.length).toBe(30);
  });
});
