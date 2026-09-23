'use client';

// VoiceBrief — a zero-cost, key-free voice readout for the "Today's brief"
// summary, using the browser's built-in Web Speech API (window.speechSynthesis).
// paioclaw leads its dashboard with an audio brief (Play + speed); this is the
// Hivra take, styled to the boxy gold/ink command-panel theme. No provider, no
// API key, no network call: synthesis happens entirely in the user's browser.
//
// Graceful by design: if the browser lacks speechSynthesis (older Safari, some
// embedded webviews) the control renders nothing — the text brief above it is
// unaffected. Any in-flight speech is cancelled on unmount and before a new read,
// so rate changes and re-taps never stack utterances.

import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import { Pause, Play } from 'lucide-react';

const SPEEDS = [1, 1.25, 1.5] as const;

function speechSupported(): boolean {
  return (
    typeof window !== 'undefined' &&
    'speechSynthesis' in window &&
    typeof window.SpeechSynthesisUtterance !== 'undefined'
  );
}

// Capability is client-only. useSyncExternalStore reports `false` for the server
// snapshot (so SSR + first client render agree → no hydration mismatch) and the
// real value for the client snapshot — the React-blessed alternative to a
// setState-in-effect capability probe. The store never emits, so the subscribe
// callback is a no-op.
const EMPTY_SUBSCRIBE = () => () => {};
function useSpeechSupported(): boolean {
  return useSyncExternalStore(EMPTY_SUBSCRIBE, speechSupported, () => false);
}

export function VoiceBrief({ text }: { text: string }) {
  const supported = useSpeechSupported();
  const [speaking, setSpeaking] = useState(false);
  const [speedIdx, setSpeedIdx] = useState(0);

  // Stop any in-flight speech when the panel unmounts.
  useEffect(() => {
    return () => {
      if (speechSupported()) window.speechSynthesis.cancel();
    };
  }, []);

  const stop = useCallback(() => {
    if (speechSupported()) window.speechSynthesis.cancel();
    setSpeaking(false);
  }, []);

  const speakAt = useCallback((rate: number) => {
    if (!speechSupported()) return;
    // Clear anything queued/playing first so rate changes + re-taps don't stack.
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.rate = rate;
    utterance.onend = () => setSpeaking(false);
    utterance.onerror = () => setSpeaking(false);
    setSpeaking(true);
    window.speechSynthesis.speak(utterance);
  }, [text]);

  const toggle = useCallback(() => {
    if (speaking) stop();
    else speakAt(SPEEDS[speedIdx]);
  }, [speaking, stop, speakAt, speedIdx]);

  const cycleSpeed = useCallback(() => {
    const next = (speedIdx + 1) % SPEEDS.length;
    setSpeedIdx(next);
    if (speaking) speakAt(SPEEDS[next]); // restart at the new rate mid-read
  }, [speedIdx, speaking, speakAt]);

  if (!supported) return null;

  return (
    <div
      data-testid="voice-brief"
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        border: '1px solid var(--etched-border)',
        background: 'rgba(212, 175, 55, 0.06)',
        padding: '8px 10px',
      }}
    >
      <button
        type="button"
        onClick={toggle}
        aria-label={speaking ? 'Stop reading your brief' : 'Listen to your brief'}
        aria-pressed={speaking}
        data-testid="voice-brief-toggle"
        className="cmdp-icon-btn"
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: 30,
          height: 30,
          flexShrink: 0,
          borderRadius: 0,
          border: '1px solid var(--gold-leaf)',
          background: speaking ? 'var(--gold-leaf)' : 'transparent',
          color: speaking ? 'var(--ink-black)' : 'var(--gold-leaf)',
          cursor: 'pointer',
        }}
      >
        {speaking ? <Pause size={15} /> : <Play size={15} style={{ marginLeft: 1 }} />}
      </button>

      <div style={{ display: 'grid', gap: 3, flex: '1 1 auto', minWidth: 0 }}>
        <span
          className="mono cmdp-small"
          style={{
            fontSize: 10,
            textTransform: 'uppercase',
            letterSpacing: '0.14em',
            color: 'var(--text-secondary)',
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}
        >
          {speaking ? 'Reading your brief…' : 'Listen to your brief'}
        </span>
        {speaking ? <SpeakingBars /> : null}
      </div>

      <button
        type="button"
        onClick={cycleSpeed}
        aria-label={`Playback speed ${SPEEDS[speedIdx]}×`}
        data-testid="voice-brief-speed"
        className="mono cmdp-icon-btn"
        style={{
          flexShrink: 0,
          border: '1px solid var(--etched-border)',
          background: 'transparent',
          color: 'var(--text-secondary)',
          fontSize: 11,
          fontWeight: 700,
          padding: '4px 7px',
          cursor: 'pointer',
        }}
      >
        {SPEEDS[speedIdx]}×
      </button>
    </div>
  );
}

function SpeakingBars() {
  return (
    <div aria-hidden style={{ display: 'flex', alignItems: 'flex-end', gap: 2, height: 10 }}>
      <style>{`@keyframes vb-bar{0%,100%{transform:scaleY(0.35)}50%{transform:scaleY(1)}}`}</style>
      {[0, 1, 2, 3].map((i) => (
        <span
          key={i}
          style={{
            display: 'block',
            width: 2.5,
            height: 10,
            transformOrigin: 'bottom',
            background: 'var(--gold-leaf)',
            animation: 'vb-bar 0.9s ease-in-out infinite',
            animationDelay: `${i * 0.12}s`,
          }}
        />
      ))}
    </div>
  );
}
