import { render, screen, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import PublicCommentView from './PublicCommentView';

const banner = 'ccc-app';
const json = (body: unknown, ok = true) => ({ ok, json: async () => body });

describe('PublicCommentView banner', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  for (const [name, response] of [
    ['error', json({ status: 'error' }, false)],
    ['unavailable', json({ status: 'unavailable' })],
    ['generating', json({ status: 'generating', retryAfterMs: 60_000 })],
    ['expired', json({ status: 'expired' })],
    ['success', json({ status: 'success', assignmentId: 'a1', comment: 'A comment', replyIntentUrl: 'https://x.com/intent/tweet?in_reply_to=1' })],
  ] as const) {
    it(`renders the exact single banner while ${name}`, async () => {
      let resolveFetch!: (value: unknown) => void;
      const fetchPromise = new Promise((resolve) => { resolveFetch = resolve; });
      vi.stubGlobal('fetch', vi.fn(() => fetchPromise));

      const { unmount } = render(<PublicCommentView slug="test" />);

      expect(screen.getAllByText(banner, { exact: true })).toHaveLength(1);
      expect(screen.queryByText(/Promote with us:/i)).toBeNull();
      expect(screen.queryByRole('link', { name: 'https://t.me/PunkPinkTG' })).toBeNull();

      await act(async () => {
        resolveFetch(response);
      });

      await waitFor(() => {
        expect(screen.queryByText(banner, { exact: true })).toBeTruthy();
      });

      expect(screen.getAllByText(banner, { exact: true })).toHaveLength(1);
      expect(screen.queryByText(/Promote with us:/i)).toBeNull();
      expect(screen.queryByRole('link', { name: 'https://t.me/PunkPinkTG' })).toBeNull();

      unmount();
    });
  }

  it('renders the exact single banner during initial loading', async () => {
    let resolveFetch!: (value: unknown) => void;
    const fetchPromise = new Promise((resolve) => { resolveFetch = resolve; });
    vi.stubGlobal('fetch', vi.fn(() => fetchPromise));

    const { unmount } = render(<PublicCommentView slug="test" />);

    expect(screen.getAllByText(banner, { exact: true })).toHaveLength(1);
    expect(screen.queryByText(/Promote with us:/i)).toBeNull();
    expect(screen.queryByRole('link', { name: 'https://t.me/PunkPinkTG' })).toBeNull();

    await act(async () => {
      resolveFetch(json({ status: 'error' }, false));
    });

    unmount();
  });

  it('navigates via native link without blocking on completion fetch', async () => {
    let resolveFetch!: (value: unknown) => void;
    const fetchPromise = new Promise((resolve) => { resolveFetch = resolve; });

    const complete = vi.fn().mockResolvedValue(json({ status: 'success' }));
    vi.stubGlobal('fetch', vi.fn()
      .mockImplementationOnce(() => fetchPromise)
      .mockImplementationOnce(complete));
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } });
    const user = userEvent.setup();

    const { unmount } = render(<PublicCommentView slug="test" />);

    await act(async () => {
      resolveFetch(json({ status: 'success', assignmentId: 'a1', comment: 'A comment', postUrl: 'https://x.com/user/status/1', replyIntentUrl: 'https://x.com/intent/tweet?in_reply_to=1' }));
    });

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

    unmount();
  });

  it('does not crash if tracking fails', async () => {
    let resolveFetch!: (value: unknown) => void;
    const fetchPromise = new Promise((resolve) => { resolveFetch = resolve; });

    let rejectComplete!: (reason: unknown) => void;
    const completePromise = new Promise((_, reject) => { rejectComplete = reject; });

    vi.stubGlobal('fetch', vi.fn()
      .mockImplementationOnce(() => fetchPromise)
      .mockImplementationOnce(() => completePromise));
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } });
    const user = userEvent.setup();

    const { unmount } = render(<PublicCommentView slug="test" />);

    await act(async () => {
      resolveFetch(json({ status: 'success', assignmentId: 'a1', comment: 'A comment', postUrl: 'https://x.com/user/status/1', replyIntentUrl: 'https://x.com/intent/tweet?in_reply_to=1' }));
    });

    await user.click(await screen.findByRole('button', { name: 'Copy' }));

    const link = screen.getByRole('link', { name: 'Post' });

    // Do not await user.click directly if we are throwing inside unhandled promises, but we will catch it in the act block.
    await act(async () => {
      await user.click(link);
      rejectComplete(new Error('Network error'));
    });

    expect(await screen.findByText('Please try again')).toBeTruthy();

    unmount();
  });
});
