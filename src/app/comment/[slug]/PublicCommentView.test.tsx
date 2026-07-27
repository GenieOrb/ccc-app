import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import PublicCommentView from './PublicCommentView';

const banner = 'Promocionate con nuestra APP, mas info aqui.';
const json = (body: unknown, ok = true) => ({ ok, json: async () => body });

describe('PublicCommentView banner', () => {
  afterEach(() => vi.unstubAllGlobals());

  for (const [name, response] of [
    ['error', json({ status: 'error' }, false)],
    ['unavailable', json({ status: 'unavailable' })],
    ['generating', json({ status: 'generating', retryAfterMs: 60_000 })],
    ['expired', json({ status: 'expired' })],
    ['success', json({ status: 'success', assignmentId: 'a1', comment: 'A comment' })],
  ] as const) {
    it(`renders the exact single banner while ${name}`, async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response));
      render(<PublicCommentView slug="test" />);
      expect(screen.getAllByText(banner, { exact: true })).toHaveLength(1);
      await waitFor(() => expect(screen.getByText(banner, { exact: true })).toBeTruthy());
      expect(screen.getAllByText(banner, { exact: true })).toHaveLength(1);
    });
  }

  it('renders the exact single banner during initial loading', () => {
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})));
    render(<PublicCommentView slug="test" />);
    expect(screen.getAllByText(banner, { exact: true })).toHaveLength(1);
  });
});
