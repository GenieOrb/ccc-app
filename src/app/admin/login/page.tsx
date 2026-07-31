'use client';

import { useState, FormEvent } from 'react';
import { useRouter } from 'next/navigation';

export default function AdminLoginPage() {
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const router = useRouter();

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!password) return;

    setError(null);
    setLoading(true);

    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
      });

      const data = await res.json();

      if (!res.ok) {
        setError(data.error || 'Error de acceso.');
        setLoading(false);
        return;
      }

      router.push('/admin');
      router.refresh();
    } catch {
      setError('Error al conectar con el servidor.');
      setLoading(false);
    }
  }

  return (
    <div className="public-container">
      <div className="public-card" style={{ maxWidth: '400px' }}>
        <h1 style={{
          fontSize: '1.75rem',
          marginBottom: '20px',
          color: 'var(--color-primary)',
          textAlign: 'center'
        }}>
          Acceso Administrativo
        </h1>

        {error && (
          <div
            id="login-error"
            className="error-banner"
            style={{ marginBottom: '20px', textAlign: 'center' }}
            role="alert"
          >
            {error}
          </div>
        )}

        <form onSubmit={handleSubmit}>
          <div className="form-group">
            <label htmlFor="password-input" className="form-label">
              Contraseña de administración
            </label>
            <input
              id="password-input"
              type="password"
              className="form-input"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Introduce la contraseña"
              required
              disabled={loading}
              aria-describedby={error ? 'login-error' : undefined}
            />
          </div>

          <button
            type="submit"
            className="btn-admin btn-primary"
            style={{ width: '100%', padding: '12px', marginTop: '10px' }}
            disabled={loading || !password}
          >
            {loading ? 'Accediendo...' : 'Iniciar Sesión'}
          </button>
        </form>
      </div>
    </div>
  );
}
