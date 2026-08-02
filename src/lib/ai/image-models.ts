import 'server-only';

export interface ImageModelDefinition {
  key: string;
  provider: 'openai' | 'google';
  apiModel: string;
  displayName: string;
  resolutions: {
    width: number;
    height: number;
    costPerImage: string; // Stored as string to avoid floating point precision issues
  }[];
  defaultResolution: { width: number; height: number };
}

export const IMAGE_MODELS: Record<string, ImageModelDefinition> = {
  'gpt-image-2': {
    key: 'gpt-image-2',
    provider: 'openai',
    apiModel: 'gpt-image-2',
    displayName: 'gpt-image-2',
    resolutions: [
      { width: 1024, height: 1024, costPerImage: '0.04000' }
    ],
    defaultResolution: { width: 1024, height: 1024 }
  },
  'gemini-3.1-flash-image': {
    key: 'gemini-3.1-flash-image',
    provider: 'google',
    apiModel: 'gemini-3.1-flash-image',
    displayName: 'gemini-3.1-flash-image',
    resolutions: [
      { width: 1536, height: 1536, costPerImage: '0.03000' }
    ],
    defaultResolution: { width: 1536, height: 1536 }
  },
  'gemini-3.1-flash-lite-image': {
    key: 'gemini-3.1-flash-lite-image',
    provider: 'google',
    apiModel: 'gemini-3.1-flash-lite-image',
    displayName: 'gemini-3.1-flash-lite-image',
    resolutions: [
      { width: 1024, height: 1024, costPerImage: '0.01500' }
    ],
    defaultResolution: { width: 1024, height: 1024 }
  }
};

export function resolveImageModel(key: string): ImageModelDefinition {
  const model = IMAGE_MODELS[key];
  if (!model) {
    throw new Error(`Unknown image model key: ${key}`);
  }
  return model;
}

export function getAllImageModels(): ImageModelDefinition[] {
  return Object.values(IMAGE_MODELS);
}
