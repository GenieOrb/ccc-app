import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getInternalProcessSecret, buildInternalProcessAuthorizationHeader, isAuthorizedInternalProcessRequest } from './internal-process-auth';
import * as configModule from './config';

vi.mock('./config', () => ({
  getConfig: vi.fn(),
}));

describe('internal-process-auth', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  describe('getInternalProcessSecret', () => {
    it('should return internalProcessSecret if available', () => {
      vi.mocked(configModule.getConfig).mockReturnValue({
        internalProcessSecret: 'secret1',
        cronSecret: 'secret2',
      } as Record<string, unknown>);
      expect(getInternalProcessSecret()).toBe('secret1');
    });

    it('should return cronSecret if internalProcessSecret is not available', () => {
      vi.mocked(configModule.getConfig).mockReturnValue({
        internalProcessSecret: undefined,
        cronSecret: 'secret2',
      } as Record<string, unknown>);
      expect(getInternalProcessSecret()).toBe('secret2');
    });

    it('should return null if neither is available', () => {
      vi.mocked(configModule.getConfig).mockReturnValue({
        internalProcessSecret: undefined,
        cronSecret: undefined,
      } as Record<string, unknown>);
      expect(getInternalProcessSecret()).toBeNull();
    });
  });

  describe('buildInternalProcessAuthorizationHeader', () => {
    it('should build header with valid secret', () => {
      vi.mocked(configModule.getConfig).mockReturnValue({
        internalProcessSecret: 'secret1',
      } as Record<string, unknown>);
      expect(buildInternalProcessAuthorizationHeader()).toBe('Bearer secret1');
    });

    it('should throw error if no secret is available', () => {
      vi.mocked(configModule.getConfig).mockReturnValue({} as Record<string, unknown>);
      expect(() => buildInternalProcessAuthorizationHeader()).toThrow('No hay secreto interno o cron configurado para la autenticación.');
    });
  });

  describe('isAuthorizedInternalProcessRequest', () => {
    it('should reject request without authorization header', () => {
      vi.mocked(configModule.getConfig).mockReturnValue({ internalProcessSecret: 'secret1' } as Record<string, unknown>);
      const req = new Request('http://localhost', { headers: {} });
      expect(isAuthorizedInternalProcessRequest(req)).toBe(false);
    });

    it('should reject request with non-Bearer header', () => {
      vi.mocked(configModule.getConfig).mockReturnValue({ internalProcessSecret: 'secret1' } as Record<string, unknown>);
      const req = new Request('http://localhost', { headers: { authorization: 'Basic secret1' } });
      expect(isAuthorizedInternalProcessRequest(req)).toBe(false);
    });

    it('should reject empty Bearer token', () => {
      vi.mocked(configModule.getConfig).mockReturnValue({ internalProcessSecret: 'secret1' } as Record<string, unknown>);
      const req = new Request('http://localhost', { headers: { authorization: 'Bearer ' } });
      expect(isAuthorizedInternalProcessRequest(req)).toBe(false);
    });

    it('should reject when secrets are missing in config', () => {
      vi.mocked(configModule.getConfig).mockReturnValue({} as Record<string, unknown>);
      const req = new Request('http://localhost', { headers: { authorization: 'Bearer secret1' } });
      expect(isAuthorizedInternalProcessRequest(req)).toBe(false);
    });

    it('should reject invalid secret', () => {
      vi.mocked(configModule.getConfig).mockReturnValue({ internalProcessSecret: 'secret1', cronSecret: 'secret2' } as Record<string, unknown>);
      const req = new Request('http://localhost', { headers: { authorization: 'Bearer invalid' } });
      expect(isAuthorizedInternalProcessRequest(req)).toBe(false);
    });

    it('should accept internalProcessSecret', () => {
      vi.mocked(configModule.getConfig).mockReturnValue({ internalProcessSecret: 'secret1', cronSecret: 'secret2' } as Record<string, unknown>);
      const req = new Request('http://localhost', { headers: { authorization: 'Bearer secret1' } });
      expect(isAuthorizedInternalProcessRequest(req)).toBe(true);
    });

    it('should accept cronSecret', () => {
      vi.mocked(configModule.getConfig).mockReturnValue({ internalProcessSecret: 'secret1', cronSecret: 'secret2' } as Record<string, unknown>);
      const req = new Request('http://localhost', { headers: { authorization: 'Bearer secret2' } });
      expect(isAuthorizedInternalProcessRequest(req)).toBe(true);
    });
  });
});
