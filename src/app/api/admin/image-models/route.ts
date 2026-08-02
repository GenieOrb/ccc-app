import { NextResponse } from 'next/server';
import { isAdminAuthenticated } from '@/lib/auth';
import { IMAGE_MODELS } from '@/lib/ai/image-models';
import { getConfig } from '@/lib/config';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  if (!(await isAdminAuthenticated())) {
    return NextResponse.json({ error: 'No autorizado.' }, { status: 401 });
  }

  const config = getConfig();

  const models = Object.values(IMAGE_MODELS).map((model) => {
    let configured = false;
    if (model.provider === 'openai') {
      // The OpenAI SDK only supports dall-e-2 and dall-e-3 natively for images.
      // gpt-image-2 is not a valid public model for OpenAI's generate image endpoint.
      const supportedModels = ['dall-e-2', 'dall-e-3'];
      configured = !!config.openaiApiKey && supportedModels.includes(model.apiModel);
    } else if (model.provider === 'google') {
      configured = !!config.googleAiApiKey;
    }
    return {
      key: model.key,
      displayName: model.displayName,
      costPerImage: model.resolutions[0].costPerImage, // Base cost
      configured,
      enabled: true,
    };
  });

  return NextResponse.json({ models }, { headers: { 'Cache-Control': 'no-store' } });
}
