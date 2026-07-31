import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import PublicCommentView from './PublicCommentView';

const banner = 'Get thousands of original comments from real users for your posts.';
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
      expect(screen.getAllByText(/Promote with us:/i)).toHaveLength(1);
      const link = screen.getByRole('link', { name: 'https://t.me/PunkPinkTG' });
      expect(link.getAttribute('href')).toBe('https://t.me/PunkPinkTG');
      expect(link.getAttribute('target')).toBe('_blank');
      expect(link.getAttribute('rel')).toBe('noopener noreferrer');

      await waitFor(() => expect(screen.getByText(banner, { exact: true })).toBeTruthy());
      expect(screen.getAllByText(banner, { exact: true })).toHaveLength(1);
      expect(screen.getAllByText(/Promote with us:/i)).toHaveLength(1);
      expect(screen.getByRole('link', { name: 'https://t.me/PunkPinkTG' })).toBeTruthy();
    });
  }

  it('renders the exact single banner during initial loading', () => {
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})));
    render(<PublicCommentView slug="test" />);
    expect(screen.getAllByText(banner, { exact: true })).toHaveLength(1);
    expect(screen.getAllByText(/Promote with us:/i)).toHaveLength(1);
    const link = screen.getByRole('link', { name: 'https://t.me/PunkPinkTG' });
    expect(link.getAttribute('href')).toBe('https://t.me/PunkPinkTG');
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toBe('noopener noreferrer');
  });

  it('opens the assigned X post synchronously before completing the assignment', async () => {
    const complete = vi.fn().mockResolvedValue(json({ status: 'success' }));
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(json({ status: 'success', assignmentId: 'a1', comment: 'A comment', postUrl: 'https://x.com/user/status/1' }))
      .mockImplementationOnce(complete));
    vi.stubGlobal('open', vi.fn().mockReturnValue({}));
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } });
    const user = userEvent.setup();

    render(<PublicCommentView slug="test" />);
    await user.click(await screen.findByRole('button', { name: 'Copy' }));
    await user.click(screen.getByRole('button', { name: 'Post' }));

    expect(window.open).toHaveBeenCalledWith('https://x.com/user/status/1', '_blank', 'noopener,noreferrer');
    expect(complete).toHaveBeenCalled();
  });

  it('shows a generic error when the post popup is blocked', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({ status: 'success', assignmentId: 'a1', comment: 'A comment', postUrl: 'https://x.com/user/status/1' })));
    vi.stubGlobal('open', vi.fn().mockReturnValue(null));
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } });
    const user = userEvent.setup();

    render(<PublicCommentView slug="test" />);
    await user.click(await screen.findByRole('button', { name: 'Copy' }));
    await user.click(screen.getByRole('button', { name: 'Post' }));

    expect(await screen.findByText('Please try again')).toBeTruthy();
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
