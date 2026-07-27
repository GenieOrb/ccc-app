'use client';

import { useState, useEffect, useRef } from 'react';
import type { ReactNode } from 'react';

interface Props {
  slug: string;
}

export default function PublicCommentView({ slug }: Props) {
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState<'success' | 'expired' | 'unavailable' | 'generating' | 'error'>('success');
  const [waitLong, setWaitLong] = useState(false);
  const [assignmentId, setAssignmentId] = useState('');
  const [comment, setComment] = useState('');
  const [hasCopied, setHasCopied] = useState(false);
  const [isCompleted, setIsCompleted] = useState(false);
  const [isPosting, setIsPosting] = useState(false);
  const [postError, setPostError] = useState(false);
  const isPostingRef = useRef(false);

  useEffect(() => {
    let isMounted = true;

    let timer: ReturnType<typeof setTimeout> | undefined;
    async function fetchAssignment() {
      try {
        const res = await fetch(`/api/public/comment/${slug}/assignment`, {
          method: 'POST',
        });

        const data = await res.json();

        if (!isMounted) return;

        if (res.ok && data.status === 'success') {
          setAssignmentId(data.assignmentId || '');
          setComment(data.comment || '');
          setStatus('success');
        } else if (data.status === 'expired') {
          setStatus('expired');
        } else if (data.status === 'unavailable') {
          setStatus('unavailable');
        } else if (data.status === 'generating') {
          setStatus('generating');
          timer = setTimeout(fetchAssignment, data.retryAfterMs || 2500);
        } else {
          setStatus('error');
        }
      } catch {
        if (isMounted) setStatus('error');
      } finally {
        if (isMounted) setLoading(false);
      }
    }

    fetchAssignment();

    return () => {
      isMounted = false;
      if (timer) clearTimeout(timer);
    };
  }, [slug]);

  useEffect(() => { if (status !== 'generating') return; const timer = setTimeout(() => setWaitLong(true), 10000); return () => clearTimeout(timer); }, [status]);

  function handleCopy() {
    if (!comment) return;

    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard
        .writeText(comment)
        .then(() => setHasCopied(true))
        .catch(() => fallbackCopy(comment));
    } else {
      fallbackCopy(comment);
    }
  }

  function fallbackCopy(text: string) {
    const textArea = document.createElement('textarea');
    textArea.value = text;
    textArea.style.position = 'fixed';
    textArea.style.opacity = '0';
    document.body.appendChild(textArea);
    textArea.focus();
    textArea.select();
    try {
      document.execCommand('copy');
      setHasCopied(true);
    } catch {
      // Ignore fallback error
    } finally {
      document.body.removeChild(textArea);
    }
  }

  async function handlePost() {
    if (!hasCopied || !assignmentId || isCompleted || isPostingRef.current) return;
    
    isPostingRef.current = true;
    setIsPosting(true);
    setPostError(false);
    
    const newTab = window.open('about:blank', '_blank');
    
    if (!newTab) {
      // Browser blocked the popup
      isPostingRef.current = false;
      setIsPosting(false);
      setPostError(true);
      return;
    }
    
    try {
      newTab.opener = null;
    } catch {
      // Ignore strictly cross-origin block if any
    }

    try {
      const res = await fetch(`/api/public/comment/${slug}/assignment/complete`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ assignmentId })
      });

      const data = await res.json();
      
      if (res.ok && data.status === 'success' && data.canonicalUrl) {
        newTab.location.replace(data.canonicalUrl);
        setIsCompleted(true);
        setIsPosting(false);
      } else {
        newTab.close();
        isPostingRef.current = false;
        setIsPosting(false);
        setPostError(true);
      }
    } catch {
      newTab.close();
      isPostingRef.current = false;
      setIsPosting(false);
      setPostError(true);
    }
  }

  const shell = (content: ReactNode) => <div className="public-container"><div className="public-banner">Promocionate con nuestra APP, mas info aqui.</div>{content}</div>;

  if (loading) {
    return (
      shell(<>
        <div className="public-card">
          <div className="skeleton-line" style={{ width: '60%' }} />
          <div className="skeleton-line" style={{ width: '80%' }} />
          <div className="skeleton-line" style={{ width: '70%' }} />
          <div className="skeleton-line" style={{ height: '80px', marginTop: '20px' }} />
        </div>
      </>)
    );
  }

  if (status === 'expired') {
    return (
      shell(<>
        <div className="public-card">
          <div className="status-message">Link expired</div>
        </div>
      </>)
    );
  }

  if (status === 'unavailable') {
    return (
      shell(<>
        <div className="public-card">
          <div className="status-message">This link is currently unavailable. Please try again later.</div>
        </div>
      </>)
    );
  }

  if (status === 'generating') return shell(<div className="public-card"><div className="status-message"><span className="spinner" />{waitLong ? 'This should only take a moment.' : 'Wait please...'}</div></div>);

  if (status === 'error' || !comment) {
    return (
      shell(<>
        <div className="public-card">
          <div className="status-message">Please try again</div>
        </div>
      </>)
    );
  }

  return (
    shell(<>
      <div className="public-card">
        {/* Instructions in English */}
        <ol className="instructions-list">
          <li className="instruction-item">1. Tap “Copy”</li>
          <li className="instruction-item">2. Tap “Post”</li>
          <li className="instruction-item">3. Paste the comment and post it</li>
        </ol>

        {/* Plain text uneditable comment display */}
        <div className="comment-box">{comment}</div>

        {postError && (
          <div className="status-message" style={{ fontSize: '0.9rem', marginBottom: '10px' }}>
            Please try again
          </div>
        )}

        {/* Public Action Buttons */}
        <div className="public-actions">
          <button
            type="button"
            onClick={handleCopy}
            className="btn-public btn-copy"
          >
            Copy
          </button>

          <button
            type="button"
            onClick={handlePost}
            className="btn-public btn-post"
            disabled={!hasCopied || isCompleted || isPosting}
          >
            Post
          </button>
        </div>
      </div>
    </>)
  );
}
