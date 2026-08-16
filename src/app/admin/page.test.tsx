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

  it('confirms irreversible cancellation before posting to the cancel endpoint', async () => {
    const confirmMock = vi.fn(() => true);
    vi.stubGlobal('confirm', confirmMock);
    render(<AdminDashboardPage />);
    fireEvent.click(await screen.findByRole('button', { name: /expandir/i }));
    fireEvent.click(await screen.findByRole('button', { name: /cancelar campaña/i }));

    await waitFor(() => expect(fetchMock.mock.calls.some(([url, init]) =>
      String(url) === '/api/admin/campaigns/campaign-1/cancel' && (init as RequestInit | undefined)?.method === 'POST',
    )).toBe(true));
    expect(confirmMock).toHaveBeenCalledWith(expect.stringMatching(/irreversible/i));
    vi.unstubAllGlobals();
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
    fireEvent.click(screen.getByLabelText(/habilitar sistema de memes/i));
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

  it('submits meme cadence and an uploaded draft id without requiring an image model', async () => {
    fetchMock.mockImplementation((input: string, init?: RequestInit) => {
      if (input.includes('/api/admin/models')) return Promise.resolve(json({ models: [] }));
      if (input.includes('/api/admin/image-models')) return Promise.resolve(json({ models: [] }));
      if (input === '/api/admin/meme-drafts/assets' && init?.method === 'POST') return Promise.resolve(json({ draftId: 'draft-uploaded' }));
      if (input === '/api/admin/meme-drafts/draft-uploaded/assets') return Promise.resolve(json({ assets: [{ id: 'asset-1', mime_type: 'image/png' }] }));
      if (input === '/api/admin/campaigns' && init?.method === 'POST') return Promise.resolve(json({ success: true }));
      if (input.includes('/api/admin/campaigns')) return Promise.resolve(json({ items: [campaign], page: 1, total: 1, totalPages: 1 }));
      return Promise.resolve(json({}));
    });
    render(<AdminDashboardPage />);

    fireEvent.change(await screen.findByLabelText(/urls de los posts de x/i), { target: { value: 'https://x.com/genieorb/status/123' } });
    fireEvent.change(screen.getByLabelText(/meme cada x comentarios/i), { target: { value: '4' } });
    fireEvent.change(screen.getByLabelText(/subir memes manuales/i), { target: { files: [new File(['meme'], 'meme.png', { type: 'image/png' })] } });
    await screen.findByText('image/png');
    expect(screen.queryByLabelText(/modelo generador de im[aá]genes/i)).toBeNull();
    expect(screen.queryByRole('button', { name: /generar 3 memes/i })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /crear campaña/i }));

    await waitFor(() => {
      const request = fetchMock.mock.calls.find(([url, init]) => String(url) === '/api/admin/campaigns' && (init as RequestInit | undefined)?.method === 'POST');
      expect(request).toBeTruthy();
      expect(JSON.parse((request?.[1] as RequestInit).body as string)).toMatchObject({ includeMemes: true, memeEveryComments: 4, draftId: 'draft-uploaded' });
    });
  });

  it('uploads selected memes sequentially, retains the draft id, reloads successful assets, and reports a partial failure', async () => {
    let releaseThirdUpload: (() => void) | undefined;
    fetchMock.mockImplementation((input: string, init?: RequestInit) => {
      if (input.includes('/api/admin/models')) return Promise.resolve(json({ models: [] }));
      if (input === '/api/admin/meme-drafts/assets' && init?.method === 'POST') {
        const file = (init.body as FormData).get('file') as File;
        const submittedDraft = (init.body as FormData).get('draftId');
        if (file.name === 'one.png') return Promise.resolve(json({ draftId: 'draft-sequential' }));
        if (file.name === 'two.png') return Promise.resolve(json({ error: 'second file rejected' }, false));
        expect(submittedDraft).toBe('draft-sequential');
        return new Promise((resolve) => { releaseThirdUpload = () => resolve(json({ draftId: 'draft-sequential' })); });
      }
      if (input === '/api/admin/meme-drafts/draft-sequential/assets') {
        return Promise.resolve(json({ assets: [{ id: 'asset-one', mime_type: 'image/png' }, { id: 'asset-three', mime_type: 'image/webp' }] }));
      }
      if (input.includes('/api/admin/campaigns')) return Promise.resolve(json({ items: [campaign], page: 1, total: 1, totalPages: 1 }));
      return Promise.resolve(json({}));
    });
    render(<AdminDashboardPage />);
    fireEvent.change(await screen.findByLabelText(/subir memes manuales/i), {
      target: { files: [new File(['1'], 'one.png', { type: 'image/png' }), new File(['2'], 'two.png', { type: 'image/png' }), new File(['3'], 'three.webp', { type: 'image/webp' })] },
    });

    expect((await screen.findByRole('status')).textContent).toMatch(/subiendo 3 de 3: three\.webp/i);
    releaseThirdUpload?.();
    expect((await screen.findByRole('alert')).textContent).toContain('second file rejected');
    expect(await screen.findByText('image/webp')).toBeTruthy();
    expect(fetchMock.mock.calls.filter(([url, init]) => String(url) === '/api/admin/meme-drafts/assets' && (init as RequestInit).method === 'POST')).toHaveLength(3);
    expect(fetchMock.mock.calls.some(([url]) => String(url) === '/api/admin/meme-drafts/draft-sequential/assets')).toBe(true);
  });

  it('deletes a draft asset only after successful deletion and preserves it with an alert on failure', async () => {
    let deletionShouldFail = false;
    vi.stubGlobal('confirm', vi.fn(() => true));
    fetchMock.mockImplementation((input: string, init?: RequestInit) => {
      if (input.includes('/api/admin/models')) return Promise.resolve(json({ models: [] }));
      if (input === '/api/admin/meme-drafts/assets' && init?.method === 'POST') return Promise.resolve(json({ draftId: 'draft-delete' }));
      if (input === '/api/admin/meme-drafts/draft-delete/assets') return Promise.resolve(json({ assets: [{ id: 'asset-delete', mime_type: 'image/png' }] }));
      if (input === '/api/admin/meme-drafts/draft-delete/assets/asset-delete' && init?.method === 'DELETE') return Promise.resolve(json({ error: 'delete failed' }, !deletionShouldFail));
      if (input.includes('/api/admin/campaigns')) return Promise.resolve(json({ items: [campaign], page: 1, total: 1, totalPages: 1 }));
      return Promise.resolve(json({}));
    });
    render(<AdminDashboardPage />);
    fireEvent.change(await screen.findByLabelText(/subir memes manuales/i), { target: { files: [new File(['meme'], 'meme.png', { type: 'image/png' })] } });
    await screen.findByText('image/png');

    deletionShouldFail = true;
    fireEvent.click(screen.getByRole('button', { name: /eliminar meme/i }));
    expect((await screen.findByRole('alert')).textContent).toContain('delete failed');
    expect(screen.getByText('image/png')).toBeTruthy();

    deletionShouldFail = false;
    fireEvent.click(screen.getByRole('button', { name: /eliminar meme/i }));
    await waitFor(() => expect(screen.queryByText('image/png')).toBeNull());
  });

  it('keeps brand variants ordered, trims and omits blanks, and excludes legacy meme fields from the campaign payload', async () => {
    fetchMock.mockImplementation((input: string, init?: RequestInit) => {
      if (input.includes('/api/admin/models')) return Promise.resolve(json({ models: [] }));
      if (input === '/api/admin/campaigns' && init?.method === 'POST') return Promise.resolve(json({ success: true }));
      if (input.includes('/api/admin/campaigns')) return Promise.resolve(json({ items: [campaign], page: 1, total: 1, totalPages: 1 }));
      return Promise.resolve(json({}));
    });
    render(<AdminDashboardPage />);
    fireEvent.click(await screen.findByLabelText(/habilitar sistema de memes/i));
    fireEvent.change(screen.getByLabelText(/urls de los posts de x/i), { target: { value: 'https://x.com/genieorb/status/123' } });
    fireEvent.click(screen.getByRole('button', { name: /añadir variante/i }));
    fireEvent.click(screen.getByRole('button', { name: /añadir variante/i }));
    const values = screen.getAllByPlaceholderText(/texto exacto/i);
    fireEvent.change(values[0], { target: { value: '  First  ' } });
    fireEvent.change(values[1], { target: { value: '   ' } });
    fireEvent.click(screen.getByRole('button', { name: /crear campaña/i }));
    await waitFor(() => {
      const request = fetchMock.mock.calls.find(([url, init]) => String(url) === '/api/admin/campaigns' && (init as RequestInit).method === 'POST');
      const payload = JSON.parse((request?.[1] as RequestInit).body as string);
      expect(payload.brandVariants).toEqual([{ value: 'First', percentage: 100 }]);
      expect(payload).not.toHaveProperty('memePercentage');
      expect(payload).not.toHaveProperty('memeModelKey');
    });
  });

  it('orders direction and brand variants before the meme configuration', async () => {
    render(<AdminDashboardPage />);
    await screen.findByLabelText(/dirección de los comentarios/i);
    const formText = document.querySelector('form')?.textContent || '';
    expect(formText.indexOf('Máximo de comentarios')).toBeLessThan(formText.indexOf('Dirección de los comentarios'));
    expect(formText.indexOf('Dirección de los comentarios')).toBeLessThan(formText.indexOf('Variantes de Marca'));
    expect(formText.indexOf('Variantes de Marca')).toBeLessThan(formText.indexOf('Habilitar Sistema de Memes'));
  });

  it('does not submit a meme campaign before at least one manual meme is uploaded', async () => {
    render(<AdminDashboardPage />);

    fireEvent.change(await screen.findByLabelText(/urls de los posts de x/i), {
      target: { value: 'https://x.com/genieorb/status/123' },
    });
    fireEvent.click(screen.getByRole('button', { name: /crear campaña/i }));

    expect(await screen.findByText(/sube al menos un meme antes de crear la campaña/i)).toBeTruthy();
    expect(fetchMock.mock.calls.some(([url, init]) =>
      String(url) === '/api/admin/campaigns' && (init as RequestInit | undefined)?.method === 'POST',
    )).toBe(false);
  });

  it('clears the converted draft and its assets after creation so a second submit cannot reuse them', async () => {
    fetchMock.mockImplementation((input: string, init?: RequestInit) => {
      if (input.includes('/api/admin/models')) return Promise.resolve(json({ models: [] }));
      if (input === '/api/admin/meme-drafts/assets' && init?.method === 'POST') return Promise.resolve(json({ draftId: 'draft-converted' }));
      if (input === '/api/admin/meme-drafts/draft-converted/assets') return Promise.resolve(json({ assets: [{ id: 'asset-1', mime_type: 'image/png' }] }));
      if (input === '/api/admin/campaigns' && init?.method === 'POST') return Promise.resolve(json({ success: true }));
      if (input.includes('/api/admin/campaigns')) return Promise.resolve(json({ items: [campaign], page: 1, total: 1, totalPages: 1 }));
      return Promise.resolve(json({}));
    });
    render(<AdminDashboardPage />);

    fireEvent.change(await screen.findByLabelText(/urls de los posts de x/i), {
      target: { value: 'https://x.com/genieorb/status/123' },
    });
    const memeFile = new File(['meme'], 'meme.png', { type: 'image/png' });
    fireEvent.change(screen.getByLabelText(/subir memes manuales/i), { target: { files: [memeFile] } });
    await screen.findByText('image/png');

    fireEvent.click(screen.getByRole('button', { name: /crear campaña/i }));
    await waitFor(() => {
      const request = fetchMock.mock.calls.find(([url, callInit]) =>
        String(url) === '/api/admin/campaigns' && (callInit as RequestInit | undefined)?.method === 'POST',
      );
      expect(JSON.parse((request?.[1] as RequestInit).body as string)).toMatchObject({ draftId: 'draft-converted' });
    });

    await waitFor(() => expect(screen.queryByText('image/png')).toBeNull());
    fireEvent.change(screen.getByLabelText(/urls de los posts de x/i), {
      target: { value: 'https://x.com/genieorb/status/456' },
    });
    fireEvent.click(screen.getByRole('button', { name: /crear campaña/i }));

    expect(await screen.findByText(/sube al menos un meme antes de crear la campaña/i)).toBeTruthy();
    expect(fetchMock.mock.calls.filter(([url, callInit]) =>
      String(url) === '/api/admin/campaigns' && (callInit as RequestInit | undefined)?.method === 'POST',
    )).toHaveLength(1);
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

      fireEvent.click(await screen.findByLabelText(/habilitar sistema de memes/i));
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

      fireEvent.click(await screen.findByLabelText(/habilitar sistema de memes/i));
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
