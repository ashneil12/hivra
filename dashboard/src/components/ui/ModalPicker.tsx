'use client';

import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { Check, ChevronDown, Loader2, Search, X } from 'lucide-react';
import { SafePortal } from '@/components/ui/SafePortal';

export interface ModalPickerOption {
  value: string;
  label: string;
  description?: string;
  disabled?: boolean;
  keywords?: string[];
}

interface ModalPickerProps {
  id?: string;
  label: string;
  value: string;
  options: ModalPickerOption[];
  onChange: (value: string) => void;
  disabled?: boolean;
  loading?: boolean;
  placeholder?: string;
  dialogTitle?: string;
  dialogDescription?: string;
  searchPlaceholder?: string;
  emptyMessage?: string;
}

export function ModalPicker({
  id,
  label,
  value,
  options,
  onChange,
  disabled = false,
  loading = false,
  placeholder = 'Select...',
  dialogTitle,
  dialogDescription,
  searchPlaceholder = 'Search options...',
  emptyMessage = 'No options found.',
}: ModalPickerProps) {
  const reactId = useId().replace(/:/g, '');
  const baseId = id || `modal-picker-${reactId}`;
  const labelId = `${baseId}-label`;
  const valueId = `${baseId}-value`;
  const dialogTitleId = `${baseId}-dialog-title`;
  const dialogDescriptionId = `${baseId}-dialog-description`;
  const searchInputRef = useRef<HTMLInputElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');

  const selectedOption = options.find((option) => String(option.value) === String(value));

  const filteredOptions = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    if (!normalizedQuery) {
      return options;
    }

    return options.filter((option) => {
      const haystacks = [
        option.label,
        option.description,
        option.value,
        ...(option.keywords || []),
      ]
        .filter(Boolean)
        .map((part) => String(part).toLowerCase());

      return haystacks.some((part) => part.includes(normalizedQuery));
    });
  }, [options, query]);

  const openDialog = () => {
    if (disabled) return;
    setQuery('');
    setOpen(true);
  };

  const closeDialog = () => {
    setQuery('');
    setOpen(false);
    window.setTimeout(() => {
      triggerRef.current?.focus();
    }, 0);
  };

  useEffect(() => {
    if (!open) {
      return;
    }

    const focusTimer = window.setTimeout(() => {
      searchInputRef.current?.focus();
    }, 10);

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setQuery('');
        setOpen(false);
        window.setTimeout(() => {
          triggerRef.current?.focus();
        }, 0);
      }
    };

    window.addEventListener('keydown', handleKeyDown);

    return () => {
      window.clearTimeout(focusTimer);
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [open]);

  return (
    <>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <label id={labelId} className="mono" style={{ display: 'block', fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.15em', fontWeight: 600, opacity: 0.8 }}>
          {label}
          {loading && <Loader2 size={10} style={{ display: 'inline', marginLeft: 4, animation: 'spin 1s linear infinite' }} />}
        </label>
        <button
          ref={triggerRef}
          id={baseId}
          type="button"
          aria-haspopup="dialog"
          aria-expanded={open}
          aria-labelledby={`${labelId} ${valueId}`}
          disabled={disabled}
          onClick={openDialog}
          style={{
            width: '100%',
            textAlign: 'left',
            border: '1px solid var(--etched-border)',
            padding: '12px 40px 12px 14px',
            fontSize: 13,
            fontFamily: 'var(--font-mono), monospace',
            background: disabled ? 'color-mix(in srgb, var(--ink-black) 2%, var(--bg-surface))' : 'var(--bg-surface)',
            color: 'var(--ink-black)',
            cursor: disabled ? 'not-allowed' : 'pointer',
            opacity: disabled ? 0.6 : 1,
            position: 'relative',
          }}
        >
          <span id={valueId} style={{ display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {selectedOption?.label || placeholder}
          </span>
          <span style={{ position: 'absolute', right: 12, top: '50%', transform: 'translateY(-50%)', display: 'inline-flex', alignItems: 'center', gap: 8, color: 'var(--text-muted)' }}>
            {loading ? <Loader2 size={14} style={{ animation: 'spin 1s linear infinite' }} /> : <ChevronDown size={14} />}
          </span>
        </button>
      </div>

      {open && (
        <SafePortal>
          <div
            style={{
              position: 'fixed',
              inset: 0,
              zIndex: 9999,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              background: 'rgba(0,0,0,0.4)',
              backdropFilter: 'blur(4px)',
              padding: 20,
            }}
            onClick={closeDialog}
          >
            <div
              role="dialog"
              aria-modal="true"
              aria-labelledby={dialogTitleId}
              aria-describedby={dialogDescription ? dialogDescriptionId : undefined}
              style={{
                width: '100%',
                maxWidth: 560,
                maxHeight: 'calc(100vh - 40px)',
                background: 'var(--bg-surface)',
                border: '1px solid var(--ink-black)',
                boxShadow: '8px 8px 0px var(--ink-black)',
                display: 'flex',
                flexDirection: 'column',
                overflow: 'hidden',
              }}
              onClick={(event) => event.stopPropagation()}
            >
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '14px 20px', borderBottom: '1px solid var(--etched-border)', background: 'var(--vellum-bg)', flexShrink: 0 }}>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                  <h2 id={dialogTitleId} style={{ fontSize: 15, fontWeight: 700, color: 'var(--ink-black)', margin: 0 }}>
                    {dialogTitle || label}
                  </h2>
                  {dialogDescription && (
                    <p id={dialogDescriptionId} style={{ margin: 0, fontSize: 12, lineHeight: 1.5, color: 'var(--text-secondary)', maxWidth: 420 }}>
                      {dialogDescription}
                    </p>
                  )}
                </div>
                <button type="button" onClick={closeDialog} aria-label={`Close ${dialogTitle || label}`} style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--text-muted)' }}>
                  <X size={18} />
                </button>
              </div>

              <div style={{ padding: 20, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 16 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 12px', border: '1px solid var(--etched-border)', background: 'var(--vellum-bg)' }}>
                  <Search size={14} style={{ color: 'var(--text-muted)', flexShrink: 0 }} />
                  <input
                    ref={searchInputRef}
                    type="text"
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    placeholder={searchPlaceholder}
                    style={{
                      width: '100%',
                      border: 'none',
                      outline: 'none',
                      background: 'transparent',
                      fontSize: 13,
                      fontFamily: 'var(--font-mono), monospace',
                      color: 'var(--ink-black)',
                    }}
                  />
                </div>

                <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                  {filteredOptions.length === 0 ? (
                    <div style={{ padding: '28px 16px', border: '1px dashed var(--etched-border)', textAlign: 'center', fontSize: 12, color: 'var(--text-muted)', fontFamily: 'var(--font-mono), monospace' }}>
                      {emptyMessage}
                    </div>
                  ) : (
                    filteredOptions.map((option) => {
                      const selected = String(option.value) === String(value);

                      return (
                        <button
                          key={option.value}
                          type="button"
                          disabled={option.disabled}
                          onClick={() => {
                            onChange(option.value);
                            closeDialog();
                          }}
                          style={{
                            display: 'flex',
                            alignItems: 'flex-start',
                            justifyContent: 'space-between',
                            gap: 12,
                            width: '100%',
                            textAlign: 'left',
                            padding: '14px 16px',
                            border: selected ? '1px solid var(--ink-black)' : '1px solid var(--etched-border)',
                            background: selected ? 'var(--vellum-bg)' : 'var(--bg-surface)',
                            color: 'var(--ink-black)',
                            cursor: option.disabled ? 'not-allowed' : 'pointer',
                            opacity: option.disabled ? 0.5 : 1,
                          }}
                        >
                          <div style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 }}>
                            <span style={{ fontSize: 13, fontFamily: 'var(--font-mono), monospace', fontWeight: selected ? 700 : 500 }}>
                              {option.label}
                            </span>
                            {option.description && (
                              <span style={{ fontSize: 11, lineHeight: 1.5, color: 'var(--text-secondary)' }}>
                                {option.description}
                              </span>
                            )}
                          </div>
                          <span style={{ flexShrink: 0, color: selected ? 'var(--ink-black)' : 'transparent' }}>
                            <Check size={16} />
                          </span>
                        </button>
                      );
                    })
                  )}
                </div>
              </div>
            </div>
          </div>
        </SafePortal>
      )}
    </>
  );
}
