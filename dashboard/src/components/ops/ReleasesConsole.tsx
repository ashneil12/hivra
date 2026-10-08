'use client';

import { useCallback, useEffect, useMemo, useState, type CSSProperties, type FormEvent } from 'react';
import { readErrorMessage } from '@/lib/http/error-parsing';

type ReleaseStage = 'registered' | 'canary' | 'pilot' | 'ten_percent' | 'full';

interface ReleaseRow {
  id: string;
  image_repo: string;
  version: string;
  digest: string;
  stage: ReleaseStage;
  halted: boolean;
  halted_reason: string | null;
  halted_by: string | null;
  notes: string | null;
  created_at: string;
  boxes: number;
  health: { succeededBoxes: number; failedBoxes: number };
}

interface AttentionRow {
  instanceId: string;
  name: string | null;
  updateHealth: string;
  detail: string | null;
  at: string | null;
  version: string | null;
}

interface BoxRow {
  id: string;
  name: string | null;
  channel: 'stable' | 'canary';
  version: string | null;
}

interface ReleasesData {
  releases: ReleaseRow[];
  attention: AttentionRow[];
  boxes: BoxRow[];
  fleet: { total: number; reporting: number; onNewUpdateStack: number };
}

/** The ladder in the order a release climbs it, with the label shown for each rung. */
const LADDER: Array<{ stage: ReleaseStage; label: string }> = [
  { stage: 'registered', label: 'Registered' },
  { stage: 'canary', label: 'Early access' },
  { stage: 'pilot', label: '1 box' },
  { stage: 'ten_percent', label: '10%' },
  { stage: 'full', label: '100%' },
];

const MIN_HALT_REASON = 3;

const card: CSSProperties = {
  border: '1px solid var(--etched-border)',
  background: 'var(--bg-surface)',
  padding: '1.25rem 1.2rem',
  boxShadow: '0 6px 18px rgba(0,0,0,0.04)',
};

const sectionLabel: CSSProperties = {
  fontSize: 10,
  textTransform: 'uppercase',
  letterSpacing: '0.14em',
  color: 'var(--text-muted)',
  margin: 0,
};

const control: CSSProperties = {
  minHeight: 44,
  padding: '0 12px',
  border: '1px solid var(--etched-border)',
  background: 'var(--bg-surface)',
  color: 'var(--ink-black)',
  fontSize: 14,
  width: '100%',
  boxSizing: 'border-box',
};

const buttonStyle = (disabled: boolean): CSSProperties => ({
  minHeight: 44,
  padding: '10px 20px',
  fontSize: 10,
  letterSpacing: '0.1em',
  opacity: disabled ? 0.55 : 1,
  cursor: disabled ? 'not-allowed' : 'pointer',
});

const errorStyle: CSSProperties = { margin: 0, fontSize: 12, color: '#b91c1c', overflowWrap: 'anywhere' };

function stageLabel(stage: ReleaseStage): string {
  return LADDER.find((rung) => rung.stage === stage)?.label ?? stage;
}

function nextRung(stage: ReleaseStage): ReleaseStage | null {
  const index = LADDER.findIndex((rung) => rung.stage === stage);
  return index >= 0 && index < LADDER.length - 1 ? LADDER[index + 1].stage : null;
}

function shortDigest(digest: string): string {
  return digest.replace(/^sha256:/, '').slice(0, 12);
}

function shortId(id: string): string {
  return id.slice(0, 8);
}

function timeAgo(iso: string | null): string {
  if (!iso) return 'time unknown';
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return 'time unknown';
  const seconds = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (seconds < 60) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} h ago`;
  return `${Math.round(hours / 24)} days ago`;
}

function boxLabel(box: BoxRow): string {
  return `${box.name || 'Unnamed box'} (${shortId(box.id)}), ${box.version ?? 'version unknown'}`;
}

/** Sends a JSON POST and returns the parsed body, or throws with the server's error text. */
async function postJson(url: string, body: unknown): Promise<Record<string, unknown>> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(await readErrorMessage(response));
  const json = (await response.json().catch(() => null)) as { data?: Record<string, unknown> } | null;
  return json?.data ?? {};
}

function StageLadder({ stage, halted }: { stage: ReleaseStage; halted: boolean }) {
  const current = LADDER.findIndex((rung) => rung.stage === stage);
  return (
    <ol
      aria-label="Rollout stage"
      style={{
        listStyle: 'none',
        margin: 0,
        padding: 0,
        display: 'grid',
        gridTemplateColumns: 'repeat(5, minmax(0, 1fr))',
        gap: 4,
      }}
    >
      {LADDER.map((rung, index) => {
        const isCurrent = index === current;
        const passed = index < current;
        return (
          <li
            key={rung.stage}
            aria-current={isCurrent ? 'step' : undefined}
            className="mono"
            style={{
              fontSize: 10,
              textAlign: 'center',
              padding: '8px 2px',
              border: '1px solid var(--etched-border)',
              fontWeight: isCurrent ? 700 : 400,
              background: isCurrent ? (halted ? '#b91c1c' : 'var(--ink-black)') : 'transparent',
              color: isCurrent ? 'var(--vellum-bg)' : passed ? 'var(--ink-black)' : 'var(--text-muted)',
              overflowWrap: 'anywhere',
            }}
          >
            {rung.label}
          </li>
        );
      })}
    </ol>
  );
}

function ReleaseCard({
  release,
  boxes,
  busy,
  error,
  onRun,
}: {
  release: ReleaseRow;
  boxes: BoxRow[];
  busy: string | null;
  error: string | undefined;
  onRun: (key: string, releaseId: string, body: Record<string, unknown>) => Promise<boolean>;
}) {
  const [confirming, setConfirming] = useState<'promote' | 'halt' | null>(null);
  const [pilotId, setPilotId] = useState('');
  const [reason, setReason] = useState('');

  const next = nextRung(release.stage);
  const needsPilot = next === 'pilot';
  const anyBusy = busy !== null;
  const promoteBlocked = release.halted
    ? 'Halted. Unhalt it before promoting.'
    : next === null
      ? 'Already at 100%.'
      : null;
  const promoteReady = !promoteBlocked && (!needsPilot || pilotId !== '');
  const haltReady = reason.trim().length >= MIN_HALT_REASON;
  const myBusy = busy?.startsWith(`${release.id}:`) ?? false;

  async function promote() {
    const body: Record<string, unknown> = { action: 'promote' };
    if (needsPilot) body.pilotInstanceId = pilotId;
    if (await onRun(`${release.id}:promote`, release.id, body)) {
      setConfirming(null);
      setPilotId('');
    }
  }

  async function halt() {
    if (await onRun(`${release.id}:halt`, release.id, { action: 'halt', reason: reason.trim() })) {
      setConfirming(null);
      setReason('');
    }
  }

  return (
    <article aria-label={`Release ${release.version}`} style={{ ...card, display: 'grid', gap: 14 }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'baseline', justifyContent: 'space-between' }}>
        <div style={{ minWidth: 0 }}>
          <p className="serif" style={{ margin: 0, fontSize: 22, color: 'var(--ink-black)', overflowWrap: 'anywhere' }}>
            {release.version}
          </p>
          <p className="mono" style={{ margin: '4px 0 0', fontSize: 11, color: 'var(--text-muted)', overflowWrap: 'anywhere' }}>
            {shortDigest(release.digest)} · {release.image_repo}
          </p>
        </div>
        <p className="mono" style={{ margin: 0, fontSize: 11, color: 'var(--text-muted)' }}>
          Registered {timeAgo(release.created_at)}
        </p>
      </div>

      <StageLadder stage={release.stage} halted={release.halted} />

      {release.halted && (
        <div
          role="status"
          style={{ border: '1px solid rgba(185,28,28,0.45)', background: 'rgba(185,28,28,0.08)', padding: '0.6rem 0.8rem', fontSize: 13, color: '#991b1b', overflowWrap: 'anywhere' }}
        >
          <strong className="mono" style={{ fontSize: 11, letterSpacing: '0.1em' }}>HALTED</strong>
          {release.halted_by === 'auto' && <span> (automatic)</span>}
          {release.halted_reason ? `: ${release.halted_reason}` : ''}
        </div>
      )}

      <p style={{ margin: 0, fontSize: 13, color: 'var(--text-secondary)' }}>
        {release.boxes === 1 ? '1 box runs' : `${release.boxes} boxes run`} this release. Update outcomes: {release.health.succeededBoxes} succeeded, {release.health.failedBoxes} failed.
      </p>
      {release.notes && <p style={{ margin: 0, fontSize: 13, color: 'var(--text-secondary)', overflowWrap: 'anywhere' }}>{release.notes}</p>}

      <div style={{ display: 'grid', gap: 10 }}>
        {needsPilot && !promoteBlocked && (
          <label style={{ display: 'grid', gap: 4, fontSize: 12, color: 'var(--text-secondary)' }}>
            Pilot box
            <select
              value={pilotId}
              onChange={(event) => {
                setPilotId(event.target.value);
                setConfirming(null);
              }}
              disabled={anyBusy}
              style={control}
            >
              <option value="">Choose the computer to try it on</option>
              {boxes.map((box) => (
                <option key={box.id} value={box.id}>
                  {boxLabel(box)}
                </option>
              ))}
            </select>
          </label>
        )}

        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
          {confirming === 'promote' ? (
            <>
              <button
                type="button"
                className="action-button"
                style={buttonStyle(anyBusy)}
                disabled={anyBusy}
                onClick={promote}
              >
                {myBusy ? 'Promoting…' : `Confirm: promote ${release.version} to ${stageLabel(next as ReleaseStage)}`}
              </button>
              <button type="button" className="action-button" style={buttonStyle(anyBusy)} disabled={anyBusy} onClick={() => setConfirming(null)}>
                Cancel
              </button>
            </>
          ) : (
            <button
              type="button"
              className="action-button"
              style={buttonStyle(!promoteReady || anyBusy)}
              disabled={!promoteReady || anyBusy}
              onClick={() => {
                setConfirming('promote');
              }}
            >
              {next ? `Promote to ${stageLabel(next)}` : 'Promote'}
            </button>
          )}

          {release.halted ? (
            <button
              type="button"
              className="action-button"
              style={buttonStyle(anyBusy)}
              disabled={anyBusy}
              onClick={() => onRun(`${release.id}:unhalt`, release.id, { action: 'unhalt' })}
            >
              {myBusy ? 'Working…' : 'Unhalt'}
            </button>
          ) : (
            confirming !== 'halt' && (
              <button
                type="button"
                className="action-button"
                style={buttonStyle(anyBusy)}
                disabled={anyBusy}
                onClick={() => setConfirming('halt')}
              >
                Halt
              </button>
            )
          )}
        </div>

        {promoteBlocked && <p style={{ margin: 0, fontSize: 12, color: 'var(--text-muted)' }}>{promoteBlocked}</p>}
        {!promoteBlocked && needsPilot && pilotId === '' && (
          <p style={{ margin: 0, fontSize: 12, color: 'var(--text-muted)' }}>Choose a pilot box to enable promotion.</p>
        )}

        {confirming === 'halt' && !release.halted && (
          <div style={{ display: 'grid', gap: 8 }}>
            <label style={{ display: 'grid', gap: 4, fontSize: 12, color: 'var(--text-secondary)' }}>
              Why halt this release?
              <input
                type="text"
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                maxLength={500}
                disabled={anyBusy}
                style={control}
              />
            </label>
            <p style={{ margin: 0, fontSize: 12, color: 'var(--text-muted)' }}>
              Boxes running it move back to the newest release that is not halted.
            </p>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
              <button
                type="button"
                className="action-button"
                style={buttonStyle(!haltReady || anyBusy)}
                disabled={!haltReady || anyBusy}
                onClick={halt}
              >
                {myBusy ? 'Halting…' : 'Confirm halt'}
              </button>
              <button type="button" className="action-button" style={buttonStyle(anyBusy)} disabled={anyBusy} onClick={() => setConfirming(null)}>
                Cancel
              </button>
            </div>
          </div>
        )}

        {error && <p role="alert" style={errorStyle}>{error}</p>}
      </div>
    </article>
  );
}

export function ReleasesConsole() {
  const [data, setData] = useState<ReleasesData | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});

  const [repoInput, setRepoInput] = useState<string | null>(null);
  const [tag, setTag] = useState('');
  const [notes, setNotes] = useState('');
  const [registerMessage, setRegisterMessage] = useState<string | null>(null);
  const [registerError, setRegisterError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const response = await fetch('/api/ops/hermes-releases', { cache: 'no-store' });
      if (!response.ok) throw new Error(await readErrorMessage(response));
      const json = (await response.json()) as { data?: ReleasesData };
      if (!json.data) throw new Error('The releases response was empty.');
      setData(json.data);
      setLoadError(null);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : 'Could not load releases.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const releases = useMemo(
    () => [...(data?.releases ?? [])].sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at)),
    [data]
  );
  const newestRepo = releases[0]?.image_repo ?? '';
  const repo = repoInput ?? newestRepo;

  /** Runs one action on a release; refetches on success, records the error against the release on failure. */
  const runReleaseAction = useCallback(
    async (key: string, releaseId: string, body: Record<string, unknown>): Promise<boolean> => {
      setBusy(key);
      setErrors((prev) => ({ ...prev, [releaseId]: '' }));
      try {
        await postJson(`/api/ops/hermes-releases/${releaseId}`, body);
        await load();
        return true;
      } catch (err) {
        setErrors((prev) => ({ ...prev, [releaseId]: err instanceof Error ? err.message : 'The request failed.' }));
        return false;
      } finally {
        setBusy(null);
      }
    },
    [load]
  );

  async function toggleChannel(box: BoxRow) {
    const channel = box.channel === 'canary' ? 'stable' : 'canary';
    setBusy(`box:${box.id}`);
    setErrors((prev) => ({ ...prev, [box.id]: '' }));
    try {
      await postJson(`/api/ops/hermes-releases/boxes/${box.id}`, { channel });
      await load();
    } catch (err) {
      setErrors((prev) => ({ ...prev, [box.id]: err instanceof Error ? err.message : 'The request failed.' }));
    } finally {
      setBusy(null);
    }
  }

  async function register(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy('register');
    setRegisterError(null);
    setRegisterMessage(null);
    try {
      const body: Record<string, string> = { imageRepo: repo.trim(), tag: tag.trim() };
      if (notes.trim()) body.notes = notes.trim();
      const result = await postJson('/api/ops/hermes-releases', body);
      const release = result.release as { version?: string; stage?: ReleaseStage } | undefined;
      const version = release?.version ?? tag.trim();
      setRegisterMessage(
        result.created === false
          ? `${version} was already registered. Its stage is ${stageLabel(release?.stage ?? 'registered')}.`
          : `Registered ${version}. Stage: Registered, not yet offered to any box.`
      );
      setTag('');
      setNotes('');
      await load();
    } catch (err) {
      setRegisterError(err instanceof Error ? err.message : 'The request failed.');
    } finally {
      setBusy(null);
    }
  }

  const anyBusy = busy !== null;
  const registerReady = repo.trim().length >= 3 && tag.trim().length > 0;

  return (
    <div style={{ display: 'grid', gap: '2rem' }}>
      {loading && <p style={{ color: 'var(--text-secondary)' }}>Loading releases…</p>}
      {loadError && (
        <div role="alert" style={{ ...card, display: 'grid', gap: 10 }}>
          <p style={{ ...errorStyle, fontSize: 14 }}>Could not load releases: {loadError}</p>
          <div>
            <button type="button" className="action-button" style={buttonStyle(false)} onClick={() => void load()}>
              Try again
            </button>
          </div>
        </div>
      )}

      {data && (
        <>
          <section aria-label="Fleet summary" style={{ ...card, display: 'grid', gap: 6 }}>
            <p className="mono" style={sectionLabel}>Fleet</p>
            <p style={{ margin: 0, color: 'var(--ink-black)', fontSize: 15 }}>
              {data.fleet.reporting} of {data.fleet.total} boxes report which version they run.
            </p>
            <p style={{ margin: 0, color: 'var(--ink-black)', fontSize: 15 }}>
              {data.fleet.onNewUpdateStack} of {data.fleet.total} boxes are on the new update stack, the one that reports update health.
            </p>
          </section>

          <section aria-label="Register a release" style={{ display: 'grid', gap: 12 }}>
            <h2 className="serif" style={{ margin: 0, fontSize: 24, fontWeight: 400, color: 'var(--ink-black)' }}>
              Register a release
            </h2>
            <form onSubmit={register} style={{ ...card, display: 'grid', gap: 12 }}>
              <label style={{ display: 'grid', gap: 4, fontSize: 12, color: 'var(--text-secondary)' }}>
                Image repo
                <input
                  type="text"
                  value={repo}
                  onChange={(event) => setRepoInput(event.target.value)}
                  placeholder="ghcr.io/owner/name"
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                  style={control}
                />
              </label>
              <label style={{ display: 'grid', gap: 4, fontSize: 12, color: 'var(--text-secondary)' }}>
                Tag
                <input
                  type="text"
                  value={tag}
                  onChange={(event) => setTag(event.target.value)}
                  placeholder="2026.10.07.1"
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                  style={control}
                />
              </label>
              <label style={{ display: 'grid', gap: 4, fontSize: 12, color: 'var(--text-secondary)' }}>
                Notes (optional)
                <input type="text" value={notes} onChange={(event) => setNotes(event.target.value)} maxLength={500} style={control} />
              </label>
              <p style={{ margin: 0, fontSize: 12, color: 'var(--text-muted)' }}>
                The tag is resolved to its digest once. A new release is registered but not offered to any box until you promote it.
              </p>
              <div>
                <button
                  type="submit"
                  className="action-button"
                  style={buttonStyle(!registerReady || anyBusy)}
                  disabled={!registerReady || anyBusy}
                >
                  {busy === 'register' ? 'Registering…' : 'Register release'}
                </button>
              </div>
              {registerMessage && <p role="status" style={{ margin: 0, fontSize: 13, color: 'var(--ink-black)' }}>{registerMessage}</p>}
              {registerError && <p role="alert" style={errorStyle}>{registerError}</p>}
            </form>
          </section>

          <section aria-label="Releases" style={{ display: 'grid', gap: 12 }}>
            <h2 className="serif" style={{ margin: 0, fontSize: 24, fontWeight: 400, color: 'var(--ink-black)' }}>
              Releases
            </h2>
            {releases.length === 0 ? (
              <p style={{ ...card, margin: 0, color: 'var(--text-secondary)' }}>
                No releases yet. Register one above to start a rollout.
              </p>
            ) : (
              releases.map((release) => (
                <ReleaseCard
                  key={release.id}
                  release={release}
                  boxes={data.boxes}
                  busy={busy}
                  error={errors[release.id] || undefined}
                  onRun={runReleaseAction}
                />
              ))
            )}
          </section>

          <section aria-label="Boxes needing attention" style={{ display: 'grid', gap: 12 }}>
            <h2 className="serif" style={{ margin: 0, fontSize: 24, fontWeight: 400, color: 'var(--ink-black)' }}>
              Boxes needing attention
            </h2>
            {data.attention.length === 0 ? (
              <p style={{ ...card, margin: 0, color: 'var(--text-secondary)' }}>No box has a paused or failed update stack.</p>
            ) : (
              <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 10 }}>
                {data.attention.map((row) => (
                  <li key={row.instanceId} style={{ ...card, display: 'grid', gap: 6 }}>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
                      <strong style={{ color: 'var(--ink-black)', overflowWrap: 'anywhere' }}>
                        {row.name || 'Unnamed box'} ({shortId(row.instanceId)})
                      </strong>
                      <span
                        className="mono"
                        style={{ fontSize: 10, letterSpacing: '0.1em', textTransform: 'uppercase', border: '1px solid rgba(185,28,28,0.45)', background: 'rgba(185,28,28,0.08)', color: '#991b1b', padding: '2px 8px' }}
                      >
                        {row.updateHealth.replace(/_/g, ' ')}
                      </span>
                    </div>
                    {row.detail && <p style={{ margin: 0, fontSize: 13, color: 'var(--text-secondary)', overflowWrap: 'anywhere' }}>{row.detail}</p>}
                    <p className="mono" style={{ margin: 0, fontSize: 11, color: 'var(--text-muted)' }}>
                      {timeAgo(row.at)} · {row.version ?? 'version unknown'}
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section aria-label="Early access channel" style={{ display: 'grid', gap: 12 }}>
            <h2 className="serif" style={{ margin: 0, fontSize: 24, fontWeight: 400, color: 'var(--ink-black)' }}>
              Early access channel
            </h2>
            <p style={{ margin: 0, color: 'var(--text-secondary)', fontSize: 14 }}>
              Computers on the early access channel receive each release at the early access stage, before it is offered to anyone else.
            </p>
            {data.boxes.length === 0 ? (
              <p style={{ ...card, margin: 0, color: 'var(--text-secondary)' }}>No running boxes.</p>
            ) : (
              <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 10 }}>
                {data.boxes.map((box) => (
                  <li key={box.id} style={{ ...card, display: 'grid', gap: 8 }}>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'center', justifyContent: 'space-between' }}>
                      <div style={{ minWidth: 0 }}>
                        <strong style={{ color: 'var(--ink-black)', overflowWrap: 'anywhere' }}>
                          {box.name || 'Unnamed box'} ({shortId(box.id)})
                        </strong>
                        <p className="mono" style={{ margin: '2px 0 0', fontSize: 11, color: 'var(--text-muted)' }}>
                          {box.version ?? 'version unknown'} · {box.channel === 'canary' ? 'Early access channel' : 'Stable channel'}
                        </p>
                      </div>
                      <button
                        type="button"
                        className="action-button"
                        style={buttonStyle(anyBusy)}
                        disabled={anyBusy}
                        aria-label={`${box.channel === 'canary' ? 'Move to stable' : 'Move to early access'}: ${box.name || 'Unnamed box'} (${shortId(box.id)})`}
                        onClick={() => void toggleChannel(box)}
                      >
                        {busy === `box:${box.id}` ? 'Moving…' : box.channel === 'canary' ? 'Move to stable' : 'Move to early access'}
                      </button>
                    </div>
                    {errors[box.id] && <p role="alert" style={errorStyle}>{errors[box.id]}</p>}
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      )}
    </div>
  );
}
