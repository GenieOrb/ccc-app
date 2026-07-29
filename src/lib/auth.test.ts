import { beforeEach, describe, expect, it, vi } from 'vitest';

const { cookieStore, getConfig } = vi.hoisted(() => ({
  cookieStore: { get: vi.fn(), set: vi.fn() },
  getConfig: vi.fn(() => ({ adminSessionSecret: 'test-session-secret', adminPasswordHash: '', appBaseUrl: 'http://localhost:3000' })),
}));

vi.mock('next/headers', () => ({ cookies: async () => cookieStore }));
vi.mock('./config', () => ({ getConfig }));
vi.mock('./crypto', () => ({
  createHmacHash: (value: string, secret: string) => `${secret}-${value.replaceAll(':', '_')}`,
  safeCompareStrings: (left: string, right: string) => left === right,
  verifyScryptPassword: () => false,
}));

import { clearAdminSessionCookie, createSessionToken, isAdminAuthenticated, setAdminSessionCookie } from './auth';

describe('admin session cookie', () => {
  beforeEach(() => {
    cookieStore.get.mockReset();
    cookieStore.set.mockReset();
    getConfig.mockClear();
  });

  it('issues a persistent strict cookie and renews it after a valid request', async () => {
    await setAdminSessionCookie();
    expect(cookieStore.set).toHaveBeenLastCalledWith('__comment_app_admin_session', expect.any(String), expect.objectContaining({
      httpOnly: true, sameSite: 'strict', path: '/', maxAge: 8 * 60 * 60,
    }));

    cookieStore.get.mockReturnValue({ value: createSessionToken() });
    await expect(isAdminAuthenticated()).resolves.toBe(true);
    expect(cookieStore.set).toHaveBeenCalledTimes(2);
  });

  it('deletes with the same scope used to create the cookie', async () => {
    await clearAdminSessionCookie();
    expect(cookieStore.set).toHaveBeenCalledWith('__comment_app_admin_session', '', expect.objectContaining({
      httpOnly: true, sameSite: 'strict', path: '/', maxAge: 0, expires: new Date(0),
    }));
  });

  it('does not refresh malformed or expired sessions', async () => {
    cookieStore.get.mockReturnValue({ value: 'not-a-session' });
    await expect(isAdminAuthenticated()).resolves.toBe(false);
    expect(cookieStore.set).not.toHaveBeenCalled();

    const issuedAt = Date.now() - 8 * 60 * 60 * 1000 - 1;
    cookieStore.get.mockReturnValue({ value: `admin:${issuedAt}:test-session-secret-admin_${issuedAt}` });
    await expect(isAdminAuthenticated()).resolves.toBe(false);
    expect(cookieStore.set).not.toHaveBeenCalled();
  });

  it('keeps a valid read-only render authenticated when renewal is unavailable', async () => {
    cookieStore.get.mockReturnValue({ value: createSessionToken() });
    cookieStore.set.mockImplementation(() => { throw new Error('read-only cookies'); });

    await expect(isAdminAuthenticated()).resolves.toBe(true);
    expect(cookieStore.set).toHaveBeenCalledTimes(1);
  });

  it('slides the signed timestamp on a valid mutable request', async () => {
    const now = vi.spyOn(Date, 'now');
    const issuedAt = Date.now();
    now.mockReturnValueOnce(issuedAt).mockReturnValue(issuedAt + 1_000);
    cookieStore.get.mockReturnValue({ value: createSessionToken() });
    await expect(isAdminAuthenticated()).resolves.toBe(true);
    expect(cookieStore.set).toHaveBeenCalledWith('__comment_app_admin_session', `admin:${issuedAt + 1_000}:test-session-secret-admin_${issuedAt + 1_000}`, expect.any(Object));
    now.mockRestore();
  });
});
