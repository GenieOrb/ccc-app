'use client';

import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';

export interface CampaignSummary {
  id: string;
  internalNumber: number;
  internalId: string;
  slug: string;
  publicUrl: string;
  direction?: string;
  isActive: boolean;
  safetyAllowed: boolean;
  safetyCategory?: string;
  safetyReason?: string;
  xPosts: { id: string; url: string; isRetired: boolean }[];
  campaignType: 'manual' | 'perpetual';
  postActiveLifetimeHours?: number;
  xAccounts: {
    id: string;
    username: string;
    usernameNormalized: string;
    isRemoved: boolean;
    createdAt: string;
    removedAt?: string;
  }[];
  generationProgress: number;
  validGeneratedCount: number;
  availableCount: number;
  assignedCount: number;
  withdrawnCount: number;
  pendingProcessingJobsCount: number;
  failedJobsCount: number;
  hasUnresolvedFailedCycle: boolean;
  createdAt: string;
}

export interface Suggestion {
  id: string;
  text: string;
  status: string;
  createdAt: string;
  assignedAt: string | null;
  withdrawnAt: string | null;
  postId: string;
  postUrl: string;
  postAuthor: string;
  postIsRetired: boolean;
}

function CampaignCardItem({
  c,
  fetchCampaigns,
  handleToggleStatus,
  handleRetryGeneration,
  handleCopyUrl,
  copiedId
}: {
  c: CampaignSummary;
  fetchCampaigns: () => Promise<void>;
  handleToggleStatus: (id: string) => Promise<void>;
  handleRetryGeneration: (id: string) => Promise<void>;
  handleCopyUrl: (url: string, id: string) => void;
  copiedId: string | null;
}) {
  const [showComments, setShowComments] = useState(false);
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadingComments, setLoadingComments] = useState(false);
  const [newUrlsInput, setNewUrlsInput] = useState('');
  const [addingPost, setAddingPost] = useState(false);
  const [newAccountsInput, setNewAccountsInput] = useState('');
  const [addingAccount, setAddingAccount] = useState(false);
  const [durationInput, setDurationInput] = useState(c.postActiveLifetimeHours?.toString() || '24');
  const [changingDuration, setChangingDuration] = useState(false);

  const loadComments = async (cursor?: string | null) => {
    setLoadingComments(true);
    try {
      const url = new URL(`/api/admin/campaigns/${c.id}/suggestions`, window.location.origin);
      if (cursor) url.searchParams.set('cursor', cursor);
      const res = await fetch(url.toString());
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Error al cargar comentarios');
      if (cursor) {
        setSuggestions(prev => [...prev, ...data.suggestions]);
      } else {
        setSuggestions(data.suggestions);
      }
      setNextCursor(data.nextCursor);
    } catch (e: unknown) {
      alert(e instanceof Error ? e.message : String(e));
    } finally {
      setLoadingComments(false);
    }
  };

  const toggleComments = () => {
    if (!showComments) {
      loadComments();
    }
    setShowComments(!showComments);
  };

  const handleAddPost = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newUrlsInput.trim()) return;
    setAddingPost(true);
    try {
      const res = await fetch(`/api/admin/campaigns/${c.id}/posts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ urlsInput: newUrlsInput }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Error al añadir posts');
      setNewUrlsInput('');
      await fetchCampaigns();
    } catch (e: unknown) {
      alert(e instanceof Error ? e.message : String(e));
    } finally {
      setAddingPost(false);
    }
  };

  const handleWithdrawPost = async (postId: string) => {
    if (!confirm('¿Seguro que deseas retirar este post? Ya no se usarán en futuras regeneraciones.')) return;
    try {
      const res = await fetch(`/api/admin/campaigns/${c.id}/posts/${postId}/withdraw`, { method: 'POST' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Error al retirar post');
      await fetchCampaigns();
    } catch (e: unknown) {
      alert(e instanceof Error ? e.message : String(e));
    }
  };

  const handleAddAccount = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newAccountsInput.trim()) return;
    setAddingAccount(true);
    try {
      const res = await fetch(`/api/admin/campaigns/${c.id}/accounts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ accountsInput: newAccountsInput }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Error al añadir cuentas');
      setNewAccountsInput('');
      await fetchCampaigns();
    } catch (e: unknown) {
      alert(e instanceof Error ? e.message : String(e));
    } finally {
      setAddingAccount(false);
    }
  };

  const handleRemoveAccount = async (accountId: string) => {
    if (!confirm('La cuenta dejará de aportar posts nuevos. Sus posts actuales permanecerán activos hasta que expire su duración.')) return;
    try {
      const res = await fetch(`/api/admin/campaigns/${c.id}/accounts/${accountId}`, { method: 'DELETE' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Error al retirar cuenta');
      await fetchCampaigns();
    } catch (e: unknown) {
      alert(e instanceof Error ? e.message : String(e));
    }
  };

  const handleChangeDuration = async (e: React.FormEvent) => {
    e.preventDefault();
    const parsed = Number(durationInput);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 720) return;
    setChangingDuration(true);
    try {
      const res = await fetch(`/api/admin/campaigns/${c.id}/settings`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ postActiveLifetimeHours: parsed }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Error al actualizar duración');
      await fetchCampaigns();
    } catch (e: unknown) {
      alert(e instanceof Error ? e.message : String(e));
    } finally {
      setChangingDuration(false);
    }
  };

  const handleWithdrawSuggestion = async (suggId: string) => {
    if (!confirm('¿Seguro que deseas retirar este comentario disponible?')) return;
    try {
      const res = await fetch(`/api/admin/campaigns/${c.id}/suggestions/${suggId}/withdraw`, { method: 'POST' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Error al retirar sugerencia');
      setSuggestions(prev => prev.map(s => s.id === suggId ? { ...s, status: 'withdrawn' } : s));
      await fetchCampaigns();
    } catch (e: unknown) {
      alert(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div className="campaign-card">
      <div className="campaign-header-row">
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <span className="campaign-badge-id">{c.internalId}</span>
          <span style={{ fontSize: '0.8rem', backgroundColor: '#e2e8f0', color: '#475569', padding: '2px 6px', borderRadius: '4px', fontWeight: 'bold' }}>
            {c.campaignType === 'manual' ? 'Manual' : 'Perpetua'}
          </span>
        </div>
        <span
          className={`status-badge ${
            c.isActive ? 'status-active' : 'status-inactive'
          }`}
        >
          {c.isActive ? 'Activa' : 'Desactivada'}
        </span>
      </div>

      {c.direction && (
        <p style={{ fontSize: '0.9rem', fontStyle: 'italic', color: '#475569' }}>
          Dirección: &quot;{c.direction}&quot;
        </p>
      )}

      <div>
        {c.campaignType === 'manual' && (
          <>
            <span style={{ fontSize: '0.8rem', fontWeight: '600', color: 'var(--text-muted)' }}>
              POSTS DE X INCLUIDOS:
            </span>
            <ul style={{ paddingLeft: '20px', fontSize: '0.85rem' }}>
              {c.xPosts.map((post) => (
                <li key={post.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '4px' }}>
                  <a href={post.url} target="_blank" rel="noopener noreferrer" style={{ color: 'var(--lavender-accent)', textDecoration: post.isRetired ? 'line-through' : 'none', opacity: post.isRetired ? 0.6 : 1 }}>
                    {post.url}
                  </a>
                  {post.isRetired ? (
                    <span style={{ fontSize: '0.75rem', color: 'var(--peach-accent)', fontWeight: 'bold' }}>RETIRADO</span>
                  ) : (
                    <button type="button" onClick={() => handleWithdrawPost(post.id)} className="btn-admin btn-danger" style={{ padding: '2px 6px', fontSize: '0.7rem' }}>Retirar</button>
                  )}
                </li>
              ))}
            </ul>
            <form onSubmit={handleAddPost} style={{ display: 'flex', gap: '8px', marginTop: '8px', marginBottom: '16px' }}>
              <input 
                type="text" 
                value={newUrlsInput} 
                onChange={(e) => setNewUrlsInput(e.target.value)} 
                placeholder="Añadir nuevas URLs de X..." 
                className="form-textarea" 
                style={{ minHeight: '30px', flex: 1, padding: '4px 8px', fontSize: '0.8rem' }}
                disabled={addingPost}
              />
              <button type="submit" disabled={addingPost || !newUrlsInput.trim()} className="btn-admin btn-primary" style={{ padding: '4px 8px', fontSize: '0.8rem' }}>
                {addingPost ? 'Añadiendo...' : 'Añadir'}
              </button>
            </form>
          </>
        )}

        {c.campaignType === 'perpetual' && (
          <>
            <form onSubmit={handleChangeDuration} style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '16px', background: '#f8fafc', padding: '8px', borderRadius: '4px', border: '1px solid #e2e8f0' }}>
              <label style={{ fontSize: '0.85rem', fontWeight: 'bold', color: '#475569' }}>Duración activa de cada post (horas):</label>
              <input 
                type="number" 
                min="1" max="720" step="1"
                value={durationInput} 
                onChange={(e) => setDurationInput(e.target.value)} 
                className="form-textarea" 
                style={{ width: '80px', padding: '4px 8px', fontSize: '0.85rem' }}
                disabled={changingDuration}
              />
              <button type="submit" disabled={changingDuration || Number(durationInput) === c.postActiveLifetimeHours} className="btn-admin btn-secondary" style={{ padding: '4px 8px', fontSize: '0.8rem' }}>
                {changingDuration ? 'Guardando...' : 'Cambiar duración'}
              </button>
            </form>

            <span style={{ fontSize: '0.8rem', fontWeight: '600', color: 'var(--text-muted)' }}>
              CUENTAS DE X:
            </span>
            <ul style={{ paddingLeft: '20px', fontSize: '0.85rem' }}>
              {c.xAccounts.map((acc) => (
                <li key={acc.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '4px' }}>
                  <div style={{ display: 'flex', flexDirection: 'column' }}>
                    <a href={`https://x.com/${acc.username}`} target="_blank" rel="noopener noreferrer" style={{ color: 'var(--lavender-accent)', textDecoration: acc.isRemoved ? 'line-through' : 'none', opacity: acc.isRemoved ? 0.6 : 1, fontWeight: 'bold' }}>
                      @{acc.username}
                    </a>
                    <span style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>
                      Añadida: {new Date(acc.createdAt).toLocaleDateString()}
                    </span>
                  </div>
                  {acc.isRemoved ? (
                    <span style={{ fontSize: '0.75rem', color: 'var(--peach-accent)', fontWeight: 'bold', textAlign: 'right' }}>
                      RETIRADA<br />({new Date(acc.removedAt!).toLocaleDateString()})
                    </span>
                  ) : (
                    <button type="button" onClick={() => handleRemoveAccount(acc.id)} className="btn-admin btn-danger" style={{ padding: '2px 6px', fontSize: '0.7rem' }}>Retirar</button>
                  )}
                </li>
              ))}
            </ul>
            <form onSubmit={handleAddAccount} style={{ display: 'flex', gap: '8px', marginTop: '8px', marginBottom: '16px' }}>
              <input 
                type="text" 
                value={newAccountsInput} 
                onChange={(e) => setNewAccountsInput(e.target.value)} 
                placeholder="Añadir nuevas cuentas (ej: @usuario)" 
                className="form-textarea" 
                style={{ minHeight: '30px', flex: 1, padding: '4px 8px', fontSize: '0.8rem' }}
                disabled={addingAccount}
              />
              <button type="submit" disabled={addingAccount || !newAccountsInput.trim()} className="btn-admin btn-primary" style={{ padding: '4px 8px', fontSize: '0.8rem' }}>
                {addingAccount ? 'Añadiendo...' : 'Añadir'}
              </button>
            </form>

            {c.xPosts.length > 0 && (
              <div style={{ marginTop: '16px', opacity: 0.8 }}>
                <span style={{ fontSize: '0.8rem', fontWeight: '600', color: 'var(--text-muted)' }}>
                  POSTS EXISTENTES EN LA CAMPAÑA:
                </span>
                <ul style={{ paddingLeft: '20px', fontSize: '0.8rem', marginTop: '4px' }}>
                  {c.xPosts.map((post) => (
                    <li key={post.id} style={{ marginBottom: '2px' }}>
                      <a href={post.url} target="_blank" rel="noopener noreferrer" style={{ color: 'var(--text-muted)', textDecoration: post.isRetired ? 'line-through' : 'none' }}>
                        {post.url} {post.isRetired && '(RETIRADO)'}
                      </a>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </>
        )}
      </div>

      {/* Campaign Statistics Grid */}
      <div className="campaign-details-grid">
        <div className="stat-item">
          <span className="stat-label">Progreso</span>
          <span className="stat-value">{c.generationProgress}%</span>
        </div>
        <div className="stat-item">
          <span className="stat-label">Generados</span>
          <span className="stat-value">{c.validGeneratedCount}</span>
        </div>
        <div className="stat-item">
          <span className="stat-label">Disponibles</span>
          <span className="stat-value">{c.availableCount}</span>
        </div>
        <div className="stat-item">
          <span className="stat-label">Asignados</span>
          <span className="stat-value">{c.assignedCount}</span>
        </div>
        <div className="stat-item">
          <span className="stat-label">Retirados</span>
          <span className="stat-value" style={{ color: 'var(--peach-accent)' }}>{c.withdrawnCount}</span>
        </div>
        <div className="stat-item">
          <span className="stat-label">En Cola</span>
          <span className="stat-value">{c.pendingProcessingJobsCount}</span>
        </div>
        <div className="stat-item">
          <span className="stat-label">Fallidos</span>
          <span className="stat-value" style={{ color: c.failedJobsCount > 0 ? 'var(--peach-accent)' : 'inherit' }}>
            {c.failedJobsCount}
          </span>
        </div>
      </div>

      {/* Public URL Box */}
      <div className="url-box">
        <span className="url-text">{c.publicUrl}</span>
        <button
          type="button"
          onClick={() => handleCopyUrl(c.publicUrl, c.id)}
          className="btn-admin btn-secondary"
          style={{ padding: '6px 12px', fontSize: '0.85rem' }}
        >
          {copiedId === c.id ? '¡Copiada!' : 'Copiar URL'}
        </button>
      </div>

      {/* Action Controls */}
      <div style={{ display: 'flex', gap: '12px', alignItems: 'center', marginBottom: '16px' }}>
        <button
          type="button"
          onClick={() => handleToggleStatus(c.id)}
          className={`btn-admin ${c.isActive ? 'btn-danger' : 'btn-success'}`}
        >
          {c.isActive ? 'Desactivar' : 'Activar'}
        </button>

        {(c.failedJobsCount > 0 || c.hasUnresolvedFailedCycle) && (
          <button
            type="button"
            onClick={() => handleRetryGeneration(c.id)}
            className="btn-admin btn-danger"
          >
            Reintentar generación
          </button>
        )}
      </div>

      {/* Comments Section */}
      <div style={{ borderTop: '1px solid var(--border-color)', paddingTop: '16px' }}>
        <button type="button" onClick={toggleComments} className="btn-admin btn-secondary" style={{ width: '100%' }}>
          {showComments ? 'Ocultar comentarios' : 'Ver comentarios'}
        </button>
        
        {showComments && (
          <div style={{ marginTop: '12px', display: 'flex', flexDirection: 'column', gap: '8px' }}>
            {suggestions.map((s) => (
              <div key={s.id} style={{ padding: '8px', border: '1px solid var(--border-color)', borderRadius: '6px', fontSize: '0.85rem', background: 'var(--surface-color)' }}>
                <p style={{ margin: '0 0 4px 0' }}>{s.text}</p>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <div>
                    <span style={{ 
                      fontWeight: 'bold', 
                      marginRight: '8px',
                      color: s.status === 'available' ? 'var(--success-color)' : s.status === 'assigned' ? 'var(--lavender-accent)' : 'var(--peach-accent)' 
                    }}>
                      {s.status.toUpperCase()}
                    </span>
                    <a href={s.postUrl} target="_blank" rel="noopener noreferrer" style={{ color: 'var(--text-muted)', textDecoration: s.postIsRetired ? 'line-through' : 'none' }}>
                      @{s.postAuthor}
                    </a>
                  </div>
                  {s.status === 'available' && (
                    <button type="button" onClick={() => handleWithdrawSuggestion(s.id)} className="btn-admin btn-danger" style={{ padding: '2px 6px', fontSize: '0.7rem' }}>
                      Eliminar
                    </button>
                  )}
                </div>
              </div>
            ))}
            
            {loadingComments && <p style={{ fontSize: '0.8rem', textAlign: 'center' }}>Cargando...</p>}
            
            {!loadingComments && nextCursor && (
              <button type="button" onClick={() => loadComments(nextCursor)} className="btn-admin btn-secondary">
                Cargar más
              </button>
            )}
            
            {!loadingComments && suggestions.length === 0 && (
              <p style={{ fontSize: '0.8rem', textAlign: 'center', color: 'var(--text-muted)' }}>No hay comentarios.</p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

export default function AdminDashboardPage() {
  const [campaigns, setCampaigns] = useState<CampaignSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Form states
  const [campaignTypeToCreate, setCampaignTypeToCreate] = useState<'manual' | 'perpetual'>('manual');
  const [urlsInput, setUrlsInput] = useState('');
  const [accountsInput, setAccountsInput] = useState('');
  const [postActiveLifetimeHours, setPostActiveLifetimeHours] = useState('24');
  const [direction, setDirection] = useState('');
  const [creating, setCreating] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const router = useRouter();

  const fetchCampaigns = useCallback(async () => {
    try {
      const res = await fetch('/api/admin/campaigns');
      if (res.status === 401) {
        router.push('/admin/login');
        return;
      }
      const data = await res.json();
      if (res.ok) {
        setCampaigns(data.campaigns || []);
      } else {
        setError(data.error || 'Error al cargar campañas.');
      }
    } catch {
      setError('Error de conexión al cargar el panel.');
    } finally {
      setLoading(false);
    }
  }, [router]);

  useEffect(() => {
    fetchCampaigns();
  }, [fetchCampaigns]);

  // Periodic polling & worker resumption while jobs are pending
  useEffect(() => {
    const hasPendingJobs = campaigns.some(
      (c) => c.pendingProcessingJobsCount > 0
    );

    if (!hasPendingJobs) return;

    const interval = setInterval(async () => {
      try {
        await fetch('/api/admin/generation/process', { method: 'POST' });
        await fetchCampaigns();
      } catch {
        // Ignore background polling errors
      }
    }, 4000);

    return () => clearInterval(interval);
  }, [campaigns, fetchCampaigns]);

  async function handleLogout() {
    await fetch('/api/auth/logout', { method: 'POST' });
    router.push('/admin/login');
    router.refresh();
  }

  async function handleCreateCampaign(e: React.FormEvent) {
    e.preventDefault();
    if (campaignTypeToCreate === 'manual' && !urlsInput.trim()) return;
    if (campaignTypeToCreate === 'perpetual' && !accountsInput.trim()) return;
    const parsedDuration = Number(postActiveLifetimeHours);
    if (campaignTypeToCreate === 'perpetual' && (!Number.isInteger(parsedDuration) || parsedDuration < 1 || parsedDuration > 720)) return;

    setError(null);
    setCreating(true);

    try {
      const payload: Record<string, string | number> = { campaignType: campaignTypeToCreate, direction };
      if (campaignTypeToCreate === 'manual') {
        payload.urlsInput = urlsInput;
      } else {
        payload.accountsInput = accountsInput;
        payload.postActiveLifetimeHours = parsedDuration;
      }

      const res = await fetch('/api/admin/campaigns', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      const data = await res.json();

      if (!res.ok) {
        setError(data.error || 'Error al crear la campaña.');
        setCreating(false);
        return;
      }

      setUrlsInput('');
      setAccountsInput('');
      setDirection('');
      await fetchCampaigns();
    } catch {
      setError('Error al enviar la petición de creación.');
    } finally {
      setCreating(false);
    }
  }

  async function handleToggleStatus(campaignId: string) {
    setError(null);
    try {
      const res = await fetch(`/api/admin/campaigns/${campaignId}/toggle`, {
        method: 'POST',
      });
      const data = await res.json();

      if (!res.ok) {
        setError(data.error || 'No se pudo cambiar el estado de la campaña.');
        return;
      }

      await fetchCampaigns();
    } catch {
      setError('Error de red al actualizar estado.');
    }
  }

  async function handleRetryGeneration(campaignId: string) {
    setError(null);
    try {
      const res = await fetch(`/api/admin/campaigns/${campaignId}/retry`, {
        method: 'POST',
      });
      const data = await res.json();

      if (!res.ok) {
        setError(data.error || 'No se pudo reintentar la generación.');
        return;
      }

      await fetchCampaigns();
    } catch {
      setError('Error al solicitar reintento de generación.');
    }
  }

  function handleCopyUrl(url: string, id: string) {
    navigator.clipboard.writeText(url).then(() => {
      setCopiedId(id);
      setTimeout(() => setCopiedId(null), 2000);
    });
  }

  return (
    <div>
      {/* Admin Header */}
      <header className="admin-header">
        <h1 className="admin-title">Panel Administrativo</h1>
        <button
          onClick={handleLogout}
          className="btn-admin btn-secondary"
          type="button"
        >
          Cerrar sesión
        </button>
      </header>

      {/* Admin Main Body */}
      <main className="admin-main">
        {error && (
          <div className="error-banner" role="alert">
            {error}
          </div>
        )}

        {/* Create Campaign Card */}
        <section className="admin-card">
          <h2 className="admin-card-header">Crear Nueva Campaña</h2>
          <form onSubmit={handleCreateCampaign}>
            <div className="form-group">
              <label htmlFor="campaign-type" className="form-label">
                Tipo de campaña
              </label>
              <select
                id="campaign-type"
                className="form-textarea"
                style={{ minHeight: 'auto', padding: '8px' }}
                value={campaignTypeToCreate}
                onChange={(e) => setCampaignTypeToCreate(e.target.value as 'manual' | 'perpetual')}
                disabled={creating}
              >
                <option value="manual">Manual (URLs de posts estáticos)</option>
                <option value="perpetual">Perpetua (Cuentas de X automáticas)</option>
              </select>
            </div>

            {campaignTypeToCreate === 'manual' && (
              <div className="form-group">
                <label htmlFor="urls-input" className="form-label">
                  URLs de los posts de X (una por línea o comas)
                </label>
                <textarea
                  id="urls-input"
                  className="form-textarea"
                  rows={3}
                  value={urlsInput}
                  onChange={(e) => setUrlsInput(e.target.value)}
                  placeholder="https://x.com/username/status/1234567890"
                  required
                  disabled={creating}
                />
              </div>
            )}

            {campaignTypeToCreate === 'perpetual' && (
              <>
                <div className="form-group">
                  <label htmlFor="accounts-input" className="form-label">
                    Cuentas de X a monitorizar (una por línea o comas)
                  </label>
                  <textarea
                    id="accounts-input"
                    className="form-textarea"
                    rows={3}
                    value={accountsInput}
                    onChange={(e) => setAccountsInput(e.target.value)}
                    placeholder="@usuario1, https://x.com/usuario2"
                    required
                    disabled={creating}
                  />
                  <p style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginTop: '4px' }}>
                    Puedes introducir @usuario, usuario o la URL de su perfil. Separa varias cuentas con comas o saltos de línea.
                  </p>
                </div>
                <div className="form-group">
                  <label htmlFor="duration-input" className="form-label">
                    Duración activa de cada nuevo post detectado (horas)
                  </label>
                  <input
                    id="duration-input"
                    type="number"
                    min="1" max="720" step="1"
                    className="form-textarea"
                    style={{ minHeight: 'auto', padding: '8px' }}
                    value={postActiveLifetimeHours}
                    onChange={(e) => setPostActiveLifetimeHours(e.target.value)}
                    required
                    disabled={creating}
                  />
                </div>
              </>
            )}

            <div className="form-group">
              <label htmlFor="direction-input" className="form-label">
                Dirección de los comentarios (opcional)
              </label>
              <textarea
                id="direction-input"
                className="form-textarea"
                rows={2}
                value={direction}
                onChange={(e) => setDirection(e.target.value)}
                placeholder="Instrucciones sobre el tono, enfoque o intención deseada..."
                disabled={creating}
              />
            </div>

            <button
              type="submit"
              className="btn-admin btn-primary"
              disabled={creating || (campaignTypeToCreate === 'manual' && !urlsInput.trim()) || (campaignTypeToCreate === 'perpetual' && !accountsInput.trim())}
            >
              {creating ? 'Creando campaña...' : 'Crear Campaña'}
            </button>
          </form>
        </section>

        {/* Campaigns List */}
        <section className="admin-card">
          <h2 className="admin-card-header">
            Campañas ({campaigns.length})
          </h2>

          {loading ? (
            <p style={{ color: 'var(--text-muted)' }}>Cargando campañas...</p>
          ) : campaigns.length === 0 ? (
            <p style={{ color: 'var(--text-muted)' }}>
              No existen campañas creadas. Utiliza el formulario superior para crear la primera.
            </p>
          ) : (
            <div className="campaigns-grid">
              {campaigns.map((c) => (
                <CampaignCardItem
                  key={c.id}
                  c={c}
                  fetchCampaigns={fetchCampaigns}
                  handleToggleStatus={handleToggleStatus}
                  handleRetryGeneration={handleRetryGeneration}
                  handleCopyUrl={handleCopyUrl}
                  copiedId={copiedId}
                />
              ))}
            </div>
          )}
        </section>
      </main>
    </div>
  );
}
