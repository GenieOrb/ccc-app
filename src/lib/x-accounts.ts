export interface NormalizedAccount {
  username: string;
  username_normalized: string;
}

export function normalizeXAccounts(input: string): NormalizedAccount[] {
  if (!input || !input.trim()) {
    throw new Error('Debes proporcionar al menos una cuenta de X.');
  }

  const rawItems = input.split(/[\n,]+/).map((item) => item.trim()).filter(Boolean);

  if (rawItems.length === 0) {
    throw new Error('Debes proporcionar al menos una cuenta de X.');
  }

  const normalizedAccounts: NormalizedAccount[] = [];
  const seen = new Set<string>();

  for (const raw of rawItems) {
    let username = raw;

    // Check if it's a URL
    if (username.startsWith('http://') || username.startsWith('https://')) {
      try {
        const url = new URL(username);
        const host = url.hostname.toLowerCase();
        
        const allowedHosts = new Set([
          'x.com',
          'www.x.com',
          'mobile.x.com',
          'twitter.com',
          'www.twitter.com',
          'mobile.twitter.com',
        ]);
        
        if (!allowedHosts.has(host)) {
          throw new Error(`La URL ${username} no pertenece a X/Twitter.`);
        }

        const pathParts = url.pathname.split('/').filter(Boolean);
        
        if (pathParts.length === 0) {
          throw new Error(`La URL ${username} no contiene un nombre de usuario.`);
        }
        
        if (pathParts.includes('status')) {
          throw new Error(`La URL ${username} enlaza a un post, no a un perfil. Usa solo cuentas en campañas perpetuas.`);
        }
        
        if (pathParts.length > 1) {
          throw new Error(`La URL ${username} tiene una ruta no válida para un perfil básico.`);
        }

        username = pathParts[0];
      } catch (e) {
        if (e instanceof Error && e.message.startsWith('La URL')) {
          throw e;
        }
        throw new Error(`Formato de URL no válido: ${username}`);
      }
    }

    // Strip @
    if (username.startsWith('@')) {
      username = username.slice(1);
    }

    // Validate regex
    if (!/^[A-Za-z0-9_]{1,15}$/.test(username)) {
      throw new Error(`El usuario "${username}" no es válido. Solo se permiten hasta 15 caracteres alfanuméricos y guiones bajos.`);
    }

    const username_normalized = username.toLowerCase();

    if (!seen.has(username_normalized)) {
      seen.add(username_normalized);
      normalizedAccounts.push({ username, username_normalized });
    }
  }

  if (normalizedAccounts.length === 0) {
    throw new Error('Debes proporcionar al menos una cuenta válida.');
  }

  return normalizedAccounts;
}
