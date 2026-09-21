'use client';

import { Loader2, X, TrendingUp, AlertCircle } from 'lucide-react';

type ChangePlanMode = "in_place" | "checkout";

interface ChangePlanModalProps {
  isOpen: boolean;
  onClose: () => void;
  onConfirm: () => void;
  planName: string;
  priceInCents: number;
  loading: boolean;
  mode?: ChangePlanMode;
}

export function ChangePlanModal({
  isOpen,
  onClose,
  onConfirm,
  planName,
  priceInCents,
  loading,
  mode = "in_place",
}: ChangePlanModalProps) {
  if (!isOpen) return null;

  const isCheckoutMode = mode === "checkout";
  const title = isCheckoutMode ? "Open Secure Checkout" : "Confirm Upgrade";
  const description = isCheckoutMode
    ? "This plan has to be changed through Stripe Checkout."
    : "You are about to upgrade your subscription plan.";
  const notice = isCheckoutMode
    ? "Your current access stays active while checkout is pending. New plan access starts after checkout completes."
    : "Your new plan features will be available immediately. You will be charged a prorated amount for the remainder of your current billing cycle today.";
  const confirmLabel = isCheckoutMode ? "Open Checkout" : "Confirm Upgrade";

  return (
    <div
      style={{
        position: 'fixed',
        top: 0, left: 0, right: 0, bottom: 0,
        backgroundColor: 'rgba(0,0,0,0.5)',
        backdropFilter: 'blur(4px)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 200,
      }}
      onClick={(e) => { if (e.target === e.currentTarget && !loading) onClose(); }}
    >
      <div
        style={{
          backgroundColor: 'var(--bg-elevated)',
          position: 'relative',
          borderRadius: '0',
          width: '100%',
          maxWidth: '480px',
          display: 'flex',
          flexDirection: 'column',
          boxShadow: '0 24px 60px rgba(0,0,0,0.2), 0 0 0 1px var(--etched-border)',
          overflow: 'hidden',
        }}
      >
        {/* Header */}
        <div style={{ padding: '24px 32px', borderBottom: '1px solid var(--etched-border)', display: 'flex', justifyContent: 'space-between', alignItems: 'center', backgroundColor: 'var(--bg-surface)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
            <div style={{ 
              width: 40, height: 40, borderRadius: '0', 
              backgroundColor: 'var(--btn-bg)', 
              border: 'none',
              color: 'var(--btn-text)', 
              display: 'flex', alignItems: 'center', justifyContent: 'center' 
            }}>
              <TrendingUp size={20} />
            </div>
            <div>
              <h2 style={{ fontFamily: 'var(--font-playfair), serif', fontSize: '1.4rem', fontWeight: 600, margin: 0, color: 'var(--ink-black)' }}>
                {title}
              </h2>
              <p style={{ fontSize: '13px', color: 'var(--text-muted)', margin: '4px 0 0 0' }}>
                {description}
              </p>
            </div>
          </div>
          <button 
            onClick={onClose} 
            disabled={loading}
            style={{ 
              background: 'transparent', border: 'none', cursor: loading ? 'not-allowed' : 'pointer', 
              color: 'var(--text-muted)', padding: '8px', display: 'flex', alignItems: 'center', justifyContent: 'center', 
              borderRadius: '0', transition: 'background-color 0.2s', opacity: loading ? 0.5 : 1
            }} 
            onMouseEnter={e => !loading && (e.currentTarget.style.backgroundColor = 'var(--etched-border)')} 
            onMouseLeave={e => !loading && (e.currentTarget.style.backgroundColor = 'transparent')}
          >
            <X size={20} />
          </button>
        </div>

        {/* Body */}
        <div style={{ padding: '32px', display: 'flex', flexDirection: 'column', gap: '20px' }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
            <span style={{ fontSize: '13px', color: 'var(--text-muted)' }}>New Plan Selected</span>
            <span style={{ fontFamily: 'var(--font-playfair), serif', fontSize: '1.5rem', fontWeight: 700, color: 'var(--ink-black)' }}>
              {planName}
            </span>
          </div>

          <div style={{ border: '1px solid var(--etched-border)', padding: '16px', backgroundColor: 'var(--bg-surface)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span style={{ fontSize: '13px', color: 'var(--text-muted)', fontWeight: 600 }}>New Recurring Charge</span>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: '4px' }}>
              <span style={{ fontFamily: 'var(--font-playfair), serif', fontSize: '18px', fontWeight: 700, color: 'var(--ink-black)' }}>
                ${(priceInCents / 100).toFixed(2)}
              </span>
              <span style={{ fontSize: '12px', color: 'var(--text-muted)' }}>/mo</span>
            </div>
          </div>
          
          <div style={{ backgroundColor: 'rgba(0,0,0,0.03)', padding: '16px', borderLeft: '3px solid var(--ink-black)', display: 'flex', gap: '12px' }}>
            <AlertCircle size={16} style={{ flexShrink: 0, marginTop: 2, color: 'var(--ink-black)' }} />
            <p style={{ fontSize: '12px', color: 'var(--text-muted)', lineHeight: 1.5, margin: 0 }}>
              {notice}
            </p>
          </div>
        </div>

        {/* Footer */}
        <div style={{ padding: '20px 32px', borderTop: '1px solid var(--etched-border)', display: 'flex', justifyContent: 'flex-end', gap: '12px', backgroundColor: 'var(--bg-surface)' }}>
          <button
            type="button"
            disabled={loading}
            onClick={onClose}
            style={{
              padding: '10px 20px',
              borderRadius: '0',
              border: '1px solid var(--etched-border)',
              backgroundColor: 'transparent',
              cursor: loading ? 'not-allowed' : 'pointer',
              fontSize: '13px',
              fontWeight: 600,
              color: 'var(--ink-black)',
              transition: 'background-color 0.2s',
              opacity: loading ? 0.6 : 1
            }}
            onMouseEnter={e => !loading && (e.currentTarget.style.backgroundColor = 'var(--etched-border)')}
            onMouseLeave={e => !loading && (e.currentTarget.style.backgroundColor = 'transparent')}
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            disabled={loading}
            style={{
              padding: '10px 24px',
              borderRadius: '0',
              border: 'none',
              backgroundColor: 'var(--btn-bg)',
              color: 'var(--btn-text)',
              cursor: loading ? 'not-allowed' : 'pointer',
              fontSize: '13px',
              fontWeight: 600,
              display: 'flex',
              alignItems: 'center',
              gap: '8px',
              opacity: loading ? 0.7 : 1,
              transition: 'opacity 0.2s'
            }}
          >
            {loading ? <Loader2 size={16} style={{ animation: 'spin 1s linear infinite' }} /> : null}
            {loading ? 'Processing...' : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
