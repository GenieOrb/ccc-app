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
      configured = !!config.openaiApiKey;
    } else if (model.provider === 'google') {
      configured = !!config.geminiApiKey;
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
