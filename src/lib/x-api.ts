import 'server-only';
import { randomUUID } from 'node:crypto';
import { getConfig } from './config';
import { queryDb } from './db';
import { X_PRICING, getUtcDedupDate } from './x-pricing';

export interface XCallAttribution { campaignId?: string; campaignAccountId?: string; attributionKey?: string; }

function boundedXTimeoutMs(requestedTimeoutMs: number | undefined, defaultTimeoutMs: number): number {
  if (requestedTimeoutMs === undefined) return defaultTimeoutMs;
  if (!Number.isFinite(requestedTimeoutMs)) return 1;
  return Math.max(1, Math.min(defaultTimeoutMs, Math.floor(requestedTimeoutMs)));
}

async function recordXCall(operation: 'tweet_lookup' | 'user_lookup' | 'timeline_lookup', attribution?: XCallAttribution) {
  const callKey = `x:${operation}:${randomUUID()}`;
  await queryDb(
    `INSERT INTO x_api_calls (call_key,operation,campaign_id,campaign_account_id,attribution_key,status)
     VALUES ($1,$2,$3,$4,$5,'started')`,
    [callKey, operation, attribution?.campaignId ?? null, attribution?.campaignAccountId ?? null, attribution?.attributionKey ?? null],
  );
  return callKey;
}

async function finishXCall(callKey: string, status: 'succeeded' | 'failed', operation: 'tweet_lookup' | 'user_lookup' | 'timeline_lookup', httpStatus?: number, apiResponse?: XApiResponse) {
  let postCount = 0;
  let userCount = 0;
  let cost = 0;

  if (status === 'succeeded' && apiResponse) {
    const postIds = new Set<string>();
    const userIds = new Set<string>();

    if (apiResponse.data) {
      if (operation === 'user_lookup') {
        apiResponse.data.forEach((u: unknown) => { if (u && typeof u === 'object' && 'id' in u && typeof (u as { id: unknown }).id === 'string') userIds.add((u as { id: string }).id); });
      } else {
        apiResponse.data.forEach(t => t.id && postIds.add(t.id));
      }
    }

    if (apiResponse.includes?.users) {
      apiResponse.includes.users.forEach(u => u.id && userIds.add(u.id));
    }
    if (apiResponse.includes?.tweets) {
      apiResponse.includes.tweets.forEach(t => t.id && postIds.add(t.id));
    }

    const utcDate = getUtcDedupDate();

    for (const pid of postIds) {
      const res = await queryDb<{ id: string }>(
        `INSERT INTO x_api_billable_resources (resource_type, resource_id, billing_utc_date)
         VALUES ('post', $1, $2) ON CONFLICT DO NOTHING RETURNING id`,
        [pid, utcDate]
      );
      if (res.length > 0) postCount++;
    }

    for (const uid of userIds) {
      const res = await queryDb<{ id: string }>(
        `INSERT INTO x_api_billable_resources (resource_type, resource_id, billing_utc_date)
         VALUES ('user', $1, $2) ON CONFLICT DO NOTHING RETURNING id`,
        [uid, utcDate]
      );
      if (res.length > 0) userCount++;
    }

    cost = (postCount * X_PRICING.POST_READ_USD) + (userCount * X_PRICING.USER_READ_USD);
  }

  await queryDb(
    `UPDATE x_api_calls
     SET status=$2, http_status=$3, post_resources_count=$4, user_resources_count=$5,
         post_unit_price=$6, user_unit_price=$7, currency=$8, estimated_cost=$9,
         pricing_effective_at=$10, finished_at=NOW(), failure_kind=CASE WHEN $2='failed' THEN 'provider_error' ELSE NULL END
     WHERE call_key=$1`,
    [callKey, status, httpStatus ?? null, postCount, userCount, X_PRICING.POST_READ_USD, X_PRICING.USER_READ_USD, X_PRICING.CURRENCY, cost, X_PRICING.EFFECTIVE_DATE],
  );
}

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
  meta?: { next_token?: string };
}

export interface XTimelineFetchResult {
  posts: FetchedXPost[];
  complete: boolean;
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
  const statusMatch = pathname.match(/\/status\/([^/?#]+)/i);
  if (!statusMatch || !statusMatch[1]) {
    if (pathname.split('/').filter(Boolean).length === 1) {
      throw new Error('Estas en campaña manual, debes poner posts, no cuentas.');
    }
    throw new Error(`No se encontró un ID numérico de post de X en la URL "${trimmed}".`);
  }

  if (!/^\d+$/.test(statusMatch[1])) {
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
    .split(/[\r\n,]+/)
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

export async function fetchXPosts(extractedUrls: ExtractedXUrl[], attribution?: XCallAttribution, timeoutMs?: number): Promise<FetchedXPost[]> {
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
  const requestTimeoutMs = boundedXTimeoutMs(timeoutMs, 15_000);
  const timeoutId = setTimeout(() => controller.abort(), requestTimeoutMs);

  const callKey = await recordXCall('tweet_lookup', attribution);
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
    await finishXCall(callKey, 'failed', 'tweet_lookup');
    if (err instanceof Error && err.name === 'AbortError') {
      throw new Error('La llamada a la API de X superó el tiempo límite de 15 segundos.');
    }
    throw new Error(`Error de conexión al consultar la API de X: ${err instanceof Error ? err.message : 'Error de red'}`);
  } finally {
    clearTimeout(timeoutId);
  }

  if (!response.ok) {
    await finishXCall(callKey, 'failed', 'tweet_lookup', response.status);
    const errText = await response.text();
    throw new Error(`La API de X devolvió el estado HTTP ${response.status}: ${errText.slice(0, 200)}`);
  }

  const data = (await response.json()) as XApiResponse;
  await finishXCall(callKey, 'succeeded', 'tweet_lookup', response.status, data);

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

export async function resolveXUsername(username: string, attribution?: XCallAttribution, timeoutMs?: number): Promise<string> {
  const config = getConfig();
  if (!config.xBearerToken) {
    throw new Error('X_BEARER_TOKEN no está configurado en el servidor.');
  }

  const cleanUsername = username.replace(/^@/, '').trim();
  const apiUrl = `https://api.x.com/2/users/by/username/${cleanUsername}`;

  const controller = new AbortController();
  const requestTimeoutMs = boundedXTimeoutMs(timeoutMs, 10_000);
  const timeoutId = setTimeout(() => controller.abort(), requestTimeoutMs);

  const callKey = await recordXCall('user_lookup', attribution);
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
    await finishXCall(callKey, 'failed', 'user_lookup');
    throw new Error('Error de conexión al resolver usuario en X.');
  } finally {
    clearTimeout(timeoutId);
  }

  if (!response.ok) {
    await finishXCall(callKey, 'failed', 'user_lookup', response.status);
    throw new Error(`La API de X devolvió el estado HTTP ${response.status} al resolver el usuario.`);
  }

  const data = (await response.json()) as { data?: { id: string } };
  await finishXCall(callKey, 'succeeded', 'user_lookup', response.status, data as unknown as XApiResponse);
  if (!data.data || !data.data.id) {
    throw new Error(`El usuario ${username} no existe o está suspendido.`);
  }

  return data.data.id;
}

export async function fetchNewXPostsForAccount(
  xUserId: string,
  sincePostId: string | null,
  attribution?: XCallAttribution,
  timeoutMs?: number,
  paginationToken?: string,
  remainingPages = 5,
  initialPageOnly = false,
): Promise<XTimelineFetchResult> {
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
  }
  if (paginationToken) {
    url.searchParams.set('pagination_token', paginationToken);
  }

  const apiUrl = url.toString();

  const requestStartedAt = Date.now();
  const controller = new AbortController();
  const requestTimeoutMs = boundedXTimeoutMs(timeoutMs, 15_000);
  const timeoutId = setTimeout(() => controller.abort(), requestTimeoutMs);

  const callKey = await recordXCall('timeline_lookup', attribution);
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
    await finishXCall(callKey, 'failed', 'timeline_lookup');
    throw new Error('Error de red al consultar posts.');
  } finally {
    clearTimeout(timeoutId);
  }

  if (!response.ok) {
    await finishXCall(callKey, 'failed', 'timeline_lookup', response.status);
    throw new Error(`La API de X devolvió HTTP ${response.status}`);
  }

  const data = (await response.json()) as XApiResponse;
  await finishXCall(callKey, 'succeeded', 'timeline_lookup', response.status, data);
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
    // The API exclusion is only an optimisation.  Any reply received from an
    // unexpected/mocked response must still be excluded locally.
    const isReply = Boolean(tweet.in_reply_to_user_id);

    if (isRetweet || isReply) {
      continue;
    }

    // With no cursor this is initial/re-activation recovery. Expiry is checked
    // by the monitor using the campaign lifetime, not monitoring_started_at.

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

  const nextToken = data.meta?.next_token;
  // Recovery is deliberately a one-page operation. The monitor selects the
  // newest eligible original from this page and persists its cursor before
  // clearing the recovery flag; it must never walk older pages here.
  if (initialPageOnly) {
    return { posts: validPosts, complete: true };
  }
  if (nextToken) {
    if (remainingPages <= 1) return { posts: validPosts, complete: false };
    const elapsedMs = Date.now() - requestStartedAt;
    const next = await fetchNewXPostsForAccount(
      xUserId,
      sincePostId,
      attribution,
      Math.max(1, requestTimeoutMs - elapsedMs),
      nextToken,
      remainingPages - 1,
      false,
    );
    const posts = [...validPosts, ...next.posts];
    posts.sort((a, b) => {
      if (!a.postedAt || !b.postedAt) return 0;
      return new Date(a.postedAt).getTime() - new Date(b.postedAt).getTime();
    });
    return { posts, complete: next.complete };
  }

  return { posts: validPosts, complete: true };
}
