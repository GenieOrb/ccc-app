import { NextResponse } from 'next/server';
import { isAdminAuthenticated, validateSameOrigin } from '@/lib/auth';
import { addAccountsToCampaign } from '@/lib/services';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const isAuth = await isAdminAuthenticated();
  if (!isAuth) {
    return NextResponse.json(
      { error: 'No autorizado.' },
      { status: 401, headers: { 'Cache-Control': 'no-store' } }
    );
  }

  if (!validateSameOrigin(req)) {
    return NextResponse.json(
      { error: 'Petición de origen no permitida.' },
      { status: 403, headers: { 'Cache-Control': 'no-store' } }
    );
  }

  try {
    const { id } = await params;
    const body = await req.json().catch(() => null);

    if (!body || Array.isArray(body) || typeof body !== 'object') {
      return NextResponse.json(
        { error: 'Cuerpo de petición no válido.' },
        { status: 400, headers: { 'Cache-Control': 'no-store' } }
      );
    }

    const keys = Object.keys(body);
    if (keys.length !== 1 || keys[0] !== 'accountsInput') {
      return NextResponse.json(
        { error: 'El cuerpo solo puede contener el campo accountsInput.' },
        { status: 400, headers: { 'Cache-Control': 'no-store' } }
      );
    }

    const { accountsInput } = body;

    if (!accountsInput || typeof accountsInput !== 'string') {
      return NextResponse.json(
        { error: 'Debes proporcionar las cuentas de X.' },
        { status: 400, headers: { 'Cache-Control': 'no-store' } }
      );
    }

    const { addedAccounts, initialSync } = await addAccountsToCampaign(id, accountsInput);

    return NextResponse.json(
      { success: true, addedAccounts, initialSync },
      { headers: { 'Cache-Control': 'no-store' } }
    );
  } catch (error: unknown) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Error al añadir cuentas.' },
      { status: 400, headers: { 'Cache-Control': 'no-store' } }
    );
  }
}
