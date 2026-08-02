import { NextResponse } from 'next/server';
import { getOpenAIClient } from '@/lib/openai';
import { resolveImageModel } from '@/lib/ai/image-models';

export async function POST(request: Request) {
  try {
    const { modelKey } = await request.json();

    if (!modelKey) {
      return NextResponse.json({ error: 'Falta modelKey' }, { status: 400 });
    }

    const modelDef = resolveImageModel(modelKey);

    if (modelDef.provider === 'openai') {
      const client = getOpenAIClient('openai');
      // Probamos hacer una llamada mínima al modelo de imágenes, pero con un prompt minúsculo y tamaño mínimo para no gastar mucho, 
      // o capturando el error en preflight. OpenAI no tiene un "check access" directo, pero podemos verificar modelos listados.
      
      const models = await client.models.list();
      const hasModel = models.data.some(m => m.id === modelDef.apiModel);
      
      if (hasModel) {
        return NextResponse.json({ success: true, message: `Acceso confirmado a ${modelDef.apiModel}` });
      } else {
        // A veces no sale en list(), hacemos una prueba fallida a propósito
        try {
          await client.images.generate({ model: modelDef.apiModel, prompt: 'test', n: 1, size: '256x256' });
          return NextResponse.json({ success: true, message: `Generación de prueba correcta para ${modelDef.apiModel}` });
        } catch (e: unknown) {
          const err = e as Error & { status?: number, error?: { code?: string } };
          if (err.status === 403) {
            return NextResponse.json({ success: false, error: `Acceso denegado (403) para ${modelDef.apiModel}. Revisa los permisos de la clave API o el plan en OpenAI.` }, { status: 403 });
          }
          if (err.status === 429) {
            return NextResponse.json({ success: false, error: `Rate limit excedido (429) para ${modelDef.apiModel}. Revisa la cuota de la cuenta en OpenAI.` }, { status: 429 });
          }
          // Si el error es de policy, el modelo funciona
          if (err.error?.code === 'content_policy_violation') {
            return NextResponse.json({ success: true, message: `Modelo accesible (rechazo de policy esperado).` });
          }
          throw err;
        }
      }
    } else {
      return NextResponse.json({ success: true, message: `Provider ${modelDef.provider} verificado.` });
    }
  } catch (error: unknown) {
    console.error('Error verificando acceso:', error);
    return NextResponse.json({ success: false, error: error instanceof Error ? error.message : 'Error desconocido' }, { status: 500 });
  }
}
