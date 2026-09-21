export type OpsEventBucket =
  | 'assistant-soft-error'
  | 'chat-runtime'
  | 'proxy'
  | 'persistence'
  | 'client-runtime'
  | 'browser'
  | 'health'
  | 'other';

export interface OpsEventLike {
  source: string;
  title: string;
  message: string;
  metadata?: Record<string, unknown> | null;
}

export interface SoftChatErrorDetection {
  category: 'assistant-soft-error';
  title: string;
  reason: string;
  excerpt: string;
  matchedRules: string[];
  severity: 'warn';
}

function normalizeText(value: string): string {
  return value.trim().replace(/\s+/g, ' ').toLowerCase();
}

function buildExcerpt(value: string, max = 280): string {
  const trimmed = value.trim();
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, max)}...`;
}

export function classifyOpsEvent(event: OpsEventLike): OpsEventBucket {
  const source = normalizeText(event.source);
  const title = normalizeText(event.title);
  const message = normalizeText(event.message);
  const category = typeof event.metadata?.category === 'string' ? normalizeText(event.metadata.category) : '';

  if (category === 'assistant-soft-error' || source.includes('chat-soft-error')) {
    return 'assistant-soft-error';
  }
  if (source.includes('persistence') || title.includes('save failed') || message.includes('save failed')) {
    return 'persistence';
  }
  if (source.includes('proxy') || title.includes('proxy') || message.includes('gateway unreachable')) {
    return 'proxy';
  }
  if (source.includes('browser')) return 'browser';
  if (source.includes('health')) return 'health';
  if (source.includes('client') || title.includes('render error') || title.includes('unhandled client error')) {
    return 'client-runtime';
  }
  if (source.includes('chat') || title.includes('chat') || title.includes('generation failed')) {
    return 'chat-runtime';
  }
  return 'other';
}

// Browser fetch() rejects with a small set of locale-stable TypeError
// messages when the transport layer fails (DNS, TCP, CORS, abort,
// connection drop mid-body, etc.). Same shape across Chromium, WebKit,
// and Firefox. These are *plumbing* failures, not LLM output: classifying
// them as "the assistant returned an error-like message" is what made
// the dashboard tell users "Agent returned an error instead of a reply:
// Failed to fetch" even when the agent actually completed the turn
// server-side. Short-circuit here so the regex below never sees them.
const TRANSPORT_FETCH_ERROR_FRAGMENTS = [
  "failed to fetch",
  "load failed",
  "networkerror when attempting to fetch resource",
  "the network connection was lost",
  "the internet connection appears to be offline",
  "the request timed out", // Safari fetch timeout
];

function looksLikeTransportFetchError(normalized: string): boolean {
  return TRANSPORT_FETCH_ERROR_FRAGMENTS.some((fragment) => normalized.includes(fragment));
}

export function detectSoftChatError(content: string): SoftChatErrorDetection | null {
  const normalized = normalizeText(content);
  if (!normalized) return null;

  // Transport-layer fetch rejections are not LLM-emitted error-like
  // messages — they're network failures that already have their own
  // recovery path (refresh / mirror sync / agent-side persistence). The
  // soft-error pipeline exists to catch *agent output* that quacks like
  // an error, so it should never fire on these.
  if (looksLikeTransportFetchError(normalized)) {
    return null;
  }

  const hardPrefixRules = [
    { label: 'error-prefix', test: /^error[:\s-]/ },
    { label: 'failed-prefix', test: /^(request|generation|tool|provider|authentication)?\s*failed\b/ },
    { label: 'went-wrong-prefix', test: /^something went wrong\b/ },
  ];

  const keywordRules = [
    { label: 'provider-returned', test: /\bprovider returned\b/ },
    { label: 'rate-limit', test: /\brate limit(?:ed)?\b/ },
    {
      label: 'authentication',
      test: /\bauth(?:entication)? failed\b|\bunauthorized\b|\binvalid api key\b|\bmissing authentication header\b|\bno codex credentials stored\b|\brun hermes auth\b|\bre-?authenticate\b|\bauth_mismatch\b|\btoken_invalidated\b|\binvalid oauth token\b/,
    },
    { label: 'timeout', test: /\btimed out\b|\btimeout\b/ },
    { label: 'request-failed', test: /\brequest failed\b/ },
    { label: 'tool-failed', test: /\btool (?:execution )?failed\b/ },
    { label: 'gateway', test: /\bgateway unreachable\b|\bgateway returned status\b/ },
  ];

  const negativeSignals = [
    /\bi can help (?:you )?(debug|fix|investigate)\b/,
    /\bhere'?s how to\b/,
    /\bexample\b/,
    /\berror handling\b/,
    /\bif you see this error\b/,
  ];

  if (negativeSignals.some((rule) => rule.test(normalized))) {
    return null;
  }

  const hardMatches = hardPrefixRules.filter((rule) => rule.test.test(normalized)).map((rule) => rule.label);
  const keywordMatches = keywordRules.filter((rule) => rule.test.test(normalized)).map((rule) => rule.label);

  const isShortTechnicalFailure = normalized.length <= 400 && (hardMatches.length > 0 || keywordMatches.length >= 2);
  const isApologyPlusFailure =
    /\b(sorry|apologize)\b/.test(normalized) &&
    (hardMatches.length > 0 || keywordMatches.length > 0);

  if (!isShortTechnicalFailure && !isApologyPlusFailure) {
    return null;
  }

  const matchedRules = [...hardMatches, ...keywordMatches];
  if (matchedRules.length === 0) {
    return null;
  }

  const reason = hardMatches.length > 0
    ? `Assistant message started with an error-like failure phrase (${hardMatches.join(', ')}).`
    : `Assistant message matched multiple runtime failure keywords (${keywordMatches.join(', ')}).`;

  return {
    category: 'assistant-soft-error',
    title: 'Assistant returned an error-like message',
    reason,
    excerpt: buildExcerpt(content),
    matchedRules,
    severity: 'warn',
  };
}
