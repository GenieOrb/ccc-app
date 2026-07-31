export const X_PRICING = {
  POST_READ_USD: 0.005,
  USER_READ_USD: 0.010,
  CURRENCY: 'USD',
  EFFECTIVE_DATE: '2026-07-31'
} as const;

export function getUtcDedupDate(date: Date = new Date()): string {
  return date.toISOString().split('T')[0];
}
