import { describe, it, expect } from 'vitest';
import { X_PRICING, getUtcDedupDate } from './x-pricing';

describe('X Pricing Configuration', () => {
  it('should have the correct prices and currency', () => {
    expect(X_PRICING.POST_READ_USD).toBe(0.005);
    expect(X_PRICING.USER_READ_USD).toBe(0.010);
    expect(X_PRICING.CURRENCY).toBe('USD');
  });

  it('should have the correct effective date', () => {
    expect(X_PRICING.EFFECTIVE_DATE).toBe('2026-07-31');
  });

  it('should generate correct UTC dedup date', () => {
    const d = new Date('2026-07-31T15:00:00Z');
    expect(getUtcDedupDate(d)).toBe('2026-07-31');
  });
});
