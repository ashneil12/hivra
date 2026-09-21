import { useState, useEffect } from 'react';
import { Save, X, AlertTriangle, Loader2 } from 'lucide-react';
import { motion, useReducedMotion } from 'framer-motion';
import { buildHermesFadeSlideVariants } from '@/components/ui/motion';

interface FileEditorProps {
  instanceId: string;
  filePath: string;
  onClose: () => void;
  onSave?: () => void;
}

export function FileEditor({ instanceId, filePath, onClose, onSave }: FileEditorProps) {
  const [content, setContent] = useState<string>('');
  const [originalContent, setOriginalContent] = useState<string>('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const reduceMotion = Boolean(useReducedMotion());
  const editorVariants = buildHermesFadeSlideVariants(reduceMotion, { offset: 14 });

  useEffect(() => {
    let mounted = true;
    const fetchContent = async () => {
      try {
        setLoading(true);
        setError(null);
        const res = await fetch(`/api/instances/${instanceId}/sftp`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'read', path: filePath }),
        });
        const data = await res.json();
        if (!mounted) return;
        
        if (data.ok) {
          setContent(data.content || '');
          setOriginalContent(data.content || '');
        } else {
          setError(data.error || 'Failed to read file');
        }
      } catch (err: unknown) {
        if (mounted) setError(err instanceof Error ? err.message : 'Network error');
      } finally {
        if (mounted) setLoading(false);
      }
    };
    
    fetchContent();
    return () => { mounted = false; };
  }, [instanceId, filePath]);

  const handleSave = async () => {
    try {
      setSaving(true);
      setError(null);
      const res = await fetch(`/api/instances/${instanceId}/sftp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'write', path: filePath, content }),
      });
      const data = await res.json();
      if (data.ok) {
        setOriginalContent(content);
        if (onSave) onSave();
      } else {
        setError(data.error || 'Failed to save file');
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Network error during save');
    } finally {
      setSaving(false);
    }
  };

  const hasChanges = content !== originalContent;
  const fileName = filePath.split('/').pop() || filePath;

  return (
    <motion.div 
      initial="hidden"
      animate="visible"
      exit="exit"
      variants={editorVariants}
      className="flex min-h-[36rem] flex-col border border-[var(--etched-border)] bg-[var(--bg-surface)] shadow-[0_20px_45px_rgba(0,0,0,0.08)]"
      data-testid="file-editor-shell"
      style={{
        minHeight: 620,
      }}
    >
      <div className="flex items-center justify-between gap-4 border-b border-[var(--etched-border)] bg-[var(--bg-elevated)] px-5 py-4">
        <div className="flex items-center gap-2.5 overflow-hidden">
          <span className="font-mono text-sm text-[var(--ink-black)] truncate">{fileName}</span>
          {hasChanges ? <span className="h-2 w-2 rounded-full bg-[var(--gold-leaf)]" title="Unsaved changes" /> : null}
        </div>
        
        <div className="flex items-center gap-2 shrink-0">
          <button
            onClick={handleSave}
            disabled={!hasChanges || saving || loading}
            className={`flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold transition-colors ${
              hasChanges 
                ? 'border border-[var(--ink-black)] bg-[var(--ink-black)] text-[var(--bg-surface)] hover:bg-[var(--gold-leaf)] hover:text-[var(--ink-black)] hover:border-[var(--gold-leaf)]'
                : 'cursor-not-allowed border border-[var(--etched-border)] bg-[var(--bg-surface)] text-[var(--text-muted)]'
            }`}
          >
            {saving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
            Save
          </button>
          <button
            onClick={onClose}
            aria-label="Close editor"
            className="p-2 text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-surface)] hover:text-[var(--ink-black)]"
          >
            <X size={16} />
          </button>
        </div>
      </div>

      <div className="flex-1 relative overflow-hidden">
        {loading ? (
          <div className="absolute inset-0 flex items-center justify-center">
            <Loader2 className="animate-spin text-[var(--gold-leaf)]" size={32} />
          </div>
        ) : error ? (
          <div className="absolute inset-0 flex items-center justify-center p-6">
            <div className="flex max-w-lg flex-col items-center gap-4 border border-red-500/25 bg-red-500/5 p-6 text-center">
              <AlertTriangle className="text-red-500" size={32} />
              <p className="text-sm whitespace-pre-wrap text-red-500">{error}</p>
            </div>
          </div>
        ) : (
          <textarea
            value={content}
            onChange={(e) => setContent(e.target.value)}
            className="h-full w-full resize-none bg-[var(--bg-surface)] p-5 font-mono text-[13px] leading-7 text-[var(--ink-black)] outline-none focus:ring-1 focus:ring-inset focus:ring-[var(--gold-leaf)]/50"
            spellCheck={false}
            style={{
              padding: 24,
              lineHeight: "1.8",
            }}
          />
        )}
      </div>
    </motion.div>
  );
}
