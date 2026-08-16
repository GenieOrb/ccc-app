import { render, screen, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import PublicCommentView from './PublicCommentView';

const banner = 'Get thousands of original comments from real users for your posts.';
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
      expect(screen.getByText(/Promote with us:/i)).toBeTruthy();
      expect(screen.getByRole('link', { name: 'https://t.me/PunkPinkTG' }).getAttribute('href')).toBe('https://t.me/PunkPinkTG');
      expect(screen.queryByText('ccc-app')).toBeNull();

      await act(async () => {
        resolveFetch(response);
      });

      await waitFor(() => {
        expect(screen.queryByText(banner, { exact: true })).toBeTruthy();
      });

      expect(screen.getAllByText(banner, { exact: true })).toHaveLength(1);
      expect(screen.getByText(/Promote with us:/i)).toBeTruthy();
      expect(screen.getByRole('link', { name: 'https://t.me/PunkPinkTG' }).getAttribute('href')).toBe('https://t.me/PunkPinkTG');
      expect(screen.queryByText('ccc-app')).toBeNull();

      unmount();
    });
  }

  it('renders the exact single banner during initial loading', async () => {
    let resolveFetch!: (value: unknown) => void;
    const fetchPromise = new Promise((resolve) => { resolveFetch = resolve; });
    vi.stubGlobal('fetch', vi.fn(() => fetchPromise));

    const { unmount } = render(<PublicCommentView slug="test" />);

    expect(screen.getAllByText(banner, { exact: true })).toHaveLength(1);
    expect(screen.getByText(/Promote with us:/i)).toBeTruthy();
    expect(screen.getByRole('link', { name: 'https://t.me/PunkPinkTG' }).getAttribute('href')).toBe('https://t.me/PunkPinkTG');
    expect(screen.queryByText('ccc-app')).toBeNull();

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

  it('navigates to canonical postUrl on mobile instead of using intent', async () => {
    // Simulamos un entorno móvil
    vi.stubGlobal('navigator', { ...navigator, userAgent: 'iPhone', clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } });
    let resolveFetch!: (value: unknown) => void;
    const fetchPromise = new Promise((resolve) => { resolveFetch = resolve; });

    vi.stubGlobal('fetch', vi.fn().mockImplementationOnce(() => fetchPromise).mockResolvedValue(json({ status: 'success' })));
    const user = userEvent.setup();

    const { unmount } = render(<PublicCommentView slug="test" />);

    await act(async () => {
      resolveFetch(json({ status: 'success', assignmentId: 'a1', comment: 'A comment', postUrl: 'https://x.com/user/status/1', replyIntentUrl: 'https://x.com/intent/tweet?in_reply_to=1' }));
    });

    await user.click(await screen.findByRole('button', { name: 'Copy' }));

    const link = screen.getByRole('link', { name: 'Post' });
    expect(link.getAttribute('href')).toBe('https://x.com/user/status/1'); // Se usó el postUrl directo en lugar del intent
    unmount();
  });

  it('button is disabled if no valid identifiers are present', async () => {
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } });
    let resolveFetch!: (value: unknown) => void;
    const fetchPromise = new Promise((resolve) => { resolveFetch = resolve; });

    vi.stubGlobal('fetch', vi.fn().mockImplementationOnce(() => fetchPromise));
    const user = userEvent.setup();

    const { unmount } = render(<PublicCommentView slug="test" />);

    await act(async () => {
      // Sin postUrl ni replyIntentUrl
      resolveFetch(json({ status: 'success', assignmentId: 'a1', comment: 'A comment', postUrl: '', replyIntentUrl: '' }));
    });

    await user.click(await screen.findByRole('button', { name: 'Copy' }));

    // El botón debe seguir deshabilitado y no ser un link
    const button = screen.getByRole('button', { name: 'Post' });
    expect((button as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByRole('link', { name: 'Post' })).toBeNull();
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

    await act(async () => {
      await user.click(link);
      rejectComplete(new Error('Network error'));
    });

    expect(await screen.findByText('Please try again')).toBeTruthy();

    unmount();
  });

  it('renders a meme assignment with download and only completes after Post', async () => {
    const complete = vi.fn().mockResolvedValue(json({ status: 'success' }));
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(json({
        status: 'success', type: 'meme', assignmentId: 'meme-assignment',
        postUrl: 'https://x.com/user/status/1',
        viewUrl: '/api/public/comment/test/assignment/meme-assignment/view',
        downloadUrl: '/api/public/comment/test/assignment/meme-assignment/download',
      }))
      .mockImplementationOnce(complete));
    const user = userEvent.setup();
    render(<PublicCommentView slug="test" />);

    expect(await screen.findByText(/tap “download” to save the image/i)).toBeTruthy();
    expect(screen.getByRole('img', { name: 'Meme' }).getAttribute('src')).toContain('/view');
    const download = screen.getByRole('link', { name: 'Download' });
    expect(download.getAttribute('href')).toContain('/download');
    expect(download.hasAttribute('download')).toBe(true);
    expect((screen.getByRole('button', { name: 'Post' }) as HTMLButtonElement).disabled).toBe(true);
    expect(complete).not.toHaveBeenCalled();

    await user.click(download);
    const post = screen.getByRole('link', { name: 'Post' });
    expect(complete).not.toHaveBeenCalled();
    await user.click(post);
    await waitFor(() => expect(complete).toHaveBeenCalledTimes(1));
    expect(vi.mocked(fetch).mock.calls[1][0]).toContain('/assignment/complete');
    expect(JSON.parse((vi.mocked(fetch).mock.calls[1][1] as RequestInit).body as string)).toEqual({ assignmentId: 'meme-assignment' });
  });
});
