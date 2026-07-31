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
    ['success', json({ status: 'success', assignmentId: 'a1', comment: 'A comment', replyIntentUrl: 'https://x.com/intent/tweet?in_reply_to=1' })],
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

  it('navigates via native link without blocking on completion fetch', async () => {
    const complete = vi.fn().mockResolvedValue(json({ status: 'success' }));
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(json({ status: 'success', assignmentId: 'a1', comment: 'A comment', postUrl: 'https://x.com/user/status/1', replyIntentUrl: 'https://x.com/intent/tweet?in_reply_to=1' }))
      .mockImplementationOnce(complete));
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } });
    const user = userEvent.setup();

    render(<PublicCommentView slug="test" />);
    await user.click(await screen.findByRole('button', { name: 'Copy' }));

    // The Post button is now a link
    const link = screen.getByRole('link', { name: 'Post' });
    expect(link.getAttribute('href')).toBe('https://x.com/intent/tweet?in_reply_to=1');
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toBe('noopener noreferrer');
    expect(link.getAttribute('referrerpolicy')).toBe('no-referrer');

    await user.click(link);

    // The fetch should happen in parallel, with keepalive true
    expect(complete).toHaveBeenCalled();
    const fetchCall = vi.mocked(fetch).mock.calls[1];
    expect(fetchCall[0]).toContain('/complete');
    expect(fetchCall[1]?.keepalive).toBe(true);
  });

  it('does not crash if tracking fails', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(json({ status: 'success', assignmentId: 'a1', comment: 'A comment', postUrl: 'https://x.com/user/status/1', replyIntentUrl: 'https://x.com/intent/tweet?in_reply_to=1' }))
      .mockRejectedValueOnce(new Error('Network error')));
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } });
    const user = userEvent.setup();

    render(<PublicCommentView slug="test" />);
    await user.click(await screen.findByRole('button', { name: 'Copy' }));

    const link = screen.getByRole('link', { name: 'Post' });
    await user.click(link);

    expect(await screen.findByText('Please try again')).toBeTruthy();
  });
});
