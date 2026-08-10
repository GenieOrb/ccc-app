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
  recordedCost: 0.125, aiRecordedCost: 0.100, xRecordedCost: 0.025, costIsComplete: true, unknownAiCostCalls: 0, unknownXCostCalls: 0, limitReached: false, maxCommentsTotal: undefined,
};

function json(body: unknown, ok = true) {
  return {
    ok,
    status: ok ? 200 : 400,
    headers: new Headers({
      'content-type': 'application/json',
    }),
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

describe('administration campaign cards', () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    fetchMock.mockImplementation((input: string) => {
      if (input.includes('/api/admin/models')) return Promise.resolve(json({ models: [] }));
      if (input.includes('/api/admin/image-models')) return Promise.resolve(json({ models: [{ key: 'image-ready', displayName: 'Image Ready', costPerImage: 0.01, configured: true, enabled: true }] }));
      if (input.includes('/preview')) return Promise.resolve(json({ previews: [] }));
      if (input.includes('/toggle')) return Promise.resolve(json({ success: true, isActive: false }));
      if (input.includes('/api/admin/campaigns')) return Promise.resolve(json({ items: [campaign], page: 1, total: 1, totalPages: 1 }));
      return Promise.resolve(json({}));
    });
    vi.stubGlobal('fetch', fetchMock);
  });

  it('enables the meme system by default', async () => {
    render(<AdminDashboardPage />);
    expect((await screen.findByLabelText(/habilitar sistema de memes/i) as HTMLInputElement).checked).toBe(true);
  });

  it('blocks meme-dependent actions with no configured image model while leaving comment preview available', async () => {
    fetchMock.mockImplementation((input: string) => {
      if (input.includes('/api/admin/models')) return Promise.resolve(json({ models: [] }));
      if (input.includes('/api/admin/image-models')) return Promise.resolve(json({ models: [] }));
      if (input.includes('/api/admin/campaigns')) return Promise.resolve(json({ items: [campaign], page: 1, total: 1, totalPages: 1 }));
      return Promise.resolve(json({}));
    });
    render(<AdminDashboardPage />);
    fireEvent.change(await screen.findByLabelText(/urls de los posts de x/i), { target: { value: 'https://x.com/genieorb/status/123' } });
    const imageSelector = screen.getByLabelText(/modelo generador de im[aá]genes/i) as HTMLSelectElement;
    expect(imageSelector.disabled).toBe(true);
    expect(imageSelector.value).toBe('');
    expect((screen.getByRole('button', { name: /crear campa[añ]a/i }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: /^guardar$/i }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: /generar 3 memes/i }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: /generar preview de comentarios/i }) as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: /generar 3 memes/i }));
    expect(fetchMock.mock.calls.some(([url, init]) => String(url) === '/api/admin/campaigns/preview/memes' && (init as RequestInit | undefined)?.method === 'POST')).toBe(false);
  });

  it('keeps all meme actions blocked while the image-model catalog is loading', async () => {
    let resolveCatalog: ((value: ReturnType<typeof json>) => void) | undefined;
    fetchMock.mockImplementation((input: string) => {
      if (input.includes('/api/admin/models')) return Promise.resolve(json({ models: [] }));
      if (input.includes('/api/admin/image-models')) return new Promise((resolve) => { resolveCatalog = resolve; });
      if (input.includes('/api/admin/campaigns')) return Promise.resolve(json({ items: [campaign], page: 1, total: 1, totalPages: 1 }));
      return Promise.resolve(json({}));
    });
    render(<AdminDashboardPage />);
    fireEvent.change(await screen.findByLabelText(/urls de los posts de x/i), { target: { value: 'https://x.com/genieorb/status/123' } });
    expect(screen.getByRole('status').textContent).toMatch(/cargando catálogo/i);
    expect((screen.getByRole('button', { name: /crear campaña/i }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: /generar 3 memes/i }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: /generar preview de comentarios/i }) as HTMLButtonElement).disabled).toBe(false);
    resolveCatalog?.(json({ models: [] }));
  });

  it('reports a catalog error, blocks meme POSTs, and allows a campaign without memes', async () => {
    fetchMock.mockImplementation((input: string, init?: RequestInit) => {
      if (input.includes('/api/admin/models')) return Promise.resolve(json({ models: [] }));
      if (input.includes('/api/admin/image-models')) return Promise.resolve(json({ error: 'unavailable' }, false));
      if (input === '/api/admin/campaigns' && init?.method === 'POST') return Promise.resolve(json({ success: true }));
      if (input.includes('/api/admin/campaigns')) return Promise.resolve(json({ items: [campaign], page: 1, total: 1, totalPages: 1 }));
      return Promise.resolve(json({}));
    });
    render(<AdminDashboardPage />);
    fireEvent.change(await screen.findByLabelText(/urls de los posts de x/i), { target: { value: 'https://x.com/genieorb/status/123' } });
    expect((await screen.findByRole('alert')).textContent).toMatch(/no se pudo cargar/i);
    fireEvent.click(screen.getByRole('button', { name: /generar 3 memes/i }));
    expect(fetchMock.mock.calls.some(([url, init]) => String(url) === '/api/admin/campaigns/preview/memes' && (init as RequestInit | undefined)?.method === 'POST')).toBe(false);
    fireEvent.click(screen.getByLabelText(/habilitar sistema de memes/i));
    fireEvent.click(screen.getByRole('button', { name: /crear campaña/i }));
    await waitFor(() => {
      const request = fetchMock.mock.calls.find(([url, init]) => String(url) === '/api/admin/campaigns' && (init as RequestInit | undefined)?.method === 'POST');
      expect(request).toBeTruthy();
      const payload = JSON.parse((request?.[1] as RequestInit).body as string);
      expect(payload).toMatchObject({ includeMemes: false });
      expect(payload).not.toHaveProperty('memeModelKey');
      expect(payload).not.toHaveProperty('memePercentage');
    });
  });

  it('selects the first configured image model and allows meme actions', async () => {
    fetchMock.mockImplementation((input: string) => {
      if (input.includes('/api/admin/models')) return Promise.resolve(json({ models: [] }));
      if (input.includes('/api/admin/image-models')) return Promise.resolve(json({ models: [{ key: 'image-ready', displayName: 'Image Ready', costPerImage: 0.01, configured: true, enabled: true }] }));
      if (input.includes('/api/admin/campaigns')) return Promise.resolve(json({ items: [campaign], page: 1, total: 1, totalPages: 1 }));
      return Promise.resolve(json({}));
    });
    render(<AdminDashboardPage />);
    fireEvent.change(await screen.findByLabelText(/urls de los posts de x/i), { target: { value: 'https://x.com/genieorb/status/123' } });
    await waitFor(() => expect((screen.getByLabelText(/modelo generador de im[aá]genes/i) as HTMLSelectElement).value).toBe('image-ready'));
    expect((screen.getByRole('button', { name: /crear campa[añ]a/i }) as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByRole('button', { name: /generar 3 memes/i }) as HTMLButtonElement).disabled).toBe(false);
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

  it('shows the campaign accumulated recorded cost', async () => {
    render(<AdminDashboardPage />);

    const label = await screen.findByText('Costo acumulado');
    const costItem = label.closest('.stat-item');

    expect(costItem).not.toBeNull();

    const normalizedText =
      costItem?.textContent?.replace(/\s+/g, ' ') ?? '';

    expect(normalizedText).toContain('$0.125');
    expect(normalizedText).toContain('IA: $0.100');
    expect(normalizedText).toContain('X API: $0.025');
  });

  it('shows the latest synchronization checkpoint for a perpetual X account', async () => {
    const perpetual = {
      ...campaign,
      campaignType: 'perpetual' as const,
      xAccounts: [{ id: 'account-1', username: 'author', usernameNormalized: 'author', isRemoved: false, createdAt: new Date().toISOString(), lastCheckpoint: { phase: 'completed', severity: 'error' as const, createdAt: new Date().toISOString(), errorCode: 'MONITOR_DB_IMPORT_FAILED' }}],
    };
    fetchMock.mockImplementation((input: string) => {
      if (input.includes('/api/admin/models')) return Promise.resolve(json({ models: [] }));
      if (input.includes('/preview')) return Promise.resolve(json({ previews: [] }));
      if (input.includes('/api/admin/campaigns')) return Promise.resolve(json({ items: [perpetual], page: 1, total: 1, totalPages: 1 }));
      return Promise.resolve(json({}));
    });
    render(<AdminDashboardPage />);
    fireEvent.click(await screen.findByRole('button', { name: /expandir/i }));
    expect((await screen.findByLabelText('Último checkpoint de @author')).textContent).toContain('completed');
    expect(screen.getByText(/MONITOR_DB_IMPORT_FAILED/)).toBeTruthy();
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
      if (input.includes('/api/admin/image-models')) return Promise.resolve(json({ models: [{ key: 'image-ready', displayName: 'Image Ready', costPerImage: 0.01, configured: true, enabled: true }] }));
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

  it('generates seven preview comments without creating a campaign', async () => {
    const previewComments = Array.from(
      { length: 7 },
      (_, index) => `Preview ${index + 1}`
    );

    fetchMock.mockImplementation(
      (input: string, init?: RequestInit) => {
        if (input.includes('/api/admin/models')) {
          return Promise.resolve(json({ models: [] }));
        }

        if (
          input.includes('/preview') &&
          init?.method === 'POST'
        ) {
          return Promise.resolve(
            json({
              success: true,
              comments: previewComments,
              preview: {
                id: 'preview-1',
                postId: 'post-1',
                comments: previewComments,
                createdAt: new Date().toISOString(),
              },
            })
          );
        }

        if (
          input.includes(
            '/api/admin/campaigns/campaign-1/suggestions'
          )
        ) {
          return Promise.resolve(
            json({
              suggestions: [],
              nextCursor: null,
            })
          );
        }

        if (input.includes('/preview')) {
          return Promise.resolve(
            json({
              previews: [],
            })
          );
        }

        if (input.includes('/api/admin/campaigns')) {
          return Promise.resolve(
            json({
              items: [campaign],
              page: 1,
              total: 1,
              totalPages: 1,
            })
          );
        }

        return Promise.resolve(json({}));
      }
    );

    render(<AdminDashboardPage />);

    fireEvent.change(
      await screen.findByLabelText(/urls de los posts de x/i),
      {
        target: {
          value: 'https://x.com/genieorb/status/123',
        },
      }
    );

    fireEvent.click(
      screen.getByRole('button', {
        name: /^generar preview de comentarios$/i,
      })
    );

    expect(await screen.findByText('Preview 7')).toBeTruthy();

    const mutationCalls = fetchMock.mock.calls.filter(
      ([, init]) =>
        (init as RequestInit | undefined)?.method === 'POST'
    );

    const mutationUrls = mutationCalls.map(
      ([url]) => String(url)
    );

    expect(
      mutationUrls.some((url) => url.includes('/preview'))
    ).toBe(true);

    expect(
      mutationUrls.some(
        (url) => url === '/api/admin/campaigns'
      )
    ).toBe(false);
  });

  it('includes existing brand variants in the meme preview request', async () => {
    fetchMock.mockImplementation((input: string, init?: RequestInit) => {
      if (input.includes('/api/admin/models')) return Promise.resolve(json({ models: [] }));
      if (input.includes('/api/admin/image-models')) return Promise.resolve(json({ models: [{ key: 'image-ready', displayName: 'Image Ready', costPerImage: 0.01, configured: true, enabled: true }] }));
      if (input === '/api/admin/campaigns/preview/memes' && init?.method === 'POST') return Promise.resolve(json({ error: 'stop after payload' }, false));
      if (input.includes('/api/admin/campaigns')) return Promise.resolve(json({ items: [campaign], page: 1, total: 1, totalPages: 1 }));
      return Promise.resolve(json({}));
    });
    render(<AdminDashboardPage />);
    fireEvent.change(await screen.findByLabelText(/urls de los posts de x/i), { target: { value: 'https://x.com/genieorb/status/123' } });
    fireEvent.click(screen.getByRole('button', { name: /añadir variante/i }));
    fireEvent.change(screen.getByPlaceholderText(/texto exacto/i), { target: { value: 'GenieOrb' } });
    fireEvent.click(screen.getByRole('button', { name: /generar 3 memes/i }));

    await waitFor(() => {
      const call = fetchMock.mock.calls.find(([url, init]) => String(url) === '/api/admin/campaigns/preview/memes' && (init as RequestInit)?.method === 'POST');
      expect(call).toBeTruthy();
      expect(JSON.parse((call?.[1] as RequestInit).body as string)).toMatchObject({ brandVariants: [{ value: 'GenieOrb', percentage: 100 }] });
    });
  });

  it('reuses the draftId returned by a retryable meme preview error', async () => {
    const retryableErrorResponse = () => ({
      ...json({
        error: 'La generación no terminó en esta invocación.',
        retryable: true,
        draftId: 'draft-retry-1',
        cycleId: 'cycle-retry-1',
      }, false),
      status: 502,
    });

    fetchMock.mockImplementation((input: string, init?: RequestInit) => {
      if (input.includes('/api/admin/models')) return Promise.resolve(json({ models: [] }));
      if (input.includes('/api/admin/image-models')) return Promise.resolve(json({ models: [{ key: 'image-ready', displayName: 'Image Ready', costPerImage: 0.01, configured: true, enabled: true }] }));
      if (input === '/api/admin/campaigns/preview/memes' && init?.method === 'POST') {
        return Promise.resolve(retryableErrorResponse());
      }
      if (input.includes('/api/admin/campaigns')) return Promise.resolve(json({ items: [campaign], page: 1, total: 1, totalPages: 1 }));
      return Promise.resolve(json({}));
    });

    render(<AdminDashboardPage />);
    fireEvent.change(await screen.findByLabelText(/urls de los posts de x/i), {
      target: { value: 'https://x.com/genieorb/status/123' },
    });

    fireEvent.click(screen.getByRole('button', { name: /generar 3 memes/i }));
    expect(await screen.findByText('La generación no terminó en esta invocación.')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /generar 3 memes/i }));

    await waitFor(() => {
      const previewCalls = fetchMock.mock.calls.filter(([url, callInit]) =>
        String(url) === '/api/admin/campaigns/preview/memes' && (callInit as RequestInit | undefined)?.method === 'POST',
      );
      expect(previewCalls).toHaveLength(2);
      expect(JSON.parse((previewCalls[1][1] as RequestInit).body as string)).toMatchObject({
        draftId: 'draft-retry-1',
      });
    });
  });

  it('rechaza terminal parcial de dos memes con diagnostico y no lo renderiza', async () => {
    fetchMock.mockImplementation((input: string, init?: RequestInit) => {
      if (input.includes('/api/admin/models')) return Promise.resolve(json({ models: [] }));
      if (input.includes('/api/admin/image-models')) return Promise.resolve(json({ models: [{ key: 'image-ready', displayName: 'Image Ready', costPerImage: 0.01, configured: true, enabled: true }] }));
      if (input === '/api/admin/campaigns/preview/memes' && init?.method === 'POST') return Promise.resolve(json({ success: true, draftId: 'draft-partial', cycleId: 'cycle-partial' }));
      if (input.includes('/api/admin/meme-drafts/draft-partial/status')) return Promise.resolve(json({
        terminal: true, targetCount: 3, completedCount: 2, failedCount: 0, cancelledCount: 0, actualMemesCount: 2,
        memes: [
          { id: 'meme-1', url: 'local://one', plan: { slotIndex: 0 } },
          { id: 'meme-2', url: 'local://two', plan: { slotIndex: 1 } },
        ],
      }));
      if (input.includes('/api/admin/campaigns')) return Promise.resolve(json({ items: [campaign], page: 1, total: 1, totalPages: 1 }));
      return Promise.resolve(json({}));
    });
    render(<AdminDashboardPage />);
    fireEvent.change(await screen.findByLabelText(/urls de los posts de x/i), { target: { value: 'https://x.com/genieorb/status/123' } });
    fireEvent.click(screen.getByRole('button', { name: /generar 3 memes/i }));

    expect(await screen.findByText(/preview incompleta.*esperados=3.*recibidos=2/i)).toBeTruthy();
    expect(screen.queryByRole('region', { name: /preview de memes generados/i })).toBeNull();
    expect(screen.queryByAltText('Meme 1')).toBeNull();
  });

  it('renders all three memes from a terminal preview status', async () => {
    const memeUrls = [
      'https://cdn.example.test/memes/one.png',
      'https://cdn.example.test/memes/two.png',
      'https://cdn.example.test/memes/three.png',
    ];

    fetchMock.mockImplementation((input: string, init?: RequestInit) => {
      if (input.includes('/api/admin/models')) return Promise.resolve(json({ models: [] }));
      if (input.includes('/api/admin/image-models')) return Promise.resolve(json({ models: [{ key: 'image-ready', displayName: 'Image Ready', costPerImage: 0.01, configured: true, enabled: true }] }));
      if (input === '/api/admin/campaigns/preview/memes' && init?.method === 'POST') return Promise.resolve(json({ success: true, draftId: 'draft-three', cycleId: 'cycle-three' }));
      if (input === '/api/admin/meme-drafts/draft-three/status?cycleId=cycle-three') return Promise.resolve(json({
        terminal: true,
        targetCount: 3,
        completedCount: 3,
        failedCount: 0,
        cancelledCount: 0,
        actualMemesCount: 3,
        memes: memeUrls.map((url, slotIndex) => ({ id: `meme-${slotIndex + 1}`, url, plan: { slotIndex } })),
      }));
      if (input.includes('/api/admin/campaigns')) return Promise.resolve(json({ items: [campaign], page: 1, total: 1, totalPages: 1 }));
      return Promise.resolve(json({}));
    });

    render(<AdminDashboardPage />);
    fireEvent.change(await screen.findByLabelText(/urls de los posts de x/i), { target: { value: 'https://x.com/genieorb/status/123' } });
    await waitFor(() => expect((screen.getByLabelText(/modelo generador/i) as HTMLSelectElement).value).toBe('image-ready'));
    fireEvent.click(screen.getByRole('button', { name: /generar 3 memes/i }));

    const preview = await screen.findByRole('region', { name: /preview de memes generados/i });
    expect(preview).toBeTruthy();
    memeUrls.forEach((url, index) => expect(screen.getByAltText(`Meme ${index + 1}`).getAttribute('src')).toBe(url));

    const previewCall = fetchMock.mock.calls.find(([url, callInit]) =>
      String(url) === '/api/admin/campaigns/preview/memes' && (callInit as RequestInit | undefined)?.method === 'POST',
    );
    expect(previewCall).toBeTruthy();
    expect(JSON.parse((previewCall?.[1] as RequestInit).body as string)).toMatchObject({
      campaignType: 'manual',
      urlsInput: 'https://x.com/genieorb/status/123',
      memeModelKey: 'image-ready',
    });
    expect(fetchMock.mock.calls.some(([url, callInit]) =>
      String(url) === '/api/admin/meme-drafts/draft-three/status?cycleId=cycle-three' && !(callInit as RequestInit | undefined)?.method,
    )).toBe(true);
  });

  describe('maxCommentsTotal optional field', () => {
    it('is initially empty and not required', async () => {
      render(<AdminDashboardPage />);
      const maxInput = await screen.findByLabelText(/máximo de comentarios/i) as HTMLInputElement;
      expect(maxInput.value).toBe('');
      expect(maxInput.required).toBe(false);
    });

    it('submits without maxCommentsTotal when empty', async () => {
      fetchMock.mockImplementation((input: string, init?: RequestInit) => {
        if (input.includes('/api/admin/models')) return Promise.resolve(json({ models: [] }));
        if (input.includes('/api/admin/image-models')) return Promise.resolve(json({ models: [{ key: 'image-ready', displayName: 'Image Ready', costPerImage: 0.01, configured: true, enabled: true }] }));
        if (input === '/api/admin/campaigns' && init?.method === 'POST') return Promise.resolve(json({ success: true }));
        if (input.includes('/api/admin/campaigns')) return Promise.resolve(json({ items: [campaign], page: 1, total: 1, totalPages: 1 }));
        return Promise.resolve(json({}));
      });
      render(<AdminDashboardPage />);

      fireEvent.change(await screen.findByLabelText(/urls de los posts de x/i), {
        target: { value: 'https://x.com/genieorb/status/123' },
      });
      fireEvent.click(screen.getByRole('button', { name: /crear campaña/i }));

      await waitFor(() => {
        const postCall = fetchMock.mock.calls.find(([url, init]) => String(url) === '/api/admin/campaigns' && (init as RequestInit)?.method === 'POST');
        expect(postCall).toBeTruthy();
        const payload = JSON.parse((postCall?.[1] as RequestInit).body as string);
        expect(payload).not.toHaveProperty('maxCommentsTotal');
      });
    });

    it('submits with maxCommentsTotal when provided', async () => {
      fetchMock.mockImplementation((input: string, init?: RequestInit) => {
        if (input.includes('/api/admin/models')) return Promise.resolve(json({ models: [] }));
        if (input.includes('/api/admin/image-models')) return Promise.resolve(json({ models: [{ key: 'image-ready', displayName: 'Image Ready', costPerImage: 0.01, configured: true, enabled: true }] }));
        if (input === '/api/admin/campaigns' && init?.method === 'POST') return Promise.resolve(json({ success: true }));
        if (input.includes('/api/admin/campaigns')) return Promise.resolve(json({ items: [campaign], page: 1, total: 1, totalPages: 1 }));
        return Promise.resolve(json({}));
      });
      render(<AdminDashboardPage />);

      fireEvent.change(await screen.findByLabelText(/urls de los posts de x/i), {
        target: { value: 'https://x.com/genieorb/status/123' },
      });
      const maxInput = await screen.findByLabelText(/máximo de comentarios/i);
      fireEvent.change(maxInput, { target: { value: '1000' } });
      fireEvent.click(screen.getByRole('button', { name: /crear campaña/i }));

      await waitFor(() => {
        const postCall = fetchMock.mock.calls.find(([url, init]) => String(url) === '/api/admin/campaigns' && (init as RequestInit)?.method === 'POST');
        expect(postCall).toBeTruthy();
        const payload = JSON.parse((postCall?.[1] as RequestInit).body as string);
        expect(payload.maxCommentsTotal).toBe(1000);
      });

      // verifies it clears the field after creation
      await waitFor(() => {
        expect((screen.getByLabelText(/máximo de comentarios/i) as HTMLInputElement).value).toBe('');
      });
    });

    it('shows error and does not submit with invalid maxCommentsTotal', async () => {
      fetchMock.mockImplementation((input: string) => {
        if (input.includes('/api/admin/models')) return Promise.resolve(json({ models: [] }));
        if (input.includes('/api/admin/image-models')) return Promise.resolve(json({ models: [{ key: 'image-ready', displayName: 'Image Ready', costPerImage: 0.01, configured: true, enabled: true }] }));
        if (input.includes('/api/admin/campaigns')) return Promise.resolve(json({ items: [campaign], page: 1, total: 1, totalPages: 1 }));
        return Promise.resolve(json({}));
      });
      render(<AdminDashboardPage />);

      fireEvent.change(await screen.findByLabelText(/urls de los posts de x/i), {
        target: { value: 'https://x.com/genieorb/status/123' },
      });
      const maxInput = await screen.findByLabelText(/máximo de comentarios/i);

      // Test decimal
      fireEvent.change(maxInput, { target: { value: '10.5' } });
      fireEvent.click(screen.getByRole('button', { name: /crear campaña/i }));
      await waitFor(() => expect(screen.getByText('El máximo de comentarios debe ser un entero entre 1 y 1.000.000.')).toBeTruthy());

      // Test negative
      fireEvent.change(maxInput, { target: { value: '-5' } });
      fireEvent.click(screen.getByRole('button', { name: /crear campaña/i }));
      await waitFor(() => expect(screen.getByText('El máximo de comentarios debe ser un entero entre 1 y 1.000.000.')).toBeTruthy());

      // Test zero
      fireEvent.change(maxInput, { target: { value: '0' } });
      fireEvent.click(screen.getByRole('button', { name: /crear campaña/i }));
      await waitFor(() => expect(screen.getByText('El máximo de comentarios debe ser un entero entre 1 y 1.000.000.')).toBeTruthy());

      // Test over 1000000
      fireEvent.change(maxInput, { target: { value: '1000001' } });
      fireEvent.click(screen.getByRole('button', { name: /crear campaña/i }));
      await waitFor(() => expect(screen.getByText('El máximo de comentarios debe ser un entero entre 1 y 1.000.000.')).toBeTruthy());

      const postCalls = fetchMock.mock.calls.filter(([url, init]) => String(url) === '/api/admin/campaigns' && (init as RequestInit)?.method === 'POST');
      expect(postCalls).toHaveLength(0);
    });
  });
});
