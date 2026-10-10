import React, { useState, useEffect, useCallback, useMemo, useRef, useSyncExternalStore } from 'react';
import { 
  Home, Folder, LayoutGrid, List as ListIcon,
  Loader2, RefreshCw, AlertTriangle, ArrowLeft, PencilLine, FolderOpen,
  Info, FileSearch, Copy, ChevronLeft, ChevronRight, Download
} from 'lucide-react';
import { motion } from 'framer-motion';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { FileIcon } from './FileIcon';
import { FileEditor } from './FileEditor';
import { DEFAULT_EXPLORER_ROOT, resolveExplorerHome } from '@/lib/explorer-home';

interface FileExplorerProps {
  instanceId: string;
  defaultPath?: string;
  rootPath?: string;
}

export interface ExplorerFile {
  name: string;
  type: 'file' | 'directory' | 'symlink' | 'other';
  size: number;
  modifyTime: number;
}

const PREVIEWABLE_TEXT_EXTENSIONS = new Set([
  'md', 'markdown', 'txt', 'csv', 'json', 'jsonc', 'yaml', 'yml', 'toml',
  'ini', 'cfg', 'conf', 'env', 'sh', 'bash', 'zsh', 'js', 'jsx', 'ts',
  'tsx', 'py', 'rb', 'go', 'rs', 'java', 'c', 'cpp', 'h', 'hpp', 'css',
  'scss', 'html', 'xml', 'sql', 'log'
]);

function getExtension(name: string) {
  return name.split('.').pop()?.toLowerCase() || '';
}

function joinExplorerPath(basePath: string, name: string) {
  return basePath.endsWith('/') ? `${basePath}${name}` : `${basePath}/${name}`;
}

function isMarkdownFile(fileName: string) {
  const ext = getExtension(fileName);
  return ext === 'md' || ext === 'markdown';
}

function isPreviewableTextFile(file: ExplorerFile | null) {
  if (!file || file.type !== 'file') return false;
  return PREVIEWABLE_TEXT_EXTENSIONS.has(getExtension(file.name));
}

function isPdfPreviewFile(file: ExplorerFile | null) {
  return !!file && file.type === 'file' && getExtension(file.name) === 'pdf';
}

function isImagePreviewFile(file: ExplorerFile | null) {
  if (!file || file.type !== 'file') return false;
  return ['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'bmp'].includes(getExtension(file.name));
}

function buildBinaryPreviewSrc(instanceId: string, filePath: string) {
  return `/api/instances/${instanceId}/sftp?path=${encodeURIComponent(filePath)}`;
}

function buildDownloadHref(instanceId: string, filePath: string) {
  return `/api/instances/${instanceId}/sftp?path=${encodeURIComponent(filePath)}&download=1`;
}

function normalizeExplorerPath(path: string) {
  const compactPath = path.replace(/\/+/g, "/");
  if (compactPath === "/") return "/";
  return compactPath.endsWith("/") ? compactPath.slice(0, -1) : compactPath;
}

function isPathWithinRoot(path: string, rootPath: string) {
  if (rootPath === "/") return true;
  return path === rootPath || path.startsWith(`${rootPath}/`);
}

function clampPathToRoot(path: string, rootPath: string) {
  const normalizedPath = normalizeExplorerPath(path);
  const normalizedRootPath = normalizeExplorerPath(rootPath);
  return isPathWithinRoot(normalizedPath, normalizedRootPath) ? normalizedPath : normalizedRootPath;
}

// Below Tailwind's lg breakpoint the list and the dossier share one column, so
// the explorer shows one of them at a time and folders open on a single tap.
const NARROW_EXPLORER_QUERY = '(max-width: 1023px)';

function subscribeNarrowExplorer(notify: () => void) {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return () => {};
  const query = window.matchMedia(NARROW_EXPLORER_QUERY);
  query.addEventListener?.('change', notify);
  return () => query.removeEventListener?.('change', notify);
}

function readNarrowExplorer() {
  return typeof window !== 'undefined'
    && typeof window.matchMedia === 'function'
    && window.matchMedia(NARROW_EXPLORER_QUERY).matches;
}

function buildBreadcrumbs(currentPath: string, rootPath: string) {
  const normalizedCurrentPath = clampPathToRoot(currentPath, rootPath);
  const normalizedRootPath = normalizeExplorerPath(rootPath);
  const currentSegments = normalizedCurrentPath.split('/').filter(Boolean);
  const rootSegments = normalizedRootPath.split('/').filter(Boolean);

  if (normalizedRootPath === "/") {
    return currentSegments.map((part, index) => ({
      label: part,
      path: `/${currentSegments.slice(0, index + 1).join('/')}`,
    }));
  }

  const breadcrumbs = [
    {
      label: rootSegments[rootSegments.length - 1] ?? normalizedRootPath,
      path: normalizedRootPath,
    },
  ];

  let cumulativePath = normalizedRootPath;
  for (const part of currentSegments.slice(rootSegments.length)) {
    cumulativePath = `${cumulativePath}/${part}`;
    breadcrumbs.push({ label: part, path: cumulativePath });
  }

  return breadcrumbs;
}

export function FileExplorer({ instanceId, defaultPath, rootPath = DEFAULT_EXPLORER_ROOT }: FileExplorerProps) {
  const explorerHome = normalizeExplorerPath(defaultPath ?? resolveExplorerHome(instanceId));
  const explorerRoot = normalizeExplorerPath(rootPath);
  const initialPath = clampPathToRoot(explorerHome, explorerRoot);
  const [currentPath, setCurrentPath] = useState(() => initialPath);
  const [history, setHistory] = useState<string[]>([initialPath]);
  const [historyIndex, setHistoryIndex] = useState(0);
  
  const [files, setFiles] = useState<ExplorerFile[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  
  const [viewMode, setViewMode] = useState<'grid' | 'list'>('grid');
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [editingFile, setEditingFile] = useState<string | null>(null);
  const [previewContent, setPreviewContent] = useState<string>('');
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [binaryPreviewError, setBinaryPreviewError] = useState<string | null>(null);
  // Narrow layouts show the dossier in place of the list while this is true.
  const [detailOpen, setDetailOpen] = useState(false);
  const narrowLayout = useSyncExternalStore(subscribeNarrowExplorer, readNarrowExplorer, () => false);
  const lastPointerTypeRef = useRef<string>('mouse');
  const breadcrumbScrollRef = useRef<HTMLDivElement>(null);
  const editorSectionRef = useRef<HTMLElement>(null);

  const fetchFiles = useCallback(async (path: string) => {
    const safePath = clampPathToRoot(path, explorerRoot);
    try {
      setLoading(true);
      setError(null);
      const res = await fetch(`/api/instances/${instanceId}/sftp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'list', path: safePath }),
      });
      const data = await res.json();
      if (data.ok) {
        setFiles(data.files || []);
      } else {
        setError(data.error || 'Failed to list directory');
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Network error');
    } finally {
      setLoading(false);
    }
  }, [explorerRoot, instanceId]);

  useEffect(() => {
    fetchFiles(currentPath);
  }, [currentPath, fetchFiles]);

  useEffect(() => {
    setCurrentPath((prev) => (prev === initialPath ? prev : initialPath));
    setHistory((prev) => (prev.length === 1 && prev[0] === initialPath ? prev : [initialPath]));
    setHistoryIndex((prev) => (prev === 0 ? prev : 0));
  }, [initialPath]);

  // Narrow screens scroll the breadcrumb row; keep the current folder in view.
  useEffect(() => {
    const crumbs = breadcrumbScrollRef.current;
    if (crumbs) crumbs.scrollLeft = crumbs.scrollWidth;
  }, [currentPath]);

  useEffect(() => {
    setSelectedPath(null);
    setDetailOpen(false);
    setPreviewContent('');
    setPreviewError(null);
    setPreviewLoading(false);
    setBinaryPreviewError(null);
  }, [currentPath]);

  const navigateTo = (path: string) => {
    const nextPath = clampPathToRoot(path, explorerRoot);
    if (nextPath === currentPath) return;
    const newHistory = history.slice(0, historyIndex + 1);
    newHistory.push(nextPath);
    setHistory(newHistory);
    setHistoryIndex(newHistory.length - 1);
    setCurrentPath(nextPath);
  };

  const navigateBack = () => {
    if (historyIndex > 0) {
      setHistoryIndex(historyIndex - 1);
      setCurrentPath(history[historyIndex - 1]);
    }
  };

  const selectedFile = useMemo(
    () => files.find((file) => joinExplorerPath(currentPath, file.name) === selectedPath) || null,
    [currentPath, files, selectedPath]
  );

  useEffect(() => {
    let isMounted = true;

    if (!selectedFile || !selectedPath || !isPreviewableTextFile(selectedFile)) {
      setPreviewContent('');
      setPreviewError(null);
      setPreviewLoading(false);
      return;
    }

    const fetchPreview = async () => {
      try {
        setPreviewLoading(true);
        setPreviewError(null);
        const res = await fetch(`/api/instances/${instanceId}/sftp`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'read', path: selectedPath }),
        });
        const data = await res.json();
        if (!isMounted) return;

        if (data.ok) {
          setPreviewContent(data.content || '');
        } else {
          setPreviewContent('');
          setPreviewError(data.error || 'Preview unavailable');
        }
      } catch (err: unknown) {
        if (!isMounted) return;
        setPreviewContent('');
        setPreviewError(err instanceof Error ? err.message : 'Preview unavailable');
      } finally {
        if (isMounted) setPreviewLoading(false);
      }
    };

    fetchPreview();

    return () => {
      isMounted = false;
    };
  }, [instanceId, selectedFile, selectedPath]);

  useEffect(() => {
    setBinaryPreviewError(null);
  }, [selectedPath]);

  // Below lg the editor mounts under the dossier's metadata, out of view in
  // the single-column scroller, so bring it up when editing starts.
  useEffect(() => {
    if (!editingFile || !narrowLayout) return;
    editorSectionRef.current?.scrollIntoView?.({ block: 'start' });
  }, [editingFile, narrowLayout]);

  // Touch and pen open on a single tap: a folder navigates, a file opens its
  // dossier. A mouse keeps select-then-double-click; below lg the selection
  // shows the dossier, whose Open Folder button moves inside.
  const handleFilePointerDown = (event: React.PointerEvent) => {
    lastPointerTypeRef.current = event.pointerType || 'mouse';
  };

  const isTapPointer = () => lastPointerTypeRef.current === 'touch' || lastPointerTypeRef.current === 'pen';

  const handleFileClick = (file: ExplorerFile) => {
    // Items on screen belong to the previous folder until a navigation's list
    // arrives; acting on them would resolve paths against the new folder.
    if (loading) return;
    const itemPath = joinExplorerPath(currentPath, file.name);
    if (isTapPointer() && file.type === 'directory') {
      navigateTo(itemPath);
      return;
    }
    setSelectedPath(itemPath);
    setDetailOpen(true);
  };

  const handleFileOpen = (file: ExplorerFile) => {
    if (loading) return;
    const itemPath = joinExplorerPath(currentPath, file.name);
    setSelectedPath(itemPath);
    setDetailOpen(true);

    if (file.type === 'directory') {
      navigateTo(itemPath);
      return;
    }

    if (isPreviewableTextFile(file)) {
      setEditingFile(itemPath);
    }
  };

  // A single tap already opened the item, so a double tap must not act twice.
  const handleFileDoubleClick = (file: ExplorerFile) => {
    if (isTapPointer()) return;
    handleFileOpen(file);
  };

  const breadcrumbs = buildBreadcrumbs(currentPath, explorerRoot);
  const selectedDisplayPath = selectedFile ? joinExplorerPath(currentPath, selectedFile.name) : currentPath;
  const binaryPreviewSrc = selectedFile
    ? buildBinaryPreviewSrc(instanceId, selectedDisplayPath)
    : null;
  const showDetailOnNarrow = detailOpen && Boolean(selectedFile);
  const downloadHref = selectedFile && selectedFile.type === 'file'
    ? buildDownloadHref(instanceId, selectedDisplayPath)
    : null;
  const itemCountLabel = `${files.length} item${files.length === 1 ? '' : 's'}`;
  const currentFolderLabel = breadcrumbs[breadcrumbs.length - 1]?.label ?? '/';

  const formatSize = (bytes: number) => {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
  };

  const formatDate = (unixTime: number) => {
    if (!unixTime) return '--';
    const d = new Date(unixTime * 1000);
    return d.toLocaleDateString() + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  };

  const copySelectedPath = async () => {
    if (!selectedDisplayPath || typeof navigator === 'undefined' || !navigator.clipboard) return;
    try {
      await navigator.clipboard.writeText(selectedDisplayPath);
    } catch {
      // Clipboard support varies by browser and embed context; failing silently is acceptable here.
    }
  };

  return (
    <div className="relative flex h-full w-full min-h-0 flex-col bg-[var(--bg-primary)] text-[var(--ink-black)]">
      <div
        className="shrink-0 border-b border-[var(--etched-border)] bg-[color-mix(in_srgb,var(--vellum-bg)_82%,transparent)] px-4 py-4 sm:px-8 sm:pt-[22px] sm:pb-5"
      >
        <div className="flex flex-col gap-4">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-3">
              <span className="mono inline-flex items-center gap-2 text-[10px] uppercase leading-none tracking-[0.18em] text-[var(--ink-black)]">
                <Folder size={12} className="text-[var(--gold-leaf)]" />
                Browser
              </span>
              <span className="h-3.5 w-px bg-[var(--etched-border)]" aria-hidden="true" />
              <span className="text-[12px] leading-none font-medium text-[var(--text-secondary)]">
                {loading && files.length === 0 ? 'Loading…' : itemCountLabel}
              </span>
              {selectedFile ? (
                <>
                  <span className="h-3.5 w-px bg-[var(--etched-border)]" aria-hidden="true" />
                  <span className="text-[12px] leading-none text-[var(--text-secondary)]">
                  {selectedFile.type === 'directory' ? 'Folder selected' : 'Preview ready'}
                  </span>
                </>
              ) : null}
            </div>

            <div className="mt-3 flex flex-row items-center gap-2 md:gap-3">
              <div className="inline-flex overflow-hidden border border-[var(--etched-border)] bg-[var(--bg-surface)]">
                <button
                  onClick={navigateBack}
                  disabled={historyIndex === 0}
                  aria-label="Go back"
                  className={`inline-flex h-10 w-10 items-center justify-center border transition-colors pointer-coarse:h-[44px] pointer-coarse:w-[44px] ${
                    historyIndex > 0
                      ? 'border-transparent bg-[var(--bg-surface)] text-[var(--ink-black)] hover:bg-[var(--bg-elevated)]'
                      : 'cursor-not-allowed border-transparent bg-[var(--bg-surface)] text-[var(--text-muted)]'
                  }`}
                >
                  <ArrowLeft size={16} />
                </button>

                <button
                  onClick={() => navigateTo(explorerHome)}
                  aria-label="Go to explorer home"
                  className="inline-flex h-10 w-10 items-center justify-center border-l border-[var(--etched-border)] bg-[var(--bg-surface)] text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-elevated)] hover:text-[var(--ink-black)] pointer-coarse:h-[44px] pointer-coarse:w-[44px]"
                >
                  <Home size={16} />
                </button>
              </div>

              <div className="min-w-0 flex-1 border border-[var(--etched-border)] bg-[var(--bg-surface)]">
                <div
                  ref={breadcrumbScrollRef}
                  aria-label="Current path"
                  className="flex min-h-[40px] min-w-0 items-center overflow-x-auto whitespace-nowrap px-3 py-0 text-sm sm:px-5 sm:py-3 pointer-coarse:min-h-[44px]"
                >
                    <span className="mr-1.5 shrink-0 text-[var(--text-muted)]">/</span>
                    {breadcrumbs.map((breadcrumb, i) => {
                      const isLast = i === breadcrumbs.length - 1;

                      return (
                        <React.Fragment key={breadcrumb.path}>
                          <button
                            onClick={() => navigateTo(breadcrumb.path)}
                            className={`max-w-[160px] truncate transition-colors max-md:shrink-0 pointer-coarse:min-h-[40px] pointer-coarse:px-1.5 ${
                              isLast
                                ? 'font-semibold text-[var(--ink-black)]'
                                : 'text-[var(--text-secondary)] hover:text-[var(--ink-black)]'
                            }`}
                          >
                            {breadcrumb.label}
                          </button>
                          {!isLast && <span className="mx-1.5 shrink-0 text-[var(--text-muted)]">/</span>}
                        </React.Fragment>
                      );
                    })}
                </div>
              </div>
            </div>
          </div>

          <div
            data-testid="explorer-header-controls"
            className="flex flex-wrap items-center gap-2.5"
            style={{
              paddingTop: 8,
              paddingBottom: 6,
            }}
          >
            <button
              onClick={() => fetchFiles(currentPath)}
              aria-label="Refresh explorer"
              className="inline-flex items-center gap-2 border border-[var(--etched-border)] bg-[var(--bg-surface)] px-3.5 py-2.5 text-[11px] font-semibold uppercase tracking-[0.12em] text-[var(--text-secondary)] transition-colors hover:border-[var(--ink-black)] hover:text-[var(--ink-black)] pointer-coarse:min-h-[44px]"
              title="Refresh"
            >
              <RefreshCw size={14} className={loading && files.length > 0 ? "animate-spin" : ""} />
              Refresh
            </button>

            <div
              data-testid="explorer-view-toggle"
              className="inline-flex items-center gap-1 border border-[var(--etched-border)] bg-[var(--bg-surface)]"
              style={{
                padding: 2,
              }}
              aria-label="View mode"
            >
              <button
                onClick={() => setViewMode('grid')}
                aria-label="Grid view"
                aria-pressed={viewMode === 'grid'}
                className={`inline-flex min-w-[76px] items-center justify-center gap-2 px-3 py-2 text-[11px] font-semibold uppercase tracking-[0.12em] transition-colors pointer-coarse:min-h-[44px] ${
                  viewMode === 'grid'
                    ? 'border border-[var(--ink-black)] bg-[var(--ink-black)] text-[var(--bg-surface)]'
                    : 'border border-transparent text-[var(--text-secondary)] hover:bg-[var(--bg-elevated)] hover:text-[var(--ink-black)]'
                }`}
                style={{
                  color: viewMode === 'grid' ? 'var(--vellum-bg)' : 'var(--ink-black)',
                }}
              >
                <LayoutGrid size={14} />
                Grid
              </button>
              <button
                onClick={() => setViewMode('list')}
                aria-label="List view"
                aria-pressed={viewMode === 'list'}
                className={`inline-flex min-w-[76px] items-center justify-center gap-2 px-3 py-2 text-[11px] font-semibold uppercase tracking-[0.12em] transition-colors pointer-coarse:min-h-[44px] ${
                  viewMode === 'list'
                    ? 'border border-[var(--ink-black)] bg-[var(--ink-black)] text-[var(--bg-surface)]'
                    : 'border border-transparent text-[var(--text-secondary)] hover:bg-[var(--bg-elevated)] hover:text-[var(--ink-black)]'
                }`}
                style={{
                  color: viewMode === 'list' ? 'var(--vellum-bg)' : 'var(--ink-black)',
                }}
              >
                <ListIcon size={14} />
                List
              </button>
            </div>
          </div>
        </div>
      </div>

      <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
        <section
          data-testid="explorer-list-pane"
          className={`flex min-h-0 min-w-0 flex-1 flex-col border-[var(--etched-border)] lg:border-r ${showDetailOnNarrow ? 'max-lg:hidden' : ''}`}
        >
          <div
            data-testid="explorer-current-folder-bar"
            className="flex items-start justify-between gap-8 border-b border-[var(--etched-border)] bg-[var(--bg-surface)] px-10 py-6 max-sm:hidden"
            style={{
              paddingTop: 14,
              paddingBottom: 14,
              paddingLeft: 18,
              paddingRight: 18,
            }}
          >
            <div
              data-testid="explorer-current-folder-copy"
              className="min-w-0 flex-1 pt-1 pr-4 pl-2"
              style={{
                paddingTop: 4,
                paddingBottom: 4,
                paddingLeft: 6,
                paddingRight: 12,
              }}
            >
              <div className="mono text-[11px] sm:text-[9px] uppercase tracking-[0.16em] text-[var(--text-muted)]">Current Folder</div>
              <div className="mt-3 truncate text-sm font-semibold text-[var(--ink-black)]">{currentFolderLabel}</div>
            </div>
            <div
              className="shrink-0 pt-1 pr-3 text-right"
              style={{
                paddingTop: 6,
                paddingBottom: 6,
                paddingRight: 10,
              }}
            >
              <div className="mono text-[11px] sm:text-[9px] uppercase tracking-[0.16em] text-[var(--text-muted)]">Status</div>
              <div className="mt-3 text-sm text-[var(--text-secondary)]">
                {loading && files.length > 0 ? 'Refreshing…' : error ? 'Needs attention' : itemCountLabel}
              </div>
            </div>
          </div>

          <div className="relative min-h-0 flex-1 overflow-auto bg-[linear-gradient(180deg,color-mix(in_srgb,var(--bg-elevated)_70%,transparent),transparent_28%)]">
            {loading && files.length === 0 ? (
              <div className="absolute inset-0 flex items-center justify-center p-6">
                <div className="flex items-center gap-3 border border-[var(--etched-border)] bg-[var(--bg-surface)] px-5 py-4 text-sm text-[var(--text-secondary)] shadow-[0_16px_40px_rgba(0,0,0,0.06)]">
                  <Loader2 className="animate-spin text-[var(--gold-leaf)]" size={18} />
                  Opening remote filesystem…
                </div>
              </div>
            ) : error ? (
              <div className="absolute inset-0 flex items-center justify-center p-6">
                <div className="w-full max-w-xl border border-red-500/25 bg-[var(--bg-surface)] p-6 shadow-[0_16px_40px_rgba(0,0,0,0.08)]">
                  <div className="flex items-start gap-3">
                    <div className="mt-0.5 flex h-10 w-10 items-center justify-center border border-red-500/20 bg-red-500/5 text-red-500">
                      <AlertTriangle size={18} />
                    </div>
                    <div className="min-w-0">
                      <div className="mono text-[10px] uppercase tracking-[0.16em] text-red-500">Filesystem Unavailable</div>
                      <p className="mt-2 text-sm leading-6 text-[var(--text-secondary)]">{error}</p>
                    </div>
                  </div>
                  <div className="mt-5 flex flex-wrap gap-2">
                    <button
                      onClick={() => fetchFiles(currentPath)}
                      aria-label="Retry loading folder"
                      className="inline-flex items-center gap-2 border border-[var(--ink-black)] px-3 py-2 text-xs font-semibold uppercase tracking-[0.12em] text-[var(--ink-black)] transition-colors hover:bg-[var(--ink-black)] hover:text-[var(--bg-surface)]"
                    >
                      <RefreshCw size={13} />
                      Retry
                    </button>
                    <button
                      onClick={() => navigateTo(explorerHome)}
                      className="inline-flex items-center gap-2 border border-[var(--etched-border)] bg-[var(--bg-elevated)] px-3 py-2 text-xs font-semibold uppercase tracking-[0.12em] text-[var(--text-secondary)] transition-colors hover:border-[var(--ink-black)] hover:text-[var(--ink-black)]"
                    >
                      <Home size={13} />
                      Go Home
                    </button>
                  </div>
                </div>
              </div>
            ) : files.length === 0 ? (
              <div className="absolute inset-0 flex items-center justify-center p-6">
                <div className="flex w-full max-w-md flex-col items-center border border-dashed border-[var(--etched-border)] bg-[var(--bg-surface)] px-8 py-12 text-center">
                  <Folder size={42} className="text-[var(--gold-leaf)] opacity-80" />
                  <p className="mt-4 text-base font-semibold text-[var(--ink-black)]">This folder is empty</p>
                  <p className="mt-2 text-sm leading-6 text-[var(--text-secondary)]">
                    Files dropped into this directory will appear here automatically the next time the explorer refreshes.
                  </p>
                </div>
              </div>
            ) : (
              <div data-testid="explorer-file-list" className="p-3 sm:pt-10 sm:pb-10 sm:pl-10 sm:pr-14">
                {viewMode === 'grid' ? (
                  <div className="grid grid-cols-[repeat(auto-fill,minmax(140px,1fr))] gap-3 sm:grid-cols-[repeat(auto-fill,minmax(196px,1fr))] sm:gap-6">
                    {files.map((file) => {
                      const itemPath = joinExplorerPath(currentPath, file.name);
                      const isSelected = itemPath === selectedPath;

                      return (
                        <motion.div
                          key={file.name}
                          layoutId={`file-${file.name}`}
                          onPointerDown={handleFilePointerDown}
                          onClick={() => handleFileClick(file)}
                          onDoubleClick={() => handleFileDoubleClick(file)}
                          data-testid={`file-card-${file.name}`}
                          className={`group flex min-h-[120px] cursor-pointer flex-col gap-3 border bg-[var(--bg-surface)] p-4 text-left shadow-[0_10px_30px_rgba(0,0,0,0.04)] transition-all sm:min-h-[168px] sm:gap-[18px] sm:p-[22px] ${
                            isSelected
                              ? 'border-[var(--gold-leaf)] bg-[rgba(255, 44, 45,0.08)] shadow-[0_18px_40px_rgba(255, 44, 45,0.12)]'
                              : 'border-[var(--etched-border)] hover:-translate-y-[1px] hover:border-[rgba(255, 44, 45,0.34)] hover:bg-[var(--bg-elevated)]'
                          }`}
                        >
                          <div className="flex items-start justify-between gap-4">
                            <div
                              data-testid={`file-card-icon-frame-${file.name}`}
                              className="flex h-14 w-14 shrink-0 items-center justify-center border border-[var(--etched-border)] bg-[var(--bg-elevated)]"
                              style={{
                                width: 56,
                                height: 56,
                                padding: 10,
                              }}
                            >
                              <FileIcon type={file.type} name={file.name} size={32} className="shrink-0 transition-transform group-hover:scale-105" />
                            </div>
                            {isSelected ? <ChevronRight size={14} className="mt-1 text-[var(--gold-leaf)]" /> : null}
                          </div>
                          <div
                            className="space-y-3 px-1 pb-1"
                            style={{
                              paddingLeft: 6,
                              paddingRight: 12,
                              paddingBottom: 4,
                            }}
                          >
                            <span className="block break-all text-[13px] font-semibold leading-snug text-[var(--ink-black)]">
                              {file.name}
                            </span>
                            <div className="flex items-center justify-between gap-3 text-[11px] text-[var(--text-muted)]">
                              <span>{file.type === 'directory' ? 'Folder' : formatSize(file.size)}</span>
                              <span className="truncate">{formatDate(file.modifyTime)}</span>
                            </div>
                          </div>
                        </motion.div>
                      );
                    })}
                  </div>
                ) : (
                  <div className="overflow-hidden border border-[var(--etched-border)] bg-[var(--bg-surface)]">
                    <div className="sticky top-0 z-10 grid grid-cols-[minmax(0,1fr)_72px] gap-4 border-b border-[var(--etched-border)] bg-[var(--vellum-bg)] px-4 py-4 text-[11px] font-semibold uppercase tracking-[0.16em] text-[var(--text-muted)] sm:grid-cols-[minmax(0,1fr)_100px_160px] sm:px-10 sm:py-5 sm:text-[10px]">
                      <div>Name</div>
                      <div className="text-right">Size</div>
                      <div className="hidden text-right sm:block">Date Modified</div>
                    </div>
                    <div>
                      {files.map((file) => {
                        const itemPath = joinExplorerPath(currentPath, file.name);
                        const isSelected = itemPath === selectedPath;

                        return (
                          <motion.div
                            key={file.name}
                            layoutId={`file-list-${file.name}`}
                            onPointerDown={handleFilePointerDown}
                            onClick={() => handleFileClick(file)}
                            onDoubleClick={() => handleFileDoubleClick(file)}
                            data-testid={`file-row-${file.name}`}
                            className={`grid cursor-pointer grid-cols-[minmax(0,1fr)_72px] items-center gap-4 border-b border-[var(--border-subtle)] px-4 py-3 transition-colors last:border-b-0 sm:grid-cols-[minmax(0,1fr)_100px_160px] sm:px-10 sm:py-[18px] ${
                              isSelected
                                ? 'bg-[rgba(255, 44, 45,0.08)]'
                                : 'hover:bg-[var(--bg-elevated)]'
                            }`}
                          >
                            <div className="flex items-center gap-4 overflow-hidden">
                              <div
                                className="flex h-10 w-10 shrink-0 items-center justify-center border border-[var(--etched-border)] bg-[var(--bg-elevated)]"
                                style={{
                                  width: 40,
                                  height: 40,
                                  padding: 8,
                                }}
                              >
                                <FileIcon type={file.type} name={file.name} size={18} className="shrink-0" />
                              </div>
                              <span className="truncate font-medium text-[var(--ink-black)]">{file.name}</span>
                            </div>
                            <div className="text-right font-mono text-xs text-[var(--text-muted)]">
                              {file.type === 'directory' ? '--' : formatSize(file.size)}
                            </div>
                            <div className="hidden truncate text-right text-xs text-[var(--text-muted)] sm:block">
                              {formatDate(file.modifyTime)}
                            </div>
                          </motion.div>
                        );
                      })}
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        </section>

        <aside
          aria-label="Explorer dossier"
          className={`flex w-full shrink-0 flex-col border-[var(--etched-border)] bg-[color-mix(in_srgb,var(--bg-elevated)_82%,transparent)] lg:w-[440px] lg:min-w-[400px] lg:border-l xl:w-[504px] ${
            showDetailOnNarrow ? 'max-lg:min-h-0 max-lg:flex-1 max-lg:shrink' : 'max-lg:hidden'
          }`}
        >
          {showDetailOnNarrow ? (
            <div className="shrink-0 border-b border-[var(--etched-border)] bg-[var(--bg-surface)] lg:hidden">
              <button
                type="button"
                onClick={() => setDetailOpen(false)}
                className="mono inline-flex min-h-[44px] items-center gap-1.5 px-3 text-[11px] font-semibold uppercase tracking-[0.14em] text-[var(--ink-black)]"
              >
                <ChevronLeft size={16} aria-hidden="true" />
                Back to files
              </button>
            </div>
          ) : null}
          <div
            data-testid="explorer-dossier-content"
            className="flex-1 space-y-7 overflow-auto px-11 py-8"
            style={{
              paddingTop: 0,
              paddingBottom: 24,
              paddingLeft: 0,
              paddingRight: 0,
            }}
          >
            {selectedFile ? (
              <>
                <section
                  data-testid="explorer-actions-section"
                  className="border border-[var(--etched-border)] bg-[var(--bg-surface)] p-4 sm:p-[22px]"
                >
                  <div className="mono text-[10px] uppercase tracking-[0.16em] text-[var(--text-muted)]">Actions</div>
                  <div data-testid="explorer-actions-row" className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-2.5">
                    {selectedFile.type === 'directory' ? (
                      <button
                        onClick={() => handleFileOpen(selectedFile)}
                        className="inline-flex items-center gap-2 border border-[var(--ink-black)] px-3.5 py-2.5 text-xs font-semibold uppercase tracking-[0.12em] text-[var(--ink-black)] transition-colors hover:bg-[var(--ink-black)] hover:text-[var(--bg-surface)] pointer-coarse:min-h-[44px]"
                      >
                        <FolderOpen size={13} />
                        Open Folder
                      </button>
                    ) : isPreviewableTextFile(selectedFile) ? (
                      <button
                        onClick={() => setEditingFile(selectedDisplayPath)}
                        className="inline-flex items-center gap-2 border border-[var(--ink-black)] px-3.5 py-2.5 text-xs font-semibold uppercase tracking-[0.12em] text-[var(--ink-black)] transition-colors hover:bg-[var(--ink-black)] hover:text-[var(--bg-surface)] pointer-coarse:min-h-[44px]"
                      >
                        <PencilLine size={13} />
                        {editingFile === selectedDisplayPath ? 'Editing Here' : 'Open in Editor'}
                      </button>
                    ) : null}
                    {downloadHref ? (
                      <a
                        data-testid="explorer-download-link"
                        href={downloadHref}
                        download={selectedFile.name}
                        className="inline-flex items-center gap-2 px-0.5 py-1 text-xs font-semibold uppercase tracking-[0.12em] leading-none text-[var(--text-secondary)] no-underline transition-colors hover:text-[var(--ink-black)] pointer-coarse:min-h-[44px] pointer-coarse:border pointer-coarse:border-[var(--etched-border)] pointer-coarse:px-3"
                      >
                        <Download size={13} />
                        Download
                      </a>
                    ) : null}
                    <button
                      onClick={copySelectedPath}
                      className="inline-flex items-center gap-2 border border-[var(--etched-border)] bg-[var(--bg-elevated)] px-3.5 py-2.5 text-xs font-semibold uppercase tracking-[0.12em] text-[var(--text-secondary)] transition-colors hover:border-[var(--ink-black)] hover:text-[var(--ink-black)] pointer-coarse:min-h-[44px]"
                    >
                      <Copy size={13} />
                      Copy Path
                    </button>
                  </div>
                </section>

                <div data-testid="explorer-selection-summary" className="space-y-4">
                  <section className="border border-[var(--etched-border)] bg-[var(--bg-surface)] p-4 sm:p-[22px]">
                    <div className="mono text-[11px] sm:text-[10px] uppercase tracking-[0.16em] text-[var(--text-muted)]">Selected Item</div>
                    <div className="mt-4 flex items-start gap-4">
                      <div className="mt-0.5 flex h-11 w-11 shrink-0 items-center justify-center border border-[var(--etched-border)] bg-[var(--bg-elevated)] text-[var(--gold-leaf)]">
                        <Info size={18} />
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className="text-lg font-semibold leading-tight text-[var(--ink-black)]">{selectedFile.name}</p>
                        <p className="mt-2 break-all text-xs leading-5 text-[var(--text-muted)]">{selectedDisplayPath}</p>
                      </div>
                    </div>
                  </section>

                  <section
                    data-testid="explorer-metadata-grid"
                    className="grid gap-4 sm:grid-cols-3 lg:grid-cols-1 xl:grid-cols-3"
                  >
                    <article className="border border-[var(--etched-border)] bg-[var(--bg-surface)] p-3 sm:p-[18px]">
                      <div className="mono text-[11px] sm:text-[9px] uppercase tracking-[0.16em] text-[var(--text-muted)]">Type</div>
                      <div className="mt-2 text-sm font-semibold capitalize text-[var(--ink-black)]">{selectedFile.type}</div>
                    </article>
                    <article className="border border-[var(--etched-border)] bg-[var(--bg-surface)] p-3 sm:p-[18px]">
                      <div className="mono text-[11px] sm:text-[9px] uppercase tracking-[0.16em] text-[var(--text-muted)]">Size</div>
                      <div className="mt-2 text-sm font-semibold text-[var(--ink-black)]">
                        {selectedFile.type === 'directory' ? '--' : formatSize(selectedFile.size)}
                      </div>
                    </article>
                    <article className="border border-[var(--etched-border)] bg-[var(--bg-surface)] p-3 sm:p-[18px]">
                      <div className="mono text-[11px] sm:text-[9px] uppercase tracking-[0.16em] text-[var(--text-muted)]">Modified</div>
                      <div className="mt-2 text-sm font-semibold text-[var(--ink-black)]">{formatDate(selectedFile.modifyTime)}</div>
                    </article>
                  </section>
                </div>

                {editingFile === selectedDisplayPath ? (
                  <section ref={editorSectionRef} data-testid="explorer-editor-section" className="space-y-4">
                    <div className="flex items-start justify-between gap-4 px-1">
                      <div>
                        <div className="mono text-[10px] uppercase tracking-[0.16em] text-[var(--text-muted)]">Editor</div>
                        <p className="mt-2 text-sm leading-6 text-[var(--text-secondary)]">
                          Editing is inline here in the dossier and only persists when you choose Save.
                        </p>
                      </div>
                    </div>
                    <FileEditor
                      instanceId={instanceId}
                      filePath={editingFile}
                      onClose={() => setEditingFile(null)}
                      onSave={() => {
                        fetchFiles(currentPath);
                      }}
                    />
                  </section>
                ) : (
                  <section
                    data-testid="explorer-preview-section"
                    className="border border-[var(--etched-border)] bg-[var(--bg-surface)] p-4 sm:p-[22px]"
                  >
                    <div className="flex items-start justify-between gap-4">
                      <div>
                        <div className="mono text-[10px] uppercase tracking-[0.16em] text-[var(--text-muted)]">Preview</div>
                        <p className="mt-2 text-sm leading-6 text-[var(--text-secondary)]">
                          {selectedFile.type === 'directory'
                          ? 'Folders show navigation guidance here.'
                            : 'Rendered preview when supported, otherwise a readable content snippet.'}
                        </p>
                      </div>
                      <div
                        data-testid="explorer-preview-kind"
                        className="mt-0.5 inline-flex shrink-0 items-center border border-[var(--etched-border)] bg-[var(--bg-elevated)] px-2.5 py-1 text-[10px] font-medium uppercase tracking-[0.14em] text-[var(--text-muted)]"
                      >
                        {selectedFile.type === 'directory'
                          ? 'Folder'
                          : isPdfPreviewFile(selectedFile)
                            ? 'PDF'
                            : isImagePreviewFile(selectedFile)
                              ? 'Image'
                              : isPreviewableTextFile(selectedFile)
                                ? 'Text'
                          : 'Meta only'}
                      </div>
                    </div>
                    <div className="mt-4">
                      {selectedFile.type === 'directory' ? (
                        <div className="border border-dashed border-[var(--etched-border)] bg-[var(--bg-elevated)] px-5 py-7 text-sm text-[var(--text-muted)]">
                          <span className="pointer-coarse:hidden max-lg:hidden">This folder is selected. Double-click it or use “Open Folder” to move inside.</span>
                          <span className="hidden max-lg:inline pointer-coarse:hidden">This folder is selected. Use “Open Folder” to move inside.</span>
                          <span className="hidden pointer-coarse:inline">This folder is selected. Tap “Open Folder” to move inside.</span>
                        </div>
                      ) : isPdfPreviewFile(selectedFile) ? (
                        binaryPreviewError ? (
                          <div className="border border-red-500/20 bg-red-500/5 px-4 py-4 text-sm text-red-500">
                            {binaryPreviewError}
                          </div>
                        ) : (
                          <iframe
                            title={`${selectedFile.name} PDF preview`}
                            src={binaryPreviewSrc || undefined}
                            className="h-[50dvh] w-full border border-[var(--etched-border)] bg-[var(--bg-elevated)] sm:h-[400px]"
                            onError={() => setBinaryPreviewError('PDF preview could not be loaded in this browser context.')}
                          />
                        )
                      ) : isImagePreviewFile(selectedFile) ? (
                        binaryPreviewError ? (
                          <div className="border border-red-500/20 bg-red-500/5 px-4 py-4 text-sm text-red-500">
                            {binaryPreviewError}
                          </div>
                        ) : (
                          <div className="flex min-h-[240px] items-center justify-center border border-[var(--etched-border)] bg-[var(--bg-elevated)] p-5">
                            {/* eslint-disable-next-line @next/next/no-img-element -- preview uses transient object URLs that next/image does not manage well. */}
                            <img
                              alt={`${selectedFile.name} preview`}
                              src={binaryPreviewSrc || undefined}
                              className="max-h-[340px] w-auto max-w-full object-contain"
                              onError={() => setBinaryPreviewError('Image preview could not be loaded in this browser context.')}
                            />
                          </div>
                        )
                      ) : isPreviewableTextFile(selectedFile) ? (
                        previewLoading ? (
                          <div className="flex items-center gap-2 border border-[var(--etched-border)] bg-[var(--bg-elevated)] px-5 py-7 text-sm text-[var(--text-muted)]">
                            <Loader2 size={16} className="animate-spin" />
                            Loading preview…
                          </div>
                        ) : previewError ? (
                          <div className="border border-red-500/20 bg-red-500/5 px-4 py-4 text-sm text-red-500">
                            {previewError}
                          </div>
                        ) : isMarkdownFile(selectedFile.name) ? (
                          <div className="max-h-[420px] overflow-auto border border-[var(--etched-border)] bg-[var(--bg-elevated)] p-5 text-sm leading-6">
                            <div className="prose prose-sm max-w-none prose-headings:text-[var(--ink-black)] prose-p:text-[var(--text-secondary)] prose-strong:text-[var(--ink-black)]">
                              <ReactMarkdown remarkPlugins={[remarkGfm]}>
                                {previewContent || '*Empty markdown file.*'}
                              </ReactMarkdown>
                            </div>
                          </div>
                        ) : (
                          <pre className="max-h-[420px] overflow-auto whitespace-pre-wrap break-words border border-[var(--etched-border)] bg-[var(--bg-elevated)] p-5 text-xs leading-6 text-[var(--text-secondary)]">
                            {previewContent || 'Empty file.'}
                          </pre>
                        )
                      ) : (
                        <div className="border border-dashed border-[var(--etched-border)] bg-[var(--bg-elevated)] px-5 py-7 text-sm text-[var(--text-muted)]">
                          Rich preview is currently available for Markdown, text, PDFs, and common raster images. Other file types currently fall back to metadata-only inspection.
                        </div>
                      )}
                    </div>
                  </section>
                )}
              </>
            ) : (
              <div
                data-testid="explorer-dossier-empty"
                className="bg-transparent px-8 py-14 text-sm text-[var(--text-muted)]"
                style={{
                  paddingTop: 12,
                  paddingBottom: 12,
                  paddingLeft: 0,
                  paddingRight: 0,
                  borderStyle: "none",
                }}
              >
                <div className="flex items-start gap-4">
                  <div className="flex h-11 w-11 shrink-0 items-center justify-center border border-[var(--etched-border)] bg-[var(--bg-elevated)] text-[var(--gold-leaf)]">
                    <FileSearch size={18} />
                  </div>
                  <div className="px-4 py-1">
                    <p className="text-base font-semibold text-[var(--ink-black)]">Nothing selected yet</p>
                    <p className="mt-2 leading-6 text-[var(--text-secondary)]">
                      <span className="pointer-coarse:hidden">Click a file to inspect its metadata and preview, or double-click a folder to move through the instance filesystem.</span>
                      <span className="hidden pointer-coarse:inline">Tap a file to inspect its metadata and preview. Tap a folder to open it.</span>
                    </p>
                  </div>
                </div>
              </div>
            )}
          </div>
        </aside>
      </div>
    </div>
  );
}
