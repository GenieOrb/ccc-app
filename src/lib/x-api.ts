import 'server-only';
import { getConfig } from './config';

export interface ExtractedXUrl {
  inputUrl: string;
  postId: string;
  canonicalUrl: string;
}

export interface FetchedXPost {
  postId: string;
  inputUrl: string;
  canonicalUrl: string;
  authorName: string;
  authorUsername: string;
  textContent: string;
  language: string | null;
  conversationId: string | null;
  postedAt: string | null;
  accessibleContext: Record<string, unknown>;
}

const ALLOWED_X_HOSTS = new Set([
  'x.com',
  'www.x.com',
  'mobile.x.com',
  'twitter.com',
  'www.twitter.com',
  'mobile.twitter.com',
]);

export function parseAndValidateXUrl(rawUrl: string): ExtractedXUrl {
  const trimmed = rawUrl.trim();
  if (!trimmed) {
    throw new Error('URL vacía.');
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error(`La URL "${trimmed}" no es un enlace web válido.`);
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`Protocolo no permitido en la URL "${trimmed}". Usar https://`);
  }

  if (parsed.username || parsed.password) {
    throw new Error(`La URL "${trimmed}" contiene credenciales incrustadas no permitidas.`);
  }

  if (parsed.port && parsed.port !== '80' && parsed.port !== '443') {
    throw new Error(`Puerto no estándar en la URL "${trimmed}".`);
  }

  const hostname = parsed.hostname.toLowerCase();
  if (!ALLOWED_X_HOSTS.has(hostname)) {
    throw new Error(`El dominio "${hostname}" no está permitido. Usar x.com o twitter.com`);
  }

  // Path format: /username/status/1234567890 or /status/1234567890 or /i/web/status/1234567890
  const pathname = parsed.pathname;
  const statusMatch = pathname.match(/\/status\/(\d+)/i);
  if (!statusMatch || !statusMatch[1]) {
    throw new Error(`No se encontró un ID numérico de post de X en la URL "${trimmed}".`);
  }

  const postId = statusMatch[1];
  const canonicalUrl = `https://x.com/i/status/${postId}`;

  return {
    inputUrl: trimmed,
    postId,
    canonicalUrl,
  };
}

export function parseMultipleXUrls(input: string): ExtractedXUrl[] {
  const lines = input
    .split(/[\r\n]+/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  if (lines.length === 0) {
    throw new Error('Debes proporcionar al menos una URL de un post de X.');
  }

  if (lines.length > 50) {
    throw new Error('No se pueden incluir más de 50 URLs de posts de X por campaña.');
  }

  const extractedList: ExtractedXUrl[] = [];
  const seenPostIds = new Set<string>();

  for (const line of lines) {
    const extracted = parseAndValidateXUrl(line);
    if (!seenPostIds.has(extracted.postId)) {
      seenPostIds.add(extracted.postId);
      extractedList.push(extracted);
    }
  }

  return extractedList;
}

export async function fetchXPosts(extractedUrls: ExtractedXUrl[]): Promise<FetchedXPost[]> {
  const config = getConfig();
  if (!config.xBearerToken) {
    throw new Error('X_BEARER_TOKEN no está configurado en el servidor.');
  }

  const postIds = extractedUrls.map((u) => u.postId);
  const idsQuery = postIds.join(',');

  const tweetFields = 'created_at,text,author_id,conversation_id,in_reply_to_user_id,referenced_tweets,lang,possibly_sensitive';
  const expansions = 'author_id,referenced_tweets.id,attachments.media_keys';
  const userFields = 'name,username';
  const mediaFields = 'type,alt_text';

  const apiUrl = `https://api.x.com/2/tweets?ids=${idsQuery}&tweet.fields=${tweetFields}&expansions=${expansions}&user.fields=${userFields}&media.fields=${mediaFields}`;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 15000); // 15s timeout

  let response: Response;
  try {
    response = await fetch(apiUrl, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${config.xBearerToken}`,
        'Content-Type': 'application/json',
      },
      signal: controller.signal,
      cache: 'no-store',
    });
  } catch (err: unknown) {
    clearTimeout(timeoutId);
    if (err instanceof Error && err.name === 'AbortError') {
      throw new Error('La llamada a la API de X superó el tiempo límite de 15 segundos.');
    }
    throw new Error(`Error de conexión al consultar la API de X: ${err instanceof Error ? err.message : 'Error de red'}`);
  } finally {
    clearTimeout(timeoutId);
  }

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`La API de X devolvió el estado HTTP ${response.status}: ${errText.slice(0, 200)}`);
  }

  const data = await response.json();
  interface XUser { id: string; name: string; username: string; }
  interface XMedia { media_key: string; type: string; alt_text?: string; }
  interface XReferencedTweet { id: string; type: string; }
  interface XTweet {
    id: string;
    text?: string;
    author_id?: string;
    created_at?: string;
    lang?: string;
    conversation_id?: string;
    attachments?: { media_keys?: string[] };
    referenced_tweets?: XReferencedTweet[];
    possibly_sensitive?: boolean;
  }

  const tweetsData: XTweet[] = data.data || [];
  const usersData: XUser[] = data.includes?.users || [];
  const mediaData: XMedia[] = data.includes?.media || [];
  const referencedTweetsData: XTweet[] = data.includes?.tweets || [];

  const userMap = new Map<string, { name: string; username: string }>();
  for (const u of usersData) {
    userMap.set(u.id, { name: u.name, username: u.username });
  }

  const mediaMap = new Map<string, { type: string; alt_text?: string }>();
  for (const m of mediaData) {
    mediaMap.set(m.media_key, { type: m.type, alt_text: m.alt_text });
  }

  const refTweetMap = new Map<string, XTweet>();
  for (const rt of referencedTweetsData) {
    refTweetMap.set(rt.id, rt);
  }

  const fetchedPosts: FetchedXPost[] = [];

  for (const extUrl of extractedUrls) {
    const tweet = tweetsData.find((t) => t.id === extUrl.postId);
    if (!tweet) {
      throw new Error(`El post de X con URL "${extUrl.inputUrl}" no existe, es privado, o fue eliminado.`);
    }

    const author = (tweet.author_id && userMap.get(tweet.author_id)) || { name: 'Desconocido', username: 'unknown' };
    const textContent = tweet.text || '';

    if (!textContent.trim()) {
      throw new Error(`El post de X con URL "${extUrl.inputUrl}" no contiene texto utilizable para generar comentarios.`);
    }

    // Process referenced tweets (quoted or parent) up to 5 immediate parents max
    const parentContext: Array<{ id: string; text: string; type: string }> = [];
    if (tweet.referenced_tweets && Array.isArray(tweet.referenced_tweets)) {
      for (const ref of tweet.referenced_tweets.slice(0, 5)) {
        const refTweet = refTweetMap.get(ref.id);
        if (refTweet) {
          parentContext.push({
            id: ref.id,
            type: ref.type,
            text: refTweet.text || '',
          });
        }
      }
    }

    // Process media alt texts if available
    const attachedMedia: Array<{ type: string; alt_text?: string }> = [];
    if (tweet.attachments?.media_keys && Array.isArray(tweet.attachments.media_keys)) {
      for (const key of tweet.attachments.media_keys) {
        const m = mediaMap.get(key);
        if (m) {
          attachedMedia.push(m);
        }
      }
    }

    const accessibleContext = {
      author_id: tweet.author_id,
      possibly_sensitive: !!tweet.possibly_sensitive,
      parent_context: parentContext,
      media: attachedMedia,
    };

    fetchedPosts.push({
      postId: extUrl.postId,
      inputUrl: extUrl.inputUrl,
      canonicalUrl: extUrl.canonicalUrl,
      authorName: author.name,
      authorUsername: author.username,
      textContent,
      language: tweet.lang || null,
      conversationId: tweet.conversation_id || null,
      postedAt: tweet.created_at || null,
      accessibleContext,
    });
  }

  return fetchedPosts;
}
