'use client';

import React, { useEffect, useState, useRef, useCallback } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { Lock, Save, AlertTriangle, Key, Plus, Trash2, Loader2, RefreshCw, Copy, CheckCircle2, Terminal } from 'lucide-react';
import { PROVIDERS as MODEL_PROVIDERS } from "@/lib/models";
import { CODEX_DEFAULT_MODEL, readCodexAuthenticatedFlag } from '@/lib/codex-oauth';
import { isCodexAuthProvider } from '@/lib/provider-auth';
import { copyTextToClipboard } from '@/lib/client/clipboard';
import { NousPortalOAuthModal } from '@/components/profile/NousPortalOAuthModal';
import { ModalPicker, type ModalPickerOption } from '@/components/ui/ModalPicker';
import { buildHermesFadeSlideVariants } from '@/components/ui/motion';
import Link from "next/link";
import { normalizeSshWarmupMessage } from '@/lib/ssh-warmup';

interface ApiKey {
  id: string;
  name: string;
  provider: string;
  key_preview: string;
  created_at: string;
}

interface ActiveAgent {
  id: string;
  name: string;
  provider: string;
  status: string;
  config?: { model?: string; [key: string]: unknown };
}

interface AgentProfileSummary {
  name: string;
  display_name?: string | null;
}

const KEY_PROVIDERS = [
  {
    category: "LLM Providers",
    items: [
      { id: "openrouter", label: "OpenRouter" },
      { id: "bankr", label: "Bankr LLM Gateway" },
      { id: "openai", label: "OpenAI" },
      { id: "anthropic", label: "Anthropic" },
      { id: "gemini", label: "Google Gemini" },
      { id: "deepseek", label: "DeepSeek" },
      { id: "xai", label: "xAI (Grok) — API key" },
      { id: "minimax", label: "MiniMax" },
      { id: "groq", label: "Groq" },
      { id: "codex", label: "Codex (ChatGPT Plus)" },
      { id: "alibaba", label: "Alibaba Cloud / Qwen" },
      { id: "moonshot", label: "Moonshot AI" },
      { id: "zhipu", label: "Zhipu AI" },
      { id: "crof", label: "CrofAI" },
      { id: "cometapi", label: "CometAPI" },
      { id: "nous", label: "Nous Portal" },
    ]
  },
  {
    category: "Memory & Storage",
    items: [
      { id: "honcho", label: "Honcho" },
      { id: "mem0", label: "Mem0" },
      { id: "redis", label: "Redis" }
    ]
  },
  {
    category: "Web & Scraping",
    items: [
      { id: "tavily", label: "Tavily Search" },
      { id: "exa", label: "Exa Search" },
      { id: "firecrawl", label: "Firecrawl" },
      { id: "browserbase", label: "Browserbase" },
      { id: "browser_use", label: "Browser Use" }
    ]
  },
  {
    category: "Other",
    items: [
      { id: "custom", label: "Custom Service" },
      { id: "webhook", label: "Webhook Token" }
    ]
  }
];

const getProviderLabel = (providerId: string) => {
  for (const group of KEY_PROVIDERS) {
    const found = group.items.find(p => p.id === providerId);
    if (found) return found.label;
  }
  return providerId;
};

function getCodexTargetLabel(agentName: string, profile?: AgentProfileSummary | null) {
  if (!profile || profile.name === 'default') {
    return `${agentName} Core`;
  }

  return profile.display_name ? `${profile.display_name} (${profile.name})` : profile.name;
}

function getCodexProfileOptionLabel(agentName: string, profile: AgentProfileSummary) {
  if (profile.name === 'default') {
    return `${agentName} Core (default)`;
  }

  return profile.display_name ? `${profile.display_name} (${profile.name})` : profile.name;
}

export default function VaultPage() {
  const reduceMotion = Boolean(useReducedMotion());
  const sectionVariants = buildHermesFadeSlideVariants(reduceMotion, { offset: 16 });
  const [loading, setLoading] = useState(true);
  const [keys, setKeys] = useState<ApiKey[]>([]);
  const [agents, setAgents] = useState<ActiveAgent[]>([]);
  
  const [savingKey, setSavingKey] = useState(false);
  const [deletingKey, setDeletingKey] = useState<string | null>(null);
  const [syncingAgent, setSyncingAgent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  // Form State for New Key
  const [isAddingMode, setIsAddingMode] = useState(false);
  const [isOauthMode, setIsOauthMode] = useState(false);
  const [newName, setNewName] = useState("");
  const [newProvider, setNewProvider] = useState("openrouter");
  const [newKey, setNewKey] = useState("");
  const [searchTerm, setSearchTerm] = useState("");

  // Codex OAuth Flow State
  type CodexStep = 'idle' | 'starting' | 'waiting' | 'success' | 'error';
  const [codexStep, setCodexStep] = useState<CodexStep>('idle');
  const [codexUrl, setCodexUrl] = useState('');
  const [codexCode, setCodexCode] = useState<string | null>(null);
  const [codexError, setCodexError] = useState('');
  const [codexCopied, setCodexCopied] = useState(false);
  const [codexAgentId, setCodexAgentId] = useState('');
  const [codexProfiles, setCodexProfiles] = useState<AgentProfileSummary[]>([]);
  const [codexProfilesLoading, setCodexProfilesLoading] = useState(false);
  const [codexProfileName, setCodexProfileName] = useState('default');
  const [showNousPortalOAuth, setShowNousPortalOAuth] = useState(false);
  const codexPollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const codexSuccessTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const successMessageTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const codexCopiedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Stop polling when unmounted
  useEffect(() => {
    return () => {
      if (codexPollRef.current) clearInterval(codexPollRef.current);
      if (codexSuccessTimerRef.current) clearTimeout(codexSuccessTimerRef.current);
      if (successMessageTimerRef.current) clearTimeout(successMessageTimerRef.current);
      if (codexCopiedTimerRef.current) clearTimeout(codexCopiedTimerRef.current);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;

    const loadProfiles = async () => {
      if (!codexAgentId) {
        setCodexProfiles([]);
        setCodexProfileName('default');
        return;
      }

      setCodexProfilesLoading(true);
      try {
        const response = await fetch(`/api/instances/${encodeURIComponent(codexAgentId)}/profiles`, {
          headers: { 'Cache-Control': 'no-cache' },
        });
        const payload = await response.json();

        if (cancelled) return;

        const profiles = payload.success && Array.isArray(payload.data) ? payload.data as AgentProfileSummary[] : [];
        setCodexProfiles(profiles);
        setCodexProfileName((current) => {
          if (profiles.some((profile) => profile.name === current)) {
            return current;
          }

          return profiles[0]?.name || 'default';
        });
      } catch {
        if (cancelled) return;
        setCodexProfiles([]);
        setCodexProfileName('default');
      } finally {
        if (!cancelled) setCodexProfilesLoading(false);
      }
    };

    void loadProfiles();

    return () => {
      cancelled = true;
    };
  }, [codexAgentId]);

  const handleCodexStart = useCallback(async () => {
    if (agents.length === 0) {
      setCodexError("No active agents found to run the Codex authorization script on. Please create or start an agent first.");
      setCodexStep('error');
      return;
    }
    const targetAgentId = codexAgentId || agents[0].id;
    const targetAgent = agents.find(agent => agent.id === targetAgentId) || agents[0];
    const targetProfile = codexProfiles.find((profile) => profile.name === codexProfileName) || null;
    const targetLabel = getCodexTargetLabel(targetAgent.name, targetProfile);
    const profileQuery =
      targetProfile?.name && targetProfile.name !== 'default'
        ? `?profile=${encodeURIComponent(targetProfile.name)}`
        : '';

    setCodexStep('starting');
    setCodexError('');
    if (codexSuccessTimerRef.current) {
      clearTimeout(codexSuccessTimerRef.current);
      codexSuccessTimerRef.current = null;
    }
    if (successMessageTimerRef.current) {
      clearTimeout(successMessageTimerRef.current);
      successMessageTimerRef.current = null;
    }
    try {
      const res = await fetch(`/api/instances/${targetAgentId}/oauth/codex/start${profileQuery}`, { method: 'POST' });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(
          normalizeSshWarmupMessage(data.error, 'Failed to start Codex OAuth')
        );
      }
      setCodexUrl(data.data.url);
      setCodexCode(data.data.code ?? null);
      setCodexStep('waiting');
      
      codexPollRef.current = setInterval(async () => {
        try {
          const sr = await fetch(`/api/instances/${targetAgentId}/oauth/codex/status${profileQuery}`);
          const sd = await sr.json();
          if (!sr.ok) {
            throw new Error(
              normalizeSshWarmupMessage(sd.error, 'Failed to check Codex OAuth status')
            );
          }
          if (sd?.data?.persistenceError) {
            throw new Error(`Codex connected on ${targetLabel}, but reusable Vault save failed: ${sd.data.persistenceError}`);
          }
          if (readCodexAuthenticatedFlag(sd)) {
            clearInterval(codexPollRef.current!);
            codexPollRef.current = null;
            setCodexStep('success');
            codexSuccessTimerRef.current = setTimeout(async () => {
              codexSuccessTimerRef.current = null;
              await fetchData();
              setCodexStep('idle');
              setIsAddingMode(false);
              setSuccess(`Codex session stored in Vault and authenticated via ${targetLabel}.`);
              if (successMessageTimerRef.current) {
                clearTimeout(successMessageTimerRef.current);
              }
              successMessageTimerRef.current = setTimeout(() => {
                setSuccess(null);
                successMessageTimerRef.current = null;
              }, 4000);
            }, 2500);
          }
        } catch (err: unknown) {
          if (codexPollRef.current) {
            clearInterval(codexPollRef.current);
            codexPollRef.current = null;
          }
          setCodexError(err instanceof Error ? err.message : String(err));
          setCodexStep('error');
        }
      }, 4000);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      setCodexError(normalizeSshWarmupMessage(message, 'Failed to start Codex OAuth'));
      setCodexStep('error');
    }
  }, [agents, codexAgentId, codexProfileName, codexProfiles]);



  // Agent Assignments mapping agentId -> { vaultKeyId, honchoVaultKeyId, model }
  const [agentAssignments, setAgentAssignments] = useState<Record<string, { vaultKeyId: string, honchoVaultKeyId: string, model: string }>>({});
  // Track which agent rows have unsaved changes
  const [changedAgents, setChangedAgents] = useState<Set<string>>(new Set());

  const fetchData = async () => {
    try {
      setLoading(true);
      const t = Date.now();
      const [keysRes, agentsRes] = await Promise.all([
        fetch(`/api/vault?t=${t}`, { headers: { 'Cache-Control': 'no-cache' } }).then(res => res.json()),
        fetch(`/api/instances?summary=true&t=${t}`, { headers: { 'Cache-Control': 'no-cache' } }).then(res => res.json())
      ]);

      if (keysRes.success) setKeys(keysRes.data);
      if (agentsRes.success) {
        setAgents(agentsRes.data);
        setCodexAgentId((current) => {
          if (current && agentsRes.data.some((agent: ActiveAgent) => agent.id === current)) {
            return current;
          }
          return agentsRes.data[0]?.id || "";
        });
      }
    } catch {
      setError("Failed to load vault securely.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchData();
  }, []);

  const handleCodexCopy = useCallback(async () => {
    if (!codexCode) {
      return;
    }

    const didCopy = await copyTextToClipboard(codexCode);
    if (!didCopy) {
      return;
    }

    setCodexCopied(true);
    if (codexCopiedTimerRef.current) {
      clearTimeout(codexCopiedTimerRef.current);
    }
    codexCopiedTimerRef.current = setTimeout(() => {
      setCodexCopied(false);
      codexCopiedTimerRef.current = null;
    }, 2000);
  }, [codexCode]);

  const scheduleSuccessMessageClear = useCallback((delayMs: number) => {
    if (successMessageTimerRef.current) {
      clearTimeout(successMessageTimerRef.current);
    }
    successMessageTimerRef.current = setTimeout(() => {
      setSuccess(null);
      successMessageTimerRef.current = null;
    }, delayMs);
  }, []);

  const handleSaveKey = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmedName = newName.trim();
    const trimmedKey = newKey.trim();

    if (!trimmedName || !trimmedKey) {
      setError("Name and Key are required.");
      return;
    }

    setSavingKey(true);
    setError(null);
    setSuccess(null);

    try {
      const res = await fetch("/api/vault", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: trimmedName, provider: newProvider, key: trimmedKey })
      });
      const data = await res.json();
      if (data.success) {
        setSuccess(`${trimmedName} saved to Vault securely.`);
        setNewName("");
        setNewKey("");
        setIsAddingMode(false);
        await fetchData();
        scheduleSuccessMessageClear(5000);
      } else {
        setError(data.error);
      }
    } catch {
      setError("Failed to save key into vault.");
    } finally {
      setSavingKey(false);
    }
  };

  const handleDeleteKey = async (id: string, name: string) => {
    if (!confirm(`Permanently destroy the key "${name}"? Agents relying on this will be unaffected until they restart.`)) return;

    setDeletingKey(id);
    setError(null);
    try {
      const res = await fetch(`/api/vault?id=${id}`, { method: "DELETE" });
      const data = await res.json();
      if (data.success) {
        await fetchData();
      } else {
        setError(data.error);
      }
    } catch {
      setError("Failed to delete key.");
    } finally {
      setDeletingKey(null);
    }
  };

  const syncAgentKey = async (agent: ActiveAgent) => {
    const assignment = agentAssignments[agent.id];
    if (!assignment) return;
    const selectedProviderKey = assignment.vaultKeyId
      ? keys.find(key => key.id === assignment.vaultKeyId)
      : undefined;

    setSyncingAgent(agent.id);
    setError(null);
    setSuccess(null);

    try {
      // For the updated instances handler, we need to resolve the raw key
      // but since we are replacing it, we can just send the vault id. Wait, the endpoint
      // actually doesn't accept vault profile anymore... Ah, we didn't add vaultKeyId to PATCH instances!
      // I need to make sure `PATCH /api/instances/[id]` accepts vaultKeyId / honchoVaultKeyId. 
      // Actually, we can fetch the keys here or let the backend handle it.
      // Wait, let's let the backend handle decrypting it. Wait, the PATCH endpoint only accepts raw `apiKey` right now!
      // Let's modify the body to pass the actual Vault IDs so the backend resolves them, or we can fetch the keys.
      // Since it's safer to keep decryption on the backend, let me just assume I passed the vault IDs to PATCH.
      // Let's update `PATCH` in the backend so it handles `vaultKeyId` and `honchoVaultKeyId` just like POST.

      const payload: Record<string, string | boolean> = { apply: true };
      
      if (assignment.vaultKeyId) {
         payload.vaultKeyId = assignment.vaultKeyId;
      }

      if (isCodexAuthProvider(selectedProviderKey?.provider)) {
        payload.provider = "codex";
        if (!assignment.model) {
          payload.model = CODEX_DEFAULT_MODEL;
        }
      }
      
      if (assignment.honchoVaultKeyId) {
         payload.honchoVaultKeyId = assignment.honchoVaultKeyId;
      }

      if (assignment.model) {
         payload.model = assignment.model;
      }

      const res = await fetch(`/api/instances/${agent.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });
      const data = await res.json();
      
      if (data.success) {
        setSuccess(`Agent ${agent.name} updated with new keys.`);
        setChangedAgents(prev => { const next = new Set(prev); next.delete(agent.id); return next; });
        scheduleSuccessMessageClear(3000);
      } else {
        setError(data.error);
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to sync agent configuration.");
    } finally {
      setSyncingAgent(null);
    }
  };

  const selectedCodexHost = agents.find((agent) => agent.id === codexAgentId) || agents[0];
  const hostPickerOptions: ModalPickerOption[] = agents.map((agent) => ({
    value: agent.id,
    label: agent.name,
    description: agent.status === 'running' ? 'Running instance' : `Status: ${agent.status}`,
    keywords: [agent.provider, agent.status],
  }));
  const profilePickerOptions: ModalPickerOption[] = (codexProfiles.length > 0 ? codexProfiles : [{ name: 'default' }]).map((profile) => ({
    value: profile.name,
    label: getCodexProfileOptionLabel(selectedCodexHost?.name || 'Main Instance', profile),
    description: profile.name === 'default' ? 'Main agent profile for this instance.' : 'Sub-agent profile on the selected instance.',
    keywords: [profile.name, profile.display_name || ''],
  }));

  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.5 }} style={{ maxWidth: 1100, margin: "1rem auto 5rem", padding: "clamp(1rem, 5vw, 3rem)", paddingTop: "calc(env(safe-area-inset-top, 0px) + clamp(1rem, 5vw, 3rem))" }}>
      <motion.header initial={{ opacity: 0, y: -20 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.5, ease: [0.16, 1, 0.3, 1] }} style={{ marginBottom: "3rem" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8 }}>
          <Lock size={12} style={{ color: "var(--ink-black)" }} />
          <span className="mono" style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: "0.3em", opacity: 0.6 }}>Infrastructure Security</span>
        </div>
        <h2 className="serif" style={{ fontSize: "3rem", fontWeight: 300, lineHeight: 1.1 }}>API Key <em>Vault</em>.</h2>
        <p style={{ marginTop: 16, opacity: 0.6, lineHeight: 1.6, fontSize: 14, maxWidth: 500 }}>
          Manage your individual API credentials globally. Bind these secure keys to instances to swap configurations dynamically.
        </p>
      </motion.header>

      {error && (
        <div style={{ marginBottom: "2rem", padding: "1rem", display: "flex", alignItems: "center", gap: 12, border: "1px solid #fca5a5", background: "#fef2f2" }}>
          <AlertTriangle size={16} style={{ color: "#ef4444", flexShrink: 0 }} />
          <span style={{ fontSize: 13, color: "#dc2626", fontWeight: 500 }}>{error}</span>
        </div>
      )}

      {success && (
        <div style={{ marginBottom: "2rem", padding: "1rem", display: "flex", alignItems: "center", gap: 12, border: "1px solid #10b981", background: "#f0fdf4" }}>
          <Save size={16} style={{ color: "#059669", flexShrink: 0 }} />
          <span style={{ fontSize: 13, color: "#059669", fontWeight: 500 }}>{success}</span>
        </div>
      )}

      {loading && keys.length === 0 ? (
        <div style={{ height: 200, display: "flex", alignItems: "center", justifyContent: "center" }}>
          <span className="mono" style={{ opacity: 0.5, fontSize: 12, textTransform: 'uppercase', letterSpacing: '0.2em' }}>Decrypting Vault...</span>
        </div>
      ) : (
        <motion.div 
          initial="hidden" 
          animate="visible" 
          variants={{ hidden: { opacity: 0 }, visible: { opacity: 1, transition: { staggerChildren: 0.1 } } }} 
          style={{ display: 'flex', flexDirection: 'column', gap: '3rem' }}
        >
          
          {/* Key List Section */}
          <motion.section variants={sectionVariants}>
            <div style={{ display: "flex", flexWrap: "wrap", gap: "1rem", justifyContent: "space-between", alignItems: "center", marginBottom: "1.5rem" }}>
              <div style={{ display: "flex", alignItems: "center", gap: "1rem", flex: 1, minWidth: 250 }}>
                <h3 className="mono" style={{ fontSize: 13, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.15em", margin: 0 }}>Global Keys</h3>
                {keys.length > 0 && (
                  <input 
                    type="text" 
                    placeholder="Search keys..." 
                    value={searchTerm}
                    onChange={e => setSearchTerm(e.target.value)}
                    style={{ padding: '8px 12px', fontSize: 12, fontFamily: 'var(--font-mono)', border: '1px solid var(--etched-border)', background: 'var(--bg-surface)', width: '200px' }}
                  />
                )}
              </div>
              <button 
                onClick={() => setIsAddingMode(!isAddingMode)}
                style={{
                  background: 'var(--ink-black)', color: "var(--bg-surface)", border: 'none', padding: '10px 16px', cursor: 'pointer',
                  fontFamily: 'var(--font-mono), monospace', fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.1em',
                  display: 'flex', alignItems: 'center', gap: 8
                }}
              >
                {isAddingMode ? "Cancel" : <><Plus size={14}/> Add New Key</>}
              </button>
            </div>

            {isAddingMode && (
              <form onSubmit={handleSaveKey} aria-busy={savingKey} style={{ background: 'var(--bg-elevated)', border: '1px solid var(--etched-border)', padding: '2rem', marginBottom: '2rem' }}>
                <div style={{ marginBottom: '1.5rem', display: 'flex', gap: '1.5rem', alignItems: 'center', borderBottom: '1px solid var(--etched-border)', paddingBottom: '1rem' }}>
                  <label style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer', fontSize: 12, fontFamily: 'var(--font-mono)', fontWeight: !isOauthMode ? 700 : 400, opacity: !isOauthMode ? 1 : 0.6 }}>
                    <input type="radio" checked={!isOauthMode} onChange={() => { setIsOauthMode(false); setNewProvider("openrouter"); }} style={{ accentColor: 'var(--ink-black)' }} /> Manual API Key
                  </label>
                  <label style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer', fontSize: 12, fontFamily: 'var(--font-mono)', fontWeight: isOauthMode ? 700 : 400, opacity: isOauthMode ? 1 : 0.6 }}>
                    <input type="radio" checked={isOauthMode} onChange={() => { setIsOauthMode(true); setNewProvider("codex"); }} style={{ accentColor: 'var(--ink-black)' }} /> Automated Device Auth
                  </label>
                </div>

                {!isOauthMode ? (
                  <>
                    <div style={{ display: 'flex', gap: '1rem', flexWrap: 'wrap' }}>
                      <div style={{ flex: '1 1 200px' }}>
                         <label className="mono" style={{ display: 'block', fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.15em', fontWeight: 600, opacity: 0.8, marginBottom: 8 }}>Key Name</label>
                         <input required autoFocus value={newName} onChange={e => setNewName(e.target.value)} placeholder={"e.g. My Anthropic Key"} style={{ width: '100%', padding: '10px', fontSize: 13, fontFamily: 'var(--font-mono)', border: '1px solid var(--etched-border)' }} />
                      </div>
                      <div style={{ flex: '1 1 200px' }}>
                         <label className="mono" style={{ display: 'block', fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.15em', fontWeight: 600, opacity: 0.8, marginBottom: 8 }}>Provider</label>
                         <select value={newProvider} onChange={e => setNewProvider(e.target.value)} style={{ width: '100%', padding: '10px', fontSize: 13, fontFamily: 'var(--font-mono)', border: '1px solid var(--etched-border)', background: "var(--bg-surface)" }}>
                             {KEY_PROVIDERS.map(group => (
                               <optgroup key={group.category} label={group.category}>
                                 {group.items.map(p => <option key={p.id} value={p.id}>{p.label}</option>)}
                               </optgroup>
                             ))}
                         </select>
                      </div>
                      <div style={{ flex: '2 1 300px' }}>
                         <label className="mono" style={{ display: 'block', fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.15em', fontWeight: 600, opacity: 0.8, marginBottom: 8 }}>Secret Key</label>
                         <input type="password" required value={newKey} onChange={e => setNewKey(e.target.value)} placeholder="sk-..." style={{ width: '100%', padding: '10px', fontSize: 13, fontFamily: 'var(--font-mono)', border: '1px solid var(--etched-border)' }} />
                      </div>
                    </div>
                    <div style={{ marginTop: '1.5rem', display: 'flex', justifyContent: 'flex-end' }}>
                      <button type="submit" disabled={savingKey} style={{ background: 'var(--ink-black)', color: "var(--bg-surface)", border: 'none', padding: '10px 24px', cursor: 'pointer', fontFamily: 'var(--font-mono)', fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.1em' }}>
                        {savingKey ? 'Saving to Vault...' : 'Save to Vault'}
                      </button>
                    </div>
                  </>
                ) : (
                  <div style={{ padding: '0.5rem 0' }}>
                    <p style={{ margin: '0 0 1.5rem', fontSize: 12, lineHeight: 1.5, opacity: 0.8 }}>
                      Use a running agent to complete the official Hermes OAuth flow in-container. Once it finishes, the dashboard stores an encrypted reusable session in Vault and applies the same session to other agents when you sync them.
                    </p>

                    {agents.length === 0 ? (
                      <div style={{ padding: '16px 20px', background: 'rgba(239,68,68,0.05)', border: '1px solid rgba(239,68,68,0.2)', display: 'flex', flexDirection: 'column', gap: 12 }}>
                        <div style={{ color: 'var(--red)', fontSize: 13, fontWeight: 600, display: 'flex', alignItems: 'center', gap: 8 }}>
                          <AlertTriangle size={16} /> Proxy Instance Offline
                        </div>
                        <p style={{ fontSize: 12, margin: 0, opacity: 0.9 }}>
                          Automated authorization proxies your request through a deployed Hermès agent. You currently have absolutely no active running instances.
                        </p>
                        <div>
                           <Link href="/dashboard/instances" style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--ink-black)', background: 'var(--bg-surface)', border: '1px solid var(--ink-black)', padding: '6px 12px', textDecoration: 'none' }}>
                             Go to Instances to start Server &rarr;
                           </Link>
                        </div>
                      </div>
                    ) : (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
                        <ModalPicker
                          id="codex-host-instance"
                          label="Host Instance To Run Auth Flow"
                          value={codexAgentId}
                          options={hostPickerOptions}
                          onChange={setCodexAgentId}
                          dialogTitle="Choose Host Instance"
                          dialogDescription="Pick the deployed instance that should run the Hermes OAuth device flow."
                          searchPlaceholder="Search instances..."
                          emptyMessage="No matching instances found."
                        />

                        {newProvider === 'codex' && (
                          <>
                            <ModalPicker
                              id="codex-target-profile"
                              label="Target Agent Profile"
                              value={codexProfileName}
                              options={profilePickerOptions}
                              onChange={setCodexProfileName}
                              loading={codexProfilesLoading}
                              disabled={codexProfilesLoading}
                              dialogTitle="Choose Target Agent Profile"
                              dialogDescription="Pick which agent profile should receive the refreshed Codex runtime session after Vault auth completes."
                              searchPlaceholder="Search profiles..."
                              emptyMessage="No matching profiles found."
                            />
                            <p style={{ margin: 0, fontSize: 11, lineHeight: 1.5, opacity: 0.65 }}>
                              Vault auth is saved globally. Choosing a Codex-configured sub-agent here also refreshes that profile&apos;s local runtime session.
                            </p>
                          </>
                        )}
                        
                        {/* Codex Button */}
                        <div style={{ border: '1px solid var(--etched-border)', padding: '1rem', background: newProvider === 'codex' ? 'var(--bg-surface)' : 'transparent', opacity: codexStep !== 'idle' && newProvider !== 'codex' ? 0.4 : 1 }}>
                           <label style={{ display: 'flex', alignItems: 'center', gap: 12, cursor: 'pointer', marginBottom: codexStep !== 'idle' && newProvider === 'codex' ? '1rem' : 0 }}>
                             <input type="radio" checked={newProvider === 'codex'} onChange={() => setNewProvider('codex')} style={{ accentColor: 'var(--ink-black)' }} />
                             <div>
                                <span style={{ fontWeight: 600, fontSize: 14 }}>ChatGPT Plus (Codex)</span>
                                <div style={{ fontSize: 11, opacity: 0.6, marginTop: 2 }}>Uses OpenAI Web Session</div>
                             </div>
                           </label>
                           
                           {newProvider === 'codex' && (
                             <div style={{ paddingTop: '1rem', marginTop: '1rem', borderTop: '1px dashed var(--etched-border)' }}>
                               {codexStep === 'idle' ? (
                                  <button type="button" onClick={handleCodexStart} style={{ width: '100%', padding: '10px', background: 'var(--vellum-bg)', border: '1px solid var(--ink-black)', color: 'var(--ink-black)', fontFamily: 'var(--font-mono)', fontSize: 12, fontWeight: 600, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8 }}>
                                     <Terminal size={14} /> Connect Codex
                                  </button>
                               ) : codexStep === 'starting' ? (
                                  <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px' }}>
                                    <Loader2 size={16} style={{ animation: 'spin 1s linear infinite' }} />
                                    <span style={{ fontSize: 12 }}>Starting official Hermes Codex auth via the active container…</span>
                                  </div>
                               ) : codexStep === 'waiting' ? (
                                  <div style={{ background: 'var(--vellum-bg)', padding: '16px', border: '1px solid var(--ink-black)' }}>
                                    <div style={{ marginBottom: 12 }}>
                                      <p style={{ margin: '0 0 6px', fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Step 1 — Open this URL</p>
                                      <a href={codexUrl} target="_blank" rel="noreferrer" style={{ fontSize: 12, color: 'var(--ink-black)', fontFamily: 'var(--font-mono)' }}>{codexUrl}</a>
                                    </div>
                                    {codexCode && (
                                      <div>
                                        <p style={{ margin: '0 0 6px', fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Step 2 — Enter this code</p>
                                        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                                          <span style={{ fontSize: 18, fontWeight: 700, fontFamily: 'var(--font-mono)' }}>{codexCode}</span>
                                          <button type="button" onClick={handleCodexCopy} style={{ padding: '4px 8px', background: 'transparent', border: '1px solid var(--etched-border)', fontSize: 10, cursor: 'pointer', color: codexCopied ? 'var(--green)' : 'var(--text-secondary)' }}>
                                            <Copy size={10} style={{ display: 'inline', marginRight: 4 }} />{codexCopied ? 'Copied!' : 'Copy'}
                                          </button>
                                        </div>
                                      </div>
                                    )}
                                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 11, marginTop: 12, opacity: 0.7 }}>
                                      <Loader2 size={12} style={{ animation: 'spin 1s linear infinite' }} /> Waiting for browser auth and Vault save...
                                    </div>
                                  </div>
                               ) : codexStep === 'success' ? (
                                  <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px', color: 'var(--green)' }}>
                                    <CheckCircle2 size={18} /> <span style={{ fontSize: 12, fontWeight: 600 }}>Codex session stored in Vault and applied on the selected agent.</span>
                                  </div>
                               ) : (
                                  <div style={{ padding: '12px', color: 'var(--red)', fontSize: 12, border: '1px solid rgba(239,68,68,0.2)' }}>
                                    <div style={{ fontWeight: 600, marginBottom: 4 }}>Error</div>
                                    {codexError}
                                    <button type="button" onClick={() => setCodexStep('idle')} style={{ marginTop: 8, padding: '4px 8px', background: 'transparent', border: '1px solid var(--red)', cursor: 'pointer', fontSize: 10 }}>Retry</button>
                                  </div>
                               )}
                             </div>
                           )}
                        </div>

                        <div style={{ border: '1px solid var(--etched-border)', padding: '1rem', background: newProvider === 'nous' ? 'var(--bg-surface)' : 'transparent' }}>
                           <label style={{ display: 'flex', alignItems: 'center', gap: 12, cursor: 'pointer', marginBottom: newProvider === 'nous' ? '1rem' : 0 }}>
                             <input type="radio" checked={newProvider === 'nous'} onChange={() => setNewProvider('nous')} style={{ accentColor: 'var(--ink-black)' }} />
                             <div>
                                <span style={{ fontWeight: 600, fontSize: 14 }}>Nous Portal</span>
                                <div style={{ fontSize: 11, opacity: 0.6, marginTop: 2 }}>Uses Hermes device auth + reusable Vault session</div>
                             </div>
                           </label>

                           {newProvider === 'nous' && (
                             <div style={{ paddingTop: '1rem', marginTop: '1rem', borderTop: '1px dashed var(--etched-border)' }}>
                               <p style={{ margin: '0 0 12px', fontSize: 12, opacity: 0.8, lineHeight: 1.5 }}>
                                 Start the official Hermes Nous Portal login on the selected agent. When it completes,
                                 Hermes will save a reusable encrypted session into Vault for future Nous deployments.
                               </p>
                               <button
                                 type="button"
                                 onClick={() => setShowNousPortalOAuth(true)}
                                 style={{ width: '100%', padding: '10px', background: 'var(--vellum-bg)', border: '1px solid var(--ink-black)', color: 'var(--ink-black)', fontFamily: 'var(--font-mono)', fontSize: 12, fontWeight: 600, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8 }}
                               >
                                 <Terminal size={14} /> Connect Nous Portal
                               </button>
                             </div>
                           )}
                        </div>

                        {/*
                          xAI Grok (SuperGrok OAuth) — info-only tile.
                          Unlike Codex/Nous, xAI's OAuth client locks redirect_uri to
                          http://127.0.0.1:* so the handshake must happen on the
                          Hermes VM itself (in-WebUI), not via a dashboard-side device
                          flow. The dashboard surfaces the option here so users see
                          it next to the other OAuth providers, but the actual sign-in
                          is finished from the WebUI onboarding wizard inside the
                          deployed instance.
                        */}
                        <div style={{ border: '1px solid var(--etched-border)', padding: '1rem', background: newProvider === 'xai-oauth' ? 'var(--bg-surface)' : 'transparent' }}>
                           <label style={{ display: 'flex', alignItems: 'center', gap: 12, cursor: 'pointer', marginBottom: newProvider === 'xai-oauth' ? '1rem' : 0 }}>
                             <input type="radio" checked={newProvider === 'xai-oauth'} onChange={() => setNewProvider('xai-oauth')} style={{ accentColor: 'var(--ink-black)' }} />
                             <div>
                                <span style={{ fontWeight: 600, fontSize: 14 }}>xAI Grok (SuperGrok OAuth)</span>
                                <div style={{ fontSize: 11, opacity: 0.6, marginTop: 2 }}>Browser PKCE — completed inside your VM's Hermes WebUI</div>
                             </div>
                           </label>

                           {newProvider === 'xai-oauth' && (
                             <div style={{ paddingTop: '1rem', marginTop: '1rem', borderTop: '1px dashed var(--etched-border)' }}>
                               <p style={{ margin: '0 0 12px', fontSize: 12, opacity: 0.8, lineHeight: 1.5 }}>
                                 SuperGrok sign-in happens <strong>inside your VM's Hermes WebUI</strong>, not from the dashboard.
                                 xAI's OAuth client only accepts redirects to <code style={{ fontSize: 11 }}>http://127.0.0.1:*</code> so
                                 the handshake has to run on the VM itself. Open your agent's WebUI, go to <strong>Settings → Providers</strong> or
                                 the onboarding wizard, and click <strong>Sign in with xAI (SuperGrok)</strong>. The session refreshes
                                 automatically after that — no vault entry needed here.
                               </p>
                               <Link
                                 href="/dashboard/instances"
                                 style={{ width: '100%', padding: '10px', background: 'var(--vellum-bg)', border: '1px solid var(--ink-black)', color: 'var(--ink-black)', fontFamily: 'var(--font-mono)', fontSize: 12, fontWeight: 600, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, textDecoration: 'none' }}
                               >
                                 <Terminal size={14} /> Open Instances →
                               </Link>
                             </div>
                           )}
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </form>
            )}

            <AnimatePresence>
              {showNousPortalOAuth && (codexAgentId || agents[0]?.id) ? (
                <NousPortalOAuthModal
                  instanceId={codexAgentId || agents[0].id}
                  autoStart
                  onClose={() => setShowNousPortalOAuth(false)}
                  onSuccess={async () => {
                    await fetchData();
                    const targetAgent = agents.find((agent) => agent.id === (codexAgentId || agents[0]?.id)) || agents[0];
                    setSuccess(`Nous Portal session stored in Vault and authenticated via ${targetAgent?.name || "the selected agent"}.`);
                    scheduleSuccessMessageClear(3000);
                  }}
                />
              ) : null}
            </AnimatePresence>

            <div className="w-full">
              {keys.length === 0 ? (
                <div style={{ border: '1px solid var(--etched-border)', background: "var(--bg-surface)", padding: '3rem', textAlign: 'center', opacity: 0.5, fontSize: 13, fontFamily: 'var(--font-mono), monospace' }}>No keys saved yet.</div>
              ) : (
                (() => {
                  const filteredKeys = keys.filter(k => 
                    k.name.toLowerCase().includes(searchTerm.toLowerCase()) || 
                    getProviderLabel(k.provider).toLowerCase().includes(searchTerm.toLowerCase()) ||
                    k.key_preview.toLowerCase().includes(searchTerm.toLowerCase())
                  );

                  if (filteredKeys.length === 0) {
                    return (
                      <div style={{ border: '1px solid var(--etched-border)', background: "var(--bg-surface)", padding: '3rem', textAlign: 'center', opacity: 0.5, fontSize: 13, fontFamily: 'var(--font-mono), monospace' }}>No keys match your search.</div>
                    );
                  }

                  return (
                    <>
                      {/* Desktop View */}
                      <div className="hidden md:block" style={{ border: '1px solid var(--etched-border)', background: "var(--bg-surface)", width: "100%" }}>
                        <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left', fontSize: 13 }}>
                          <thead>
                            <tr style={{ background: 'var(--bg-elevated)', borderBottom: '1px solid var(--etched-border)', fontFamily: 'var(--font-mono), monospace', fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.1em', opacity: 0.6 }}>
                              <th style={{ padding: '14px 20px', fontWeight: 600 }}>Name</th>
                              <th style={{ padding: '14px 20px', fontWeight: 600 }}>Provider</th>
                              <th style={{ padding: '14px 20px', fontWeight: 600 }}>Preview</th>
                              <th style={{ padding: '14px 20px', fontWeight: 600, textAlign: 'right' }}>Actions</th>
                            </tr>
                          </thead>
                          <tbody>
                            {filteredKeys.map(k => (
                              <tr key={k.id} style={{ borderBottom: '1px solid var(--etched-border)' }}>
                                <td style={{ padding: '14px 20px', fontWeight: 500, fontFamily: 'var(--font-mono), monospace' }}>{k.name}</td>
                                <td style={{ padding: '14px 20px' }}><span style={{ border: '1px solid var(--etched-border)', background: 'var(--bg-elevated)', padding: '4px 8px', borderRadius: 0, fontSize: 11, fontFamily: 'var(--font-mono), monospace' }}>{getProviderLabel(k.provider)}</span></td>
                                <td style={{ padding: '14px 20px', fontFamily: 'var(--font-mono), monospace', opacity: 0.6, letterSpacing: '0.1em' }}><Key size={12} style={{ display: 'inline', marginRight: 6, opacity: 0.5 }}/> {k.key_preview}</td>
                                <td style={{ padding: '14px 20px', textAlign: 'right' }}>
                                  <button onClick={() => handleDeleteKey(k.id, k.name)} disabled={deletingKey === k.id} style={{ background: 'transparent', color: '#dc2626', border: 'none', cursor: deletingKey === k.id ? 'wait' : 'pointer' }}>
                                    {deletingKey === k.id ? <Loader2 size={16} className="animate-spin" /> : <Trash2 size={16} />}
                                  </button>
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>

                      {/* Mobile View */}
                      <div className="md:hidden flex flex-col gap-4 w-full">
                        {filteredKeys.map(k => (
                          <div key={k.id} style={{ border: '1px solid var(--etched-border)', background: 'var(--bg-surface)', padding: '1.25rem' }}>
                            <div className="flex justify-between items-start mb-4">
                              <span className="font-mono font-bold" style={{ fontSize: 14 }}>{k.name}</span>
                              <button onClick={() => handleDeleteKey(k.id, k.name)} disabled={deletingKey === k.id} style={{ background: 'transparent', color: '#dc2626', border: 'none', cursor: deletingKey === k.id ? 'wait' : 'pointer', padding: '4px' }}>
                                {deletingKey === k.id ? <Loader2 size={16} className="animate-spin" /> : <Trash2 size={16} />}
                              </button>
                            </div>
                            <div className="flex flex-col gap-3">
                              <div className="flex justify-between items-center border-b pb-2" style={{ borderColor: 'var(--etched-border)' }}>
                                <span className="mono" style={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.15em', opacity: 0.6 }}>Provider</span>
                                <span style={{ border: '1px solid var(--etched-border)', background: 'var(--bg-elevated)', padding: '4px 8px', fontSize: 11, fontFamily: 'var(--font-mono), monospace' }}>{getProviderLabel(k.provider)}</span>
                              </div>
                              <div className="flex justify-between items-center pt-1">
                                <span className="mono" style={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.15em', opacity: 0.6 }}>Preview</span>
                                <span style={{ fontFamily: 'var(--font-mono), monospace', opacity: 0.6, letterSpacing: '0.1em', fontSize: 12, display: 'flex', gap: 6, alignItems: 'center' }}><Key size={12} style={{ opacity: 0.5 }}/>{k.key_preview}</span>
                              </div>
                            </div>
                          </div>
                        ))}
                      </div>
                    </>
                  );
                })()
              )}
            </div>
          </motion.section>

          {/* Active Agents Assignment Section */}
          <motion.section variants={sectionVariants} style={{ marginTop: "2rem" }}>
            <div style={{ display: "flex", flexWrap: "wrap", gap: "1rem", justifyContent: "space-between", alignItems: "center", marginBottom: "1.5rem" }}>
              <h3 className="mono" style={{ fontSize: 13, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.15em", margin: 0 }}>
                 {agents.length === 1 ? "Bind Keys to Core Instance" : "Bind Keys to Active Instances"}
              </h3>
            </div>
            
            <div className="w-full">
              {agents.length === 0 ? (
                <div style={{ border: '1px solid var(--etched-border)', background: "var(--bg-surface)", padding: '3rem', textAlign: 'center', opacity: 0.5, fontSize: 13, fontFamily: 'var(--font-mono), monospace' }}>No active running instances found.</div>
              ) : (
                <>
                  {/* Desktop View */}
                  <div className="hidden md:block" style={{ border: '1px solid var(--etched-border)', background: "var(--bg-surface)", width: "100%" }}>
                    <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left', fontSize: 13 }}>
                      <thead>
                        <tr style={{ background: 'var(--bg-elevated)', borderBottom: '1px solid var(--etched-border)', fontFamily: 'var(--font-mono), monospace', fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.1em', opacity: 0.6 }}>
                          <th style={{ padding: '14px 20px', fontWeight: 600 }}>{agents.length === 1 ? "Instance Designation" : "Instance Designation"}</th>
                          <th style={{ padding: '14px 20px', fontWeight: 600 }}>Provider Key</th>
                          <th style={{ padding: '14px 20px', fontWeight: 600 }}>Memory Key (Honcho)</th>
                          <th style={{ padding: '14px 20px', fontWeight: 600 }}>Model</th>
                          <th style={{ padding: '14px 20px', fontWeight: 600, textAlign: 'right' }}>Action</th>
                        </tr>
                      </thead>
                      <tbody>
                        {agents.map(agent => {
                          const hasChanges = changedAgents.has(agent.id);
                          return (
                          <tr key={agent.id} style={{ borderBottom: '1px solid var(--etched-border)', background: hasChanges ? 'rgba(255, 44, 45,0.04)' : 'transparent', transition: 'background 0.2s' }}>
                            <td style={{ padding: '14px 20px', fontWeight: 500, fontFamily: 'var(--font-mono), monospace' }}>{agent.name}</td>
                            <td style={{ padding: '14px 20px', minWidth: 160 }}>
                              <select 
                                value={agentAssignments[agent.id]?.vaultKeyId || ""}
                                onChange={(e) => {
                                  setAgentAssignments(prev => ({ ...prev, [agent.id]: { ...prev[agent.id], vaultKeyId: e.target.value } }));
                                  setChangedAgents(prev => new Set(prev).add(agent.id));
                                }}
                                style={{ background: 'transparent', border: '1px solid var(--etched-border)', padding: '6px 10px', fontSize: 12, fontFamily: 'var(--font-mono)', width: '100%', minWidth: 140 }}>
                                <option value="">Leave current</option>
                                {keys.filter(k => k.provider === agent.provider || (isCodexAuthProvider(agent.provider) && isCodexAuthProvider(k.provider))).map(k => (
                                  <option key={k.id} value={k.id}>
                                    {k.provider === agent.provider ? k.name : `${k.name} (${getProviderLabel(k.provider)})`}
                                  </option>
                                ))}
                              </select>
                            </td>
                            <td style={{ padding: '14px 20px', minWidth: 160 }}>
                              <select 
                                value={agentAssignments[agent.id]?.honchoVaultKeyId || ""}
                                onChange={(e) => {
                                  setAgentAssignments(prev => ({ ...prev, [agent.id]: { ...prev[agent.id], honchoVaultKeyId: e.target.value } }));
                                  setChangedAgents(prev => new Set(prev).add(agent.id));
                                }}
                                style={{ background: 'transparent', border: '1px solid var(--etched-border)', padding: '6px 10px', fontSize: 12, fontFamily: 'var(--font-mono)', width: '100%', minWidth: 140 }}>
                                <option value="">Leave current</option>
                                {keys.filter(k => k.provider === "honcho").map(k => (
                                  <option key={k.id} value={k.id}>{k.name}</option>
                                ))}
                              </select>
                            </td>
                            <td style={{ padding: '14px 20px', minWidth: 160 }}>
                              <select 
                                value={agentAssignments[agent.id]?.model || ""}
                                onChange={(e) => {
                                  setAgentAssignments(prev => ({ ...prev, [agent.id]: { ...prev[agent.id], model: e.target.value } }));
                                  setChangedAgents(prev => new Set(prev).add(agent.id));
                                }}
                                style={{ background: 'transparent', border: '1px solid var(--etched-border)', padding: '6px 10px', fontSize: 12, fontFamily: 'var(--font-mono)', width: '100%', minWidth: 140 }}>
                                <option value="">Leave current: {agent.config?.model || "Default"}</option>
                                {MODEL_PROVIDERS.find(p => p.id === agent.provider)?.models.map(m => (
                                  <option key={m.value} value={m.value}>{m.label}</option>
                                ))}
                              </select>
                            </td>
                            <td style={{ padding: '14px 20px', textAlign: 'right' }}>
                              <button 
                                type="button"
                                disabled={syncingAgent === agent.id || (!agentAssignments[agent.id]?.vaultKeyId && !agentAssignments[agent.id]?.honchoVaultKeyId && !agentAssignments[agent.id]?.model)}
                                onClick={() => {
                                  syncAgentKey(agent);
                                  setChangedAgents(prev => {
                                    const next = new Set(prev);
                                    next.delete(agent.id);
                                    return next;
                                  });
                                }}
                                style={{ 
                                  display: 'inline-flex', alignItems: 'center', gap: 6, 
                                  background: hasChanges ? 'var(--gold-leaf)' : 'var(--ink-black)', 
                                  color: hasChanges ? 'var(--ink-black)' : 'var(--bg-surface)', 
                                  border: hasChanges ? '1px solid var(--gold-leaf)' : 'none', 
                                  padding: '8px 14px', 
                                  cursor: (syncingAgent === agent.id || (!agentAssignments[agent.id]?.vaultKeyId && !agentAssignments[agent.id]?.honchoVaultKeyId && !agentAssignments[agent.id]?.model)) ? 'not-allowed' : 'pointer', 
                                  fontFamily: 'var(--font-mono)', fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.1em', 
                                  opacity: (!agentAssignments[agent.id]?.vaultKeyId && !agentAssignments[agent.id]?.honchoVaultKeyId && !agentAssignments[agent.id]?.model) ? 0.3 : 1,
                                  animation: hasChanges ? 'subtlePulse 2s ease-in-out infinite' : 'none',
                                  transition: 'background 0.2s, color 0.2s',
                                }}
                              >
                                {syncingAgent === agent.id ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />}
                                {hasChanges ? 'Apply Changes' : 'Sync'}
                              </button>
                            </td>
                          </tr>
                        );
                        })}
                      </tbody>
                    </table>
                    {/* Helper caption — explains the two-step select→sync flow */}
                    <p className="mono" style={{ padding: '10px 20px', fontSize: 9, textTransform: 'uppercase', letterSpacing: '0.12em', opacity: 0.4, borderTop: '1px solid var(--etched-border)', margin: 0 }}>
                      Select values above, then click Apply Changes / Sync to commit
                    </p>
                  </div>

                  {/* Mobile View */}
                  <div className="md:hidden flex flex-col gap-6 w-full">
                    {agents.map(agent => (
                      <div key={agent.id} style={{ border: '1px solid var(--etched-border)', background: 'var(--bg-surface)', padding: '1.25rem' }}>
                        <div className="font-mono font-bold mb-4" style={{ fontSize: 15, borderBottom: '1px solid var(--etched-border)', paddingBottom: '10px' }}>
                          {agent.name}
                        </div>
                        
                        <div className="flex flex-col gap-4">
                          {/* Provider Key */}
                          <div className="flex flex-col gap-2">
                            <span className="mono" style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: "0.15em", opacity: 0.8 }}>Provider Key</span>
                            <select 
                              value={agentAssignments[agent.id]?.vaultKeyId || ""}
                              onChange={(e) => setAgentAssignments(prev => ({ ...prev, [agent.id]: { ...prev[agent.id], vaultKeyId: e.target.value } }))}
                              style={{ background: 'transparent', border: '1px solid var(--etched-border)', padding: '10px', fontSize: 13, fontFamily: 'var(--font-mono)', width: '100%' }}>
                              <option value="">Leave current</option>
                              {keys.filter(k => k.provider === agent.provider || (isCodexAuthProvider(agent.provider) && isCodexAuthProvider(k.provider))).map(k => (
                                <option key={k.id} value={k.id}>
                                  {k.provider === agent.provider ? k.name : `${k.name} (${getProviderLabel(k.provider)})`}
                                </option>
                              ))}
                            </select>
                          </div>

                          {/* Memory Key */}
                          <div className="flex flex-col gap-2">
                            <span className="mono" style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: "0.15em", opacity: 0.8 }}>Memory Key (Honcho)</span>
                            <select 
                              value={agentAssignments[agent.id]?.honchoVaultKeyId || ""}
                              onChange={(e) => setAgentAssignments(prev => ({ ...prev, [agent.id]: { ...prev[agent.id], honchoVaultKeyId: e.target.value } }))}
                              style={{ background: 'transparent', border: '1px solid var(--etched-border)', padding: '10px', fontSize: 13, fontFamily: 'var(--font-mono)', width: '100%' }}>
                              <option value="">Leave current</option>
                              {keys.filter(k => k.provider === "honcho").map(k => (
                                <option key={k.id} value={k.id}>{k.name}</option>
                              ))}
                            </select>
                          </div>

                          {/* Model */}
                          <div className="flex flex-col gap-2">
                            <span className="mono" style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: "0.15em", opacity: 0.8 }}>Model Selection</span>
                            <select 
                              value={agentAssignments[agent.id]?.model || ""}
                              onChange={(e) => setAgentAssignments(prev => ({ ...prev, [agent.id]: { ...prev[agent.id], model: e.target.value } }))}
                              style={{ background: 'transparent', border: '1px solid var(--etched-border)', padding: '10px', fontSize: 13, fontFamily: 'var(--font-mono)', width: '100%' }}>
                              <option value="">Leave current: {agent.config?.model || "Default"}</option>
                              {MODEL_PROVIDERS.find(p => p.id === agent.provider)?.models.map(m => (
                                <option key={m.value} value={m.value}>{m.label}</option>
                              ))}
                            </select>
                          </div>
                        </div>

                        <div className="mt-5">
                          <button 
                            disabled={syncingAgent === agent.id || (!agentAssignments[agent.id]?.vaultKeyId && !agentAssignments[agent.id]?.honchoVaultKeyId && !agentAssignments[agent.id]?.model)}
                            onClick={() => syncAgentKey(agent)}
                            style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', width: '100%', gap: 8, background: 'var(--ink-black)', color: "var(--bg-surface)", border: 'none', padding: '12px', cursor: (syncingAgent === agent.id || (!agentAssignments[agent.id]?.vaultKeyId && !agentAssignments[agent.id]?.honchoVaultKeyId && !agentAssignments[agent.id]?.model)) ? 'not-allowed' : 'pointer', fontFamily: 'var(--font-mono)', fontSize: 12, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.1em', opacity: (!agentAssignments[agent.id]?.vaultKeyId && !agentAssignments[agent.id]?.honchoVaultKeyId && !agentAssignments[agent.id]?.model) ? 0.3 : 1 }}
                          >
                            {syncingAgent === agent.id ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
                            Sync Instance
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                </>
              )}
            </div>
          </motion.section>

        </motion.div>
      )}
    </motion.div>
  );
}
