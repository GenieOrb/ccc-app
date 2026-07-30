import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const routerMock = { push: vi.fn(), refresh: vi.fn() };
vi.mock('next/navigation', () => ({ useRouter: () => routerMock }));
import AdminDashboardPage from './page';

const campaign = {
  id: 'campaign-1', internalNumber: 1, internalId: 'Campaña 001', slug: 'slug', publicUrl: 'http://localhost/comment/slug',
  displayName: 'Campaña de prueba', modelKey: 'gpt-5.4', isActive: true, safetyAllowed: true, xPosts: [], campaignType: 'manual', xAccounts: [],
  generationProgress: 0, validGeneratedCount: 0, availableCount: 0, assignedCount: 0, withdrawnCount: 0,
  pendingProcessingJobsCount: 0, failedJobsCount: 0, hasUnresolvedFailedCycle: false, createdAt: new Date().toISOString(),
};

function json(body: unknown, ok = true) { return { ok, status: ok ? 200 : 400, json: async () => body }; }

describe('administration campaign cards', () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    fetchMock.mockImplementation((input: string) => {
      if (input.includes('/api/admin/models')) return Promise.resolve(json({ models: [] }));
      if (input.includes('/preview')) return Promise.resolve(json({ previews: [] }));
      if (input.includes('/toggle')) return Promise.resolve(json({ success: true, isActive: false }));
      if (input.includes('/api/admin/campaigns')) return Promise.resolve(json({ items: [campaign], page: 1, total: 1, totalPages: 1 }));
      return Promise.resolve(json({}));
    });
    vi.stubGlobal('fetch', fetchMock);
  });

  it('starts collapsed, exposes an accessible arrow, and only fetches preview after expansion', async () => {
    render(<AdminDashboardPage />);
    const arrow = await screen.findByRole('button', { name: /expandir/i });
    expect(arrow.getAttribute('aria-expanded')).toBe('false');
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/preview'))).toBe(false);
    fireEvent.click(arrow);
    await waitFor(() => expect(arrow.getAttribute('aria-expanded')).toBe('true'));
    await waitFor(() => expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/preview'))).toBe(true));
    fireEvent.click(arrow);
    expect(arrow.getAttribute('aria-expanded')).toBe('false');
  });

  it('uses the persisted toggle response and does not change expansion', async () => {
    render(<AdminDashboardPage />);
    const arrow = await screen.findByRole('button', { name: /expandir/i });
    fireEvent.click(arrow);
    const toggle = await screen.findByRole('button', { name: 'Desactivar' });
    fireEvent.click(toggle);
    await waitFor(() => expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/toggle'))).toBe(true));
    expect(arrow.getAttribute('aria-expanded')).toBe('true');
  });

  it('updates only the toggled card after a successful persisted response', async () => {
    const second = { ...campaign, id: 'campaign-2', internalNumber: 2, internalId: 'CampaÃ±a 002', displayName: 'Segunda campaÃ±a' };
    fetchMock.mockImplementation((input: string) => {
      if (input.includes('/api/admin/models')) return Promise.resolve(json({ models: [] }));
      if (input.includes('/preview')) return Promise.resolve(json({ previews: [] }));
      if (input.includes('campaign-1/toggle')) return Promise.resolve(json({ success: true, isActive: false }));
      if (input.includes('/api/admin/campaigns')) return Promise.resolve(json({ items: [{ ...campaign, isActive: fetchMock.mock.calls.some(([url]) => String(url).includes('/toggle')) ? false : true }, second], page: 1, total: 2, totalPages: 1 }));
      return Promise.resolve(json({}));
    });
    render(<AdminDashboardPage />);
    fireEvent.click((await screen.findAllByRole('button', { name: /expandir/i }))[0]);
    const buttons = await screen.findAllByRole('button', { name: 'Desactivar' });
    fireEvent.click(buttons[0]);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Activar' })).toBeTruthy());
    expect(screen.getAllByRole('button', { name: 'Activar' })).toHaveLength(1);
  });

  it('keeps card state stable and re-enables its control when toggle fails', async () => {
    fetchMock.mockImplementation((input: string) => {
      if (input.includes('/api/admin/models')) return Promise.resolve(json({ models: [] }));
      if (input.includes('/preview')) return Promise.resolve(json({ previews: [] }));
      if (input.includes('/toggle')) return Promise.resolve(json({ error: 'No permitido' }, false));
      if (input.includes('/api/admin/campaigns')) return Promise.resolve(json({ items: [campaign], page: 1, total: 1, totalPages: 1 }));
      return Promise.resolve(json({}));
    });
    render(<AdminDashboardPage />);
    fireEvent.click(await screen.findByRole('button', { name: /expandir/i }));
    const toggle = await screen.findByRole('button', { name: 'Desactivar' });
    fireEvent.click(toggle);
    await waitFor(() => expect(screen.getByText('No permitido')).toBeTruthy());
    expect(screen.getByRole('button', { name: 'Desactivar' })).toBeTruthy();
  });

  it('prevents a second toggle while the first request remains pending', async () => {
    let resolveToggle: ((value: ReturnType<typeof json>) => void) | undefined;
    fetchMock.mockImplementation((input: string) => {
      if (input.includes('/api/admin/models')) return Promise.resolve(json({ models: [] }));
      if (input.includes('/preview')) return Promise.resolve(json({ previews: [] }));
      if (input.includes('/toggle')) return new Promise(resolve => { resolveToggle = resolve; });
      if (input.includes('/api/admin/campaigns')) return Promise.resolve(json({ items: [campaign], page: 1, total: 1, totalPages: 1 }));
      return Promise.resolve(json({}));
    });
    render(<AdminDashboardPage />);
    fireEvent.click(await screen.findByRole('button', { name: /expandir/i }));
    const toggle = await screen.findByRole('button', { name: 'Desactivar' });
    fireEvent.click(toggle);
    fireEvent.click(toggle);
    expect(fetchMock.mock.calls.filter(([url]) => String(url).includes('/toggle'))).toHaveLength(1);
    resolveToggle?.(json({ success: true, isActive: false }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Desactivar' })).toBeTruthy());
  });

  it('submits the default manual campaign with only its X post URLs', async () => {
    fetchMock.mockImplementation((input: string, init?: RequestInit) => {
      if (input.includes('/api/admin/models')) return Promise.resolve(json({ models: [] }));
      if (input === '/api/admin/campaigns' && init?.method === 'POST') return Promise.resolve(json({ success: true }));
      if (input.includes('/api/admin/campaigns')) return Promise.resolve(json({ items: [campaign], page: 1, total: 1, totalPages: 1 }));
      return Promise.resolve(json({}));
    });
    render(<AdminDashboardPage />);

    expect((await screen.findByLabelText(/tipo de campaña/i) as HTMLSelectElement).value).toBe('manual');
    expect(screen.queryByLabelText(/cuentas de x a monitorizar/i)).toBeNull();
    fireEvent.change(screen.getByLabelText(/urls de los posts de x/i), {
      target: { value: 'https://x.com/genieorb/status/123' },
    });
    fireEvent.click(screen.getByRole('button', { name: /crear campaña/i }));

    await waitFor(() => {
      const postCall = fetchMock.mock.calls.find(([url, init]) =>
        String(url) === '/api/admin/campaigns' && (init as RequestInit | undefined)?.method === 'POST',
      );
      expect(postCall).toBeTruthy();
      const payload = JSON.parse((postCall?.[1] as RequestInit).body as string);
      expect(payload).toMatchObject({ campaignType: 'manual', urlsInput: 'https://x.com/genieorb/status/123' });
      expect(payload).not.toHaveProperty('accountsInput');
    });
    await waitFor(() => expect(fetchMock.mock.calls.filter(([url]) => String(url).includes('/api/admin/campaigns?page=1'))).toHaveLength(2));
  });
});
