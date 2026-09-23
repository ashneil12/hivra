'use client';

import { useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import { useRouter } from "next/navigation";
import { ArrowLeft, ArrowRight, LayoutDashboard, Terminal, PenTool, BarChart, HardHat, Search, Eye, X, Copy, Check, Save } from "lucide-react";
import type { AgentTemplate } from "@/data/agency-templates";
import { copyTextToClipboard } from "@/lib/client/clipboard";
import { clientLog } from "@/lib/client/logger";
import { DashboardPageShell } from "@/components/layout/DashboardPageShell";
import { useLocale } from "@/components/i18n/LocaleProvider";
import { useInfrastructureDialog } from "@/components/infrastructure/useInfrastructureDialog";

// Hover lifts only for a real hover pointer; a tap would otherwise leave the
// card shifted and tinted.
function canHover() {
  return typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(hover: hover)").matches;
}

// Category filters wrap on wider screens; phones get one horizontal row so
// the template grid is not pushed below several rows of chips.
const LIBRARY_CSS = `
.library-category-tabs { display: flex; flex-wrap: wrap; gap: 1rem; padding-bottom: 0.5rem; }
@media (max-width: 767px) {
  .library-category-tabs { flex-wrap: nowrap; overflow-x: auto; gap: 0.5rem; scrollbar-width: none; overscroll-behavior-x: contain; }
  .library-category-tabs::-webkit-scrollbar { display: none; }
  .library-category-tabs > button { flex: 0 0 auto; min-height: 40px; }
}
@media (max-width: 767px), (pointer: coarse) {
  .library-touch-target { min-height: 44px; }
}
`;

export default function LibraryPage() {
  const router = useRouter();
  const { copy } = useLocale();
  const libraryCopy = copy.dashboard.library;
  const [selectedCategory, setSelectedCategory] = useState<string>("All");
  const [searchQuery, setSearchQuery] = useState("");
  const [previewTemplate, setPreviewTemplate] = useState<AgentTemplate | null>(null);
  const [copied, setCopied] = useState(false);
  const [agencyTemplates, setAgencyTemplates] = useState<AgentTemplate[]>([]);
  const [loadState, setLoadState] = useState<"loading" | "ready" | "error">("loading");
  const [reloadKey, setReloadKey] = useState(0);
  const copyResetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    let alive = true;
    fetch("/api/agency-templates")
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(String(res.status)))))
      .then((data) => {
        if (!alive) return;
        if (data.success) {
          setAgencyTemplates(data.data);
          setLoadState("ready");
        } else {
          setLoadState("error");
        }
      })
      .catch((err) => {
        if (alive) setLoadState("error");
        clientLog.error("Failed to load agent templates", err, {
          source: "prompt-library",
          route: "/api/agency-templates",
        });
      });

    return () => {
      alive = false;
      if (copyResetTimerRef.current) {
        clearTimeout(copyResetTimerRef.current);
      }
    };
  }, [reloadKey]);

  const handleCopy = async (text: string) => {
    const didCopy = await copyTextToClipboard(text);
    if (!didCopy) {
      return;
    }

    setCopied(true);
    if (copyResetTimerRef.current) {
      clearTimeout(copyResetTimerRef.current);
    }
    copyResetTimerRef.current = setTimeout(() => {
      setCopied(false);
      copyResetTimerRef.current = null;
    }, 2000);
  };

  const categories = useMemo(
    () => ["All", ...Array.from(new Set(agencyTemplates.map((template) => template.category))).sort()],
    [agencyTemplates]
  );

  const filteredTemplates = useMemo(
    () =>
      agencyTemplates.filter((template) => {
        const matchesCategory = selectedCategory === "All" || template.category === selectedCategory;
        const matchesSearch =
          template.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
          template.description.toLowerCase().includes(searchQuery.toLowerCase());
        return matchesCategory && matchesSearch;
      }),
    [agencyTemplates, searchQuery, selectedCategory]
  );

  const featuredTemplates = filteredTemplates.filter(t => t.isFeatured);
  const regularTemplates = filteredTemplates.filter(t => !t.isFeatured);

  const getCategoryIcon = (category: string) => {
    switch(category) {
      case "Engineering": return <Terminal size={14} />;
      case "Design": return <PenTool size={14} />;
      case "Marketing": return <BarChart size={14} />;
      case "Product": return <LayoutDashboard size={14} />;
      default: return <HardHat size={14} />;
    }
  };

  const getCategoryLabel = (category: string) =>
    (libraryCopy.categories as Record<string, string>)[category] ?? category;

  return (
    <DashboardPageShell maxWidth={1000}>
      <style>{LIBRARY_CSS}</style>
      <header style={{ marginBottom: "3rem" }}>
        <button onClick={() => router.push("/dashboard")} style={{ display: "flex", alignItems: "center", gap: 8, minHeight: 44, padding: "0 2px", background: "none", border: "none", cursor: "pointer", marginBottom: "1.25rem", fontFamily: "var(--font-mono), monospace", fontSize: 10, textTransform: "uppercase", letterSpacing: "0.2em", opacity: 0.5 }}>
          <ArrowLeft size={12} /> {libraryCopy.returnToCommandCenter}
        </button>
        <h2 className="serif" style={{ fontSize: "3rem", fontWeight: 300, lineHeight: 1.1, marginBottom: "1rem" }}>
          {libraryCopy.titlePrefix}{libraryCopy.titleSeparator}<em style={{ fontStyle: "italic" }}>{libraryCopy.titleEmphasis}</em>{libraryCopy.titleSuffix}
        </h2>
        <p style={{ opacity: 0.8, fontSize: 14, maxWidth: "600px", lineHeight: 1.6 }}>{libraryCopy.intro}</p>
        <p style={{ opacity: 0.5, fontSize: 12, marginTop: "0.5rem" }}>
          {libraryCopy.sourcePrefix} <a href="https://github.com/msitarzewski/agency-agents" target="_blank" rel="noopener noreferrer" style={{ textDecoration: 'underline', color: 'inherit' }}>{libraryCopy.sourceLinkLabel}</a>{libraryCopy.sourceSuffix}
        </p>
        <button
          onClick={() => router.push("/dashboard/templates")}
          className="library-touch-target"
          style={{ display: "inline-flex", alignItems: "center", gap: 8, marginTop: "1.25rem", padding: "8px 14px", background: "transparent", color: "var(--ink-black)", border: "1px solid var(--ink-black)", cursor: "pointer", fontFamily: "var(--font-mono), monospace", fontSize: 10, textTransform: "uppercase", letterSpacing: "0.15em", fontWeight: 600 }}
        >
          <Save size={13} /> Save &amp; share your agents as templates
        </button>
      </header>

      {/* Controls: Search and Filter Tabs */}
      <div style={{ display: "flex", flexDirection: "column", gap: "1.5rem", marginBottom: "3rem" }}>
        
        {/* Search Bar */}
        <div style={{ position: "relative", maxWidth: "400px" }}>
          <Search size={16} style={{ position: "absolute", left: "12px", top: "50%", transform: "translateY(-50%)", opacity: 0.4 }} />
          <input
            type="search"
            enterKeyHint="search"
            autoCapitalize="none"
            placeholder={libraryCopy.searchPlaceholder}
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            style={{
              width: "100%",
              padding: "12px 12px 12px 40px",
              background: "var(--bg-surface)",
              border: "1px solid var(--etched-border)",
              fontFamily: "var(--font-mono), monospace",
              fontSize: 12,
              outline: "none",
              color: "var(--ink-black)"
            }}
          />
        </div>

        {/* Filter Tabs */}
        <div className="library-category-tabs">
          {categories.map(cat => (
            <button
              key={cat}
              onClick={() => setSelectedCategory(cat)}
              style={{
                padding: "8px 16px",
                background: selectedCategory === cat ? "var(--btn-bg)" : "transparent",
                color: selectedCategory === cat ? "var(--btn-text)" : "var(--ink-black)",
                border: `1px solid ${selectedCategory === cat ? "var(--ink-black)" : "var(--etched-border)"}`,
                cursor: "pointer",
                fontFamily: "var(--font-mono), monospace",
                fontSize: 10,
                textTransform: "uppercase",
                letterSpacing: "0.1em",
                fontWeight: 600,
                transition: "all 0.2s ease",
                whiteSpace: "nowrap"
              }}
            >
              {getCategoryLabel(cat)}
            </button>
          ))}
        </div>
      </div>

      {/* Grid */}
      <div style={{ display: "flex", flexDirection: "column", gap: "3rem" }}>
        
        {featuredTemplates.length > 0 && (
          <div>
            <h3 className="mono" style={{ fontSize: 12, textTransform: "uppercase", letterSpacing: "0.1em", fontWeight: 600, marginBottom: "1.5rem", color: "var(--ink-black)", display: "flex", alignItems: "center", gap: "0.5rem" }}>
              <span style={{ color: "var(--accent-color, #ff4500)" }}>★</span> {libraryCopy.featured}
            </h3>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(300px, 1fr))", gap: "1.5rem" }}>
              {featuredTemplates.map((t: AgentTemplate) => (
                <div key={t.id} style={{ 
                  background: "var(--bg-surface)", 
                  border: "2px solid var(--ink-black)", 
                  padding: "1.5rem", 
                  display: "flex", 
                  flexDirection: "column",
                  transition: "all 0.2s ease",
                  boxShadow: "4px 4px 0px rgba(0,0,0,0.1)"
                }}
                onMouseEnter={e => { if (canHover()) e.currentTarget.style.transform = "translate(-2px, -2px)"; }}
                onMouseLeave={e => { e.currentTarget.style.transform = "translate(0px, 0px)"; }}
                >
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: "1rem" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", opacity: 0.8 }}>
                      {getCategoryIcon(t.category)}
                      <span className="mono" style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: "0.1em", fontWeight: 600 }}>{getCategoryLabel(t.category)}</span>
                    </div>
                  </div>
                  
                  <h3 style={{ fontSize: 18, fontWeight: 600, marginBottom: "0.5rem", color: "var(--ink-black)" }}>{t.name}</h3>
                  <p style={{ fontSize: 13, opacity: 0.7, lineHeight: 1.5, marginBottom: "1.5rem", flex: 1 }}>{t.description}</p>
                  
                  <div style={{ display: "flex", gap: "0.5rem" }}>
                    <button 
                      onClick={() => setPreviewTemplate(t)}
                      aria-label={libraryCopy.viewPrompt}
                      style={{
                        minWidth: 44,
                        minHeight: 44,
                        padding: "10px",
                        background: "transparent",
                        color: "var(--ink-black)",
                        border: "1px solid var(--etched-border)",
                        display: "flex",
                        justifyContent: "center",
                        alignItems: "center",
                        cursor: "pointer",
                        transition: "all 0.2s",
                      }}
                      onMouseEnter={e => { if (canHover()) e.currentTarget.style.background = "#f5f5f5"; }}
                      onMouseLeave={e => { e.currentTarget.style.background = "transparent"; }}
                      title={libraryCopy.viewPrompt}
                    >
                      <Eye size={14} />
                    </button>
                    
                    <button 
                      onClick={() => router.push(`/dashboard/chat?templateId=${t.id}`)}
                      style={{
                        flex: 1,
                        minHeight: 44,
                        padding: "10px",
                        background: "var(--btn-bg)", color: "var(--btn-text)",
                        border: "none",
                        display: "flex",
                        justifyContent: "space-between",
                        alignItems: "center",
                        cursor: "pointer",
                        fontFamily: "var(--font-mono), monospace",
                        fontSize: 10,
                        textTransform: "uppercase",
                        letterSpacing: "0.15em",
                        fontWeight: 600,
                      }}
                    >
                      <span>{libraryCopy.deploy}</span>
                      <ArrowRight size={14} />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {regularTemplates.length > 0 && (
          <div>
            <h3 className="mono" style={{ fontSize: 12, textTransform: "uppercase", letterSpacing: "0.1em", fontWeight: 600, marginBottom: "1.5rem", opacity: 0.5, display: "flex", alignItems: "center", gap: "0.5rem" }}>
              {libraryCopy.allTemplates}
            </h3>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(300px, 1fr))", gap: "1.5rem" }}>
              {regularTemplates.map((t: AgentTemplate) => (
                <div key={t.id} style={{ 
                  background: "var(--bg-surface)", 
                  border: "1px solid var(--etched-border)", 
                  padding: "1.5rem", 
                  display: "flex", 
                  flexDirection: "column",
                  transition: "all 0.2s ease",
                }}
                onMouseEnter={e => { if (canHover()) e.currentTarget.style.borderColor = "var(--ink-black)"; }}
                onMouseLeave={e => { e.currentTarget.style.borderColor = "var(--etched-border)"; }}
                >
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: "1rem" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", opacity: 0.5 }}>
                      {getCategoryIcon(t.category)}
                      <span className="mono" style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: "0.1em", fontWeight: 600 }}>{getCategoryLabel(t.category)}</span>
                    </div>
                  </div>
                  
                  <h3 style={{ fontSize: 18, fontWeight: 600, marginBottom: "0.5rem", color: "var(--ink-black)" }}>{t.name}</h3>
                  <p style={{ fontSize: 13, opacity: 0.7, lineHeight: 1.5, marginBottom: "1.5rem", flex: 1 }}>{t.description}</p>
                  
                  <div style={{ display: "flex", gap: "0.5rem" }}>
                    <button 
                      onClick={() => setPreviewTemplate(t)}
                      aria-label={libraryCopy.viewPrompt}
                      style={{
                        minWidth: 44,
                        minHeight: 44,
                        padding: "10px",
                        background: "transparent",
                        color: "var(--ink-black)",
                        border: "1px solid var(--etched-border)",
                        display: "flex",
                        justifyContent: "center",
                        alignItems: "center",
                        cursor: "pointer",
                        transition: "all 0.2s",
                      }}
                      onMouseEnter={e => { if (canHover()) e.currentTarget.style.background = "#f5f5f5"; }}
                      onMouseLeave={e => { e.currentTarget.style.background = "transparent"; }}
                      title={libraryCopy.viewPrompt}
                    >
                      <Eye size={14} />
                    </button>
                    
                    <button 
                      onClick={() => router.push(`/dashboard/chat?templateId=${t.id}`)}
                      style={{
                        flex: 1,
                        minHeight: 44,
                        padding: "10px",
                        background: "var(--btn-bg)", color: "var(--btn-text)",
                        border: "none",
                        display: "flex",
                        justifyContent: "space-between",
                        alignItems: "center",
                        cursor: "pointer",
                        fontFamily: "var(--font-mono), monospace",
                        fontSize: 10,
                        textTransform: "uppercase",
                        letterSpacing: "0.15em",
                        fontWeight: 600,
                      }}
                    >
                      <span>{libraryCopy.deploy}</span>
                      <ArrowRight size={14} />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {loadState === "loading" && (
          <div style={{ padding: "4rem", textAlign: "center", border: "1px dashed var(--etched-border)", opacity: 0.5 }}>
            <p className="mono" style={{ fontSize: 12, textTransform: "uppercase", letterSpacing: "0.1em" }}>Loading…</p>
          </div>
        )}

        {loadState === "error" && (
          <div style={{ padding: "4rem", textAlign: "center", border: "1px dashed var(--etched-border)" }}>
            <p className="mono" style={{ fontSize: 12, textTransform: "uppercase", letterSpacing: "0.1em", opacity: 0.7 }}>
              Couldn&apos;t load templates
            </p>
            <button
              type="button"
              onClick={() => {
                setLoadState("loading");
                setReloadKey((k) => k + 1);
              }}
              className="mono library-touch-target"
              style={{ marginTop: 12, fontSize: 12, padding: "6px 14px", borderRadius: 8, border: "1px solid var(--etched-border)", background: "transparent", color: "var(--text-secondary)", cursor: "pointer" }}
            >
              Retry
            </button>
          </div>
        )}

        {loadState === "ready" && filteredTemplates.length === 0 && (
          <div style={{ padding: "4rem", textAlign: "center", border: "1px dashed var(--etched-border)", opacity: 0.5 }}>
            <p className="mono" style={{ fontSize: 12, textTransform: "uppercase", letterSpacing: "0.1em" }}>{libraryCopy.empty}</p>
          </div>
        )}
      </div>

      {/* Preview Modal */}
      {previewTemplate && (
        <LibraryPreviewDialog
          title={previewTemplate.name}
          icon={getCategoryIcon(previewTemplate.category)}
          prompt={previewTemplate.prompt}
          copied={copied}
          closeLabel={libraryCopy.closePreview}
          copyLabel={copied ? libraryCopy.copied : libraryCopy.copyPrompt}
          deployLabel={libraryCopy.deployTemplate}
          onClose={() => setPreviewTemplate(null)}
          onCopy={() => handleCopy(previewTemplate.prompt)}
          onDeploy={() => router.push(`/dashboard/chat?templateId=${previewTemplate.id}`)}
        />
      )}
    </DashboardPageShell>
  );
}

// Mounted only while a preview is open so the shared dialog hook sees its
// node: focus moves to Close, Tab stays inside, Escape closes, the page
// behind is inert, and focus returns to the eye button that opened it.
function LibraryPreviewDialog({
  title,
  icon,
  prompt,
  copied,
  closeLabel,
  copyLabel,
  deployLabel,
  onClose,
  onCopy,
  onDeploy,
}: {
  title: string;
  icon: ReactNode;
  prompt: string;
  copied: boolean;
  closeLabel: string;
  copyLabel: string;
  deployLabel: string;
  onClose: () => void;
  onCopy: () => void;
  onDeploy: () => void;
}) {
  const closeRef = useRef<HTMLButtonElement | null>(null);
  const dialogRef = useInfrastructureDialog({ onClose, initialFocusRef: closeRef });

  // The hook locks the body; the dashboard also scrolls inside <main>.
  useEffect(() => {
    const scroller = dialogRef.current?.closest("main");
    if (!scroller) return;
    const previousOverflow = scroller.style.overflow;
    scroller.style.overflow = "hidden";
    return () => {
      scroller.style.overflow = previousOverflow;
    };
  }, [dialogRef]);

  return (
    <div style={{
      position: "fixed",
      top: 0, left: 0, right: 0, bottom: 0,
      background: "var(--overlay-bg)",
      backdropFilter: "blur(4px)",
      zIndex: 1000,
      display: "flex",
      justifyContent: "center",
      alignItems: "center",
      padding: "max(1rem, env(safe-area-inset-top, 0px)) max(1rem, env(safe-area-inset-right, 0px)) max(1rem, env(safe-area-inset-bottom, 0px)) max(1rem, env(safe-area-inset-left, 0px))"
    }}
    onClick={(e) => {
      if (e.target === e.currentTarget) onClose();
    }}>
      <div
        ref={dialogRef as RefObject<HTMLDivElement>}
        role="dialog"
        aria-modal="true"
        aria-labelledby="library-preview-title"
        tabIndex={-1}
        style={{
          background: "var(--bg-surface)",
          border: "1px solid var(--ink-black)",
          width: "100%",
          maxWidth: "800px",
          height: "min(80dvh, 100%)",
          display: "flex",
          flexDirection: "column",
          boxShadow: "10px 10px 0px rgba(0,0,0,0.1)"
        }}
      >
        <header style={{
          padding: "0.5rem 0.5rem 0.5rem 1.5rem",
          gap: "0.75rem",
          borderBottom: "1px solid var(--etched-border)",
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          background: "var(--btn-bg)", color: "var(--btn-text)"
        }}>
          <div style={{ display: "flex", alignItems: "center", gap: "1rem", minWidth: 0 }}>
            {icon}
            <h3 id="library-preview-title" className="mono" style={{ fontSize: 12, textTransform: "uppercase", letterSpacing: "0.1em", fontWeight: 600, margin: 0, overflowWrap: "anywhere" }}>
              {title}
            </h3>
          </div>
          <button
            ref={closeRef}
            onClick={onClose}
            aria-label={closeLabel}
            style={{ width: 44, height: 44, flexShrink: 0, background: "none", border: "none", color: "var(--btn-text)", cursor: "pointer", display: "grid", placeItems: "center" }}
          >
            <X size={16} />
          </button>
        </header>

        <div style={{ padding: "1.5rem", overflowY: "auto", overscrollBehavior: "contain", flex: 1, background: "var(--bg-elevated)" }}>
          <pre style={{
            margin: 0,
            whiteSpace: "pre-wrap",
            fontFamily: "var(--font-mono), monospace",
            fontSize: 12,
            lineHeight: 1.6,
            color: "var(--ink-black)"
          }}>
            {prompt}
          </pre>
        </div>

        <footer style={{ padding: "1rem 1.5rem", borderTop: "1px solid var(--etched-border)", display: "flex", flexWrap: "wrap", gap: "0.5rem", justifyContent: "space-between", background: "var(--bg-surface)" }}>
          <button
            onClick={onCopy}
            style={{
              flex: "1 1 140px",
              minHeight: 44,
              justifyContent: "center",
              padding: "10px 15px",
              background: "transparent",
              color: "var(--ink-black)",
              border: "1px solid var(--etched-border)",
              display: "flex",
              gap: "0.5rem",
              alignItems: "center",
              cursor: "pointer",
              fontFamily: "var(--font-mono), monospace",
              fontSize: 10,
              textTransform: "uppercase",
              letterSpacing: "0.15em",
              fontWeight: 600,
              transition: "all 0.2s"
            }}
          >
            {copied ? <Check size={14} /> : <Copy size={14} />}
            {copyLabel}
          </button>

          <button
            onClick={onDeploy}
            style={{
              flex: "1 1 140px",
              minHeight: 44,
              justifyContent: "center",
              padding: "10px 20px",
              background: "var(--btn-bg)", color: "var(--btn-text)",
              border: "none",
              display: "flex",
              gap: "0.5rem",
              alignItems: "center",
              cursor: "pointer",
              fontFamily: "var(--font-mono), monospace",
              fontSize: 10,
              textTransform: "uppercase",
              letterSpacing: "0.15em",
              fontWeight: 600,
            }}
          >
            {deployLabel} <ArrowRight size={14} />
          </button>
        </footer>
      </div>
    </div>
  );
}
