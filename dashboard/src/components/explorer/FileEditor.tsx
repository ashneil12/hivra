import { useState, useEffect } from 'react';
import { Save, X, AlertTriangle, Loader2 } from 'lucide-react';
import { ThinkingOrb } from '@/components/ui/ThinkingOrb';
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
      className="flex min-h-[50dvh] flex-col overflow-hidden rounded-[14px] border border-[var(--hg-stroke)] bg-[var(--hg-surface)] shadow-[var(--hg-shadow-md)] lg:min-h-[620px]"
      data-testid="file-editor-shell"
    >
      <div className="flex items-center justify-between gap-4 min-h-[36px] border-b border-[var(--hg-stroke-subtle)] bg-[var(--hg-glass)] backdrop-blur-xl px-3 py-1.5 sm:px-4">
        <div className="flex items-center gap-2.5 overflow-hidden">
          <span className="font-mono text-sm text-[var(--ink-black)] truncate">{fileName}</span>
          {hasChanges ? <span className="h-2 w-2 rounded-full bg-[var(--hg-text-3)]" title="Unsaved changes" /> : null}
        </div>
        
        <div className="flex items-center gap-2 shrink-0">
          <button
            onClick={handleSave}
            disabled={!hasChanges || saving || loading}
            className={`flex items-center gap-1.5 rounded-[7px] px-3.5 py-2 text-xs font-semibold transition-colors pointer-coarse:min-h-[44px] ${
              hasChanges 
                ? 'border border-[var(--hg-accent)] bg-[var(--hg-accent)] text-[var(--hg-on-accent)] hover:opacity-90'
                : 'cursor-not-allowed border border-[var(--hg-stroke)] bg-transparent text-[var(--text-muted)]'
            }`}
          >
            {saving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
            Save
          </button>
          <button
            onClick={onClose}
            aria-label="Close editor"
            className="inline-flex items-center justify-center rounded-[7px] p-2 text-[var(--text-secondary)] transition-colors hover:bg-[var(--hg-fill-hover)] hover:text-[var(--ink-black)] pointer-coarse:min-h-[44px] pointer-coarse:min-w-[44px]"
          >
            <X size={16} />
          </button>
        </div>
      </div>

      <div className="flex-1 relative overflow-hidden">
        {loading ? (
          <div className="absolute inset-0 flex items-center justify-center">
            <ThinkingOrb size={32} state="working" label="Loading file" />
          </div>
        ) : error ? (
          <div className="absolute inset-0 flex items-center justify-center p-6">
            <div className="flex max-w-lg flex-col items-center gap-4 rounded-[14px] border border-[var(--hg-bad)]/25 bg-[var(--hg-bad)]/5 p-6 text-center">
              <AlertTriangle className="text-[var(--hg-bad)]" size={32} />
              <p className="text-sm whitespace-pre-wrap text-[var(--hg-bad)]">{error}</p>
            </div>
          </div>
        ) : (
          <textarea
            value={content}
            onChange={(e) => setContent(e.target.value)}
            className="h-full w-full resize-none bg-[var(--hg-surface)] p-3 font-mono text-[13px] leading-[1.8] text-[var(--ink-black)] outline-none focus:ring-1 focus:ring-inset focus:ring-[var(--hg-focus)]/50 sm:p-6"
            aria-label={`Edit ${fileName}`}
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            autoComplete="off"
          />
        )}
      </div>
    </motion.div>
  );
}
