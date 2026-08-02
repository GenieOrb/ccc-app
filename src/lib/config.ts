import 'server-only';

export interface AppConfig {
  databaseUrl: string;
  appBaseUrl: string;
  openaiApiKey: string;
  openaiModel: string;
  deepseekApiKey: string;
  deepseekBaseUrl: string;
  dashscopeApiKey: string;
  qwenBaseUrl: string;
  geminiApiKey: string;
  xBearerToken: string;
  adminPasswordHash: string;
  adminSessionSecret: string;
  visitorCookieSecret: string;
  securityHmacSecret: string;
  internalProcessSecret: string;
  cronSecret: string;
}

let cachedConfig: AppConfig | null = null;

export function getConfig(): AppConfig {
  if (cachedConfig) {
    return cachedConfig;
  }

  const databaseUrl = process.env.DATABASE_URL || '';
  const isProd = process.env.NODE_ENV === 'production';
  const appBaseUrl = process.env.APP_BASE_URL || (isProd ? '' : 'http://localhost:3000');
  
  if (isProd && !appBaseUrl) {
    throw new Error('APP_BASE_URL must be strictly defined in production and cannot fallback to localhost.');
  }
  const openaiApiKey = process.env.OPENAI_API_KEY || '';
  const openaiModel = process.env.OPENAI_MODEL || 'gpt-5.4';
  const deepseekApiKey = process.env.DEEPSEEK_API_KEY || '';
  const deepseekBaseUrl = process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com';
  const dashscopeApiKey = process.env.DASHSCOPE_API_KEY || process.env.QWEN_API_KEY || '';
  const qwenBaseUrl = process.env.QWEN_BASE_URL || '';
  const geminiApiKey = process.env.GEMINI_API_KEY || '';
  const xBearerToken = process.env.X_BEARER_TOKEN || '';
  const adminPasswordHash = process.env.ADMIN_PASSWORD_HASH || '';
  const adminSessionSecret = process.env.ADMIN_SESSION_SECRET || '';
  const visitorCookieSecret = process.env.VISITOR_COOKIE_SECRET || '';
  const securityHmacSecret = process.env.SECURITY_HMAC_SECRET || '';
  const internalProcessSecret = process.env.INTERNAL_PROCESS_SECRET || '';
  const cronSecret = process.env.CRON_SECRET || '';

  cachedConfig = {
    databaseUrl,
    appBaseUrl: appBaseUrl.replace(/\/+$/, ''),
    openaiApiKey,
    openaiModel,
    deepseekApiKey,
    deepseekBaseUrl,
    dashscopeApiKey,
    qwenBaseUrl,
    geminiApiKey,
    xBearerToken,
    adminPasswordHash,
    adminSessionSecret,
    visitorCookieSecret,
    securityHmacSecret,
    internalProcessSecret,
    cronSecret,
  };

  return cachedConfig;
}

export function validateRequiredConfig(keys: (keyof AppConfig)[]): void {
  const config = getConfig();
  for (const key of keys) {
    const val = config[key];
    if (!val || typeof val !== 'string' || val.trim().length === 0) {
      throw new Error(`Missing or empty required environment variable for key: ${key}`);
    }
  }
}
