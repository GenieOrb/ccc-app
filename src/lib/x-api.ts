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
  language?: string;
  conversationId?: string;
  postedAt?: string;
  accessibleContext: Record<string, unknown>;
}

export interface XUser { id: string; name: string; username: string; }
export interface XMedia { media_key: string; type: string; alt_text?: string; }
export interface XReferencedTweet { type: string; id: string; }
export interface XTweetApiItem {
  id?: string;
  text?: string;
  author_id?: string;
  created_at?: string;
  conversation_id?: string;
  in_reply_to_user_id?: string;
  lang?: string;
  possibly_sensitive?: boolean;
  referenced_tweets?: XReferencedTweet[];
  attachments?: {
    media_keys?: string[];
  };
}

export interface XTweet {
  id: string;
  text: string;
  author_id?: string;
  created_at?: string;
  conversation_id?: string;
  in_reply_to_user_id?: string;
  lang?: string;
  possibly_sensitive?: boolean;
  referenced_tweets?: XReferencedTweet[];
  attachments?: {
    media_keys?: string[];
  };
}
export interface XApiResponse {
  data?: XTweetApiItem[];
  includes?: {
    users?: XUser[];
    media?: XMedia[];
    tweets?: XTweetApiItem[];
  };
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

  const url = new URL('https://api.x.com/2/tweets');
  url.searchParams.set('ids', idsQuery);
  url.searchParams.set('tweet.fields', tweetFields);
  url.searchParams.set('expansions', expansions);
  url.searchParams.set('user.fields', userFields);
  url.searchParams.set('media.fields', mediaFields);

  const apiUrl = url.toString();

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

  const data = (await response.json()) as XApiResponse;

  const rawTweets = data.data || [];
  const tweetsData: XTweet[] = [];
  for (const item of rawTweets) {
    if (item.id && typeof item.text === 'string') {
      tweetsData.push(item as XTweet);
    }
  }

  const usersData: XUser[] = data.includes?.users || [];
  const mediaData: XMedia[] = data.includes?.media || [];
  const rawIncludesTweets = data.includes?.tweets || [];

  const referencedTweetsData: XTweet[] = [];
  for (const item of rawIncludesTweets) {
    if (item.id && typeof item.text === 'string') {
      referencedTweetsData.push(item as XTweet);
    }
  }

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

    const post = transformXTweet(tweet, extUrl.inputUrl, extUrl.canonicalUrl, userMap, mediaMap, refTweetMap);
    if (!post) {
      throw new Error(`El post de X con URL "${extUrl.inputUrl}" no contiene texto utilizable para generar comentarios.`);
    }
    fetchedPosts.push(post);
  }

  return fetchedPosts;
}

function transformXTweet(
  tweet: XTweet,
  inputUrl: string,
  canonicalUrl: string,
  userMap: Map<string, { name: string; username: string }>,
  mediaMap: Map<string, { type: string; alt_text?: string }>,
  refTweetMap: Map<string, XTweet>
): FetchedXPost | null {
  const mappedAuthor = typeof tweet.author_id === 'string' ? userMap.get(tweet.author_id) : undefined;
  const author = mappedAuthor ?? { name: 'Desconocido', username: 'unknown' };
  const textContent = tweet.text || '';

  if (!textContent.trim()) {
    return null;
  }

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

  return {
    postId: tweet.id,
    inputUrl,
    canonicalUrl,
    authorName: author.name,
    authorUsername: author.username,
    textContent,
    language: tweet.lang ?? undefined,
    conversationId: tweet.conversation_id ?? undefined,
    postedAt: tweet.created_at ?? undefined,
    accessibleContext,
  };
}

export async function resolveXUsername(username: string): Promise<string> {
  const config = getConfig();
  if (!config.xBearerToken) {
    throw new Error('X_BEARER_TOKEN no está configurado en el servidor.');
  }

  const cleanUsername = username.replace(/^@/, '').trim();
  const apiUrl = `https://api.x.com/2/users/by/username/${cleanUsername}`;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 10000);

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
  } catch {
    clearTimeout(timeoutId);
    throw new Error('Error de conexión al resolver usuario en X.');
  } finally {
    clearTimeout(timeoutId);
  }

  if (!response.ok) {
    throw new Error(`La API de X devolvió el estado HTTP ${response.status} al resolver el usuario.`);
  }

  const data = (await response.json()) as { data?: { id: string } };
  if (!data.data || !data.data.id) {
    throw new Error(`El usuario ${username} no existe o está suspendido.`);
  }

  return data.data.id;
}

export async function fetchNewXPostsForAccount(
  xUserId: string,
  sincePostId: string | null,
  monitoringStartedAt: Date
): Promise<FetchedXPost[]> {
  const config = getConfig();
  if (!config.xBearerToken) {
    throw new Error('X_BEARER_TOKEN no está configurado en el servidor.');
  }

  const tweetFields = 'created_at,text,author_id,conversation_id,in_reply_to_user_id,referenced_tweets,lang,possibly_sensitive';
  const expansions = 'author_id,referenced_tweets.id,attachments.media_keys';
  const userFields = 'name,username';
  const mediaFields = 'type,alt_text';
  const url = new URL(`https://api.x.com/2/users/${xUserId}/tweets`);
  url.searchParams.set('max_results', '20');
  url.searchParams.set('exclude', 'replies,retweets');
  url.searchParams.set('tweet.fields', tweetFields);
  url.searchParams.set('expansions', expansions);
  url.searchParams.set('user.fields', userFields);
  url.searchParams.set('media.fields', mediaFields);

  if (sincePostId) {
    url.searchParams.set('since_id', sincePostId);
  } else {
    // Si no hay cursor, podemos acotar el tiempo para no traer demasiados históricos (y luego filtrar en código)
    // Usamos start_time solo si podemos asegurar el formato ISO 8601
    try {
      url.searchParams.set('start_time', monitoringStartedAt.toISOString());
    } catch {}
  }

  const apiUrl = url.toString();

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 15000);

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
  } catch {
    clearTimeout(timeoutId);
    throw new Error('Error de red al consultar posts.');
  } finally {
    clearTimeout(timeoutId);
  }

  if (!response.ok) {
    throw new Error(`La API de X devolvió HTTP ${response.status}`);
  }

  const data = (await response.json()) as XApiResponse;
  if (!data.data || data.data.length === 0) {
    return [];
  }

  const rawTweets = data.data || [];
  const tweetsData: XTweet[] = [];
  for (const item of rawTweets) {
    if (item.id && typeof item.text === 'string') {
      tweetsData.push(item as XTweet);
    }
  }

  const usersData: XUser[] = data.includes?.users || [];
  const mediaData: XMedia[] = data.includes?.media || [];
  const rawIncludesTweets = data.includes?.tweets || [];

  const referencedTweetsData: XTweet[] = [];
  for (const item of rawIncludesTweets) {
    if (item.id && typeof item.text === 'string') {
      referencedTweetsData.push(item as XTweet);
    }
  }

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

  const validPosts: FetchedXPost[] = [];

  for (const tweet of tweetsData) {
    // Filtrar retweets (referenced_tweets con type="retweeted")
    const isRetweet = tweet.referenced_tweets?.some((rt) => rt.type === 'retweeted');
    // Filtrar respuestas a otros (in_reply_to_user_id distinto de sí mismo)
    const isReplyToOther = tweet.in_reply_to_user_id && tweet.in_reply_to_user_id !== xUserId;

    if (isRetweet || isReplyToOther) {
      continue;
    }

    // Filtrar publicaciones anteriores al monitoringStartedAt (doble check)
    if (tweet.created_at) {
      const postDate = new Date(tweet.created_at);
      if (postDate < monitoringStartedAt) {
        continue;
      }
    }

    const postId = tweet.id;
    const mappedAuthor = typeof tweet.author_id === 'string' ? userMap.get(tweet.author_id) : undefined;
    const authorInfo = mappedAuthor ?? { name: 'Desconocido', username: 'unknown' };
    const canonicalUrl = `https://x.com/${authorInfo.username}/status/${postId}`;

    const transformed = transformXTweet(tweet, canonicalUrl, canonicalUrl, userMap, mediaMap, refTweetMap);
    if (transformed) {
      validPosts.push(transformed);
    }
  }

  // Ordenar de más antiguo a más nuevo para su importación
  validPosts.sort((a, b) => {
    if (!a.postedAt || !b.postedAt) return 0;
    return new Date(a.postedAt).getTime() - new Date(b.postedAt).getTime();
  });

  return validPosts;
}
