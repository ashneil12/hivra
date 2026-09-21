// channel-surface — the presentation metadata for the dashboard "Channels"
// surface. The wire (env keys, fields, validation) lives in
// ./config (INTEGRATION_DEFINITIONS); the connect route + guides + prompts are
// already wired for every platform here. This file only adds the per-channel
// UI affordances the tile grid needs: a short tagline, a category, and a hint
// of how the connect flow behaves. It deliberately does NOT redefine fields —
// the connect modal reads those straight from the integration definition so the
// two can never drift.

import type { LucideIcon } from 'lucide-react';
import {
  Send,
  MessageSquare,
  Hash,
  Phone,
  Mail,
  MessageCircle,
  Globe,
  Server,
  Home,
  BookOpen,
  ListChecks,
  Bird,
  Building2,
} from 'lucide-react';

export type ChannelConnectStyle =
  // Reuses the dedicated Telegram pairing flow (token → bot DMs a code → approve).
  | 'telegram'
  // The generic env-token flow: paste the definition's fields → connect.
  | 'fields'
  // QR/device-link channels: we store the enable flag + optional allowlist, but
  // the actual device link happens via a runtime CLI step the agent walks the
  // user through. The tile says so honestly rather than implying instant connect.
  | 'device-link'
  // OAuth-managed (Google Workspace) — not a paste-a-token flow; routed to the
  // existing dedicated surface, marked accordingly.
  | 'oauth';

export type ChannelSurfaceMeta = {
  /** Must match an INTEGRATION_DEFINITIONS id exactly. */
  id: string;
  /** Tile display name (defaults to id when omitted). */
  label?: string;
  icon: LucideIcon;
  /** One honest line about what connecting does. No fake scarcity/claims. */
  tagline: string;
  connectStyle: ChannelConnectStyle;
  /** Group the tiles. Messaging channels are the headline; tools are secondary. */
  category: 'messaging' | 'tools';
};

// Messaging channels first (the headline ask), then the env-token tool
// integrations. Every id here has a live case in the connect route + a guide in
// guides.tsx. OAuth-managed Google Workspace is intentionally NOT listed in the
// tile grid (it has its own dedicated surface); 'Custom Variables' is an
// advanced env editor, not a channel, so it's omitted too.
export const CHANNEL_SURFACE: ChannelSurfaceMeta[] = [
  {
    id: 'Telegram',
    icon: Send,
    tagline: 'Chat with your agent from your phone and get pinged when work is done.',
    connectStyle: 'telegram',
    category: 'messaging',
  },
  {
    id: 'Discord',
    icon: MessageSquare,
    tagline: 'Run your agent from a Discord server with a bot you create.',
    connectStyle: 'fields',
    category: 'messaging',
  },
  {
    id: 'Slack',
    icon: Hash,
    tagline: 'Mention your agent in Slack channels and DMs via Socket Mode.',
    connectStyle: 'fields',
    category: 'messaging',
  },
  {
    id: 'WhatsApp',
    icon: MessageCircle,
    tagline: 'Link a WhatsApp number by scanning a QR from your server console.',
    connectStyle: 'device-link',
    category: 'messaging',
  },
  {
    id: 'Signal',
    icon: MessageCircle,
    tagline: 'Reach your agent over Signal via a signal-cli REST endpoint.',
    connectStyle: 'fields',
    category: 'messaging',
  },
  {
    id: 'SMS (Twilio)',
    label: 'SMS',
    icon: Phone,
    tagline: 'Text your agent from any phone using a Twilio number.',
    connectStyle: 'fields',
    category: 'messaging',
  },
  {
    id: 'Email',
    icon: Mail,
    tagline: 'Email your agent over IMAP/SMTP with an app password.',
    connectStyle: 'fields',
    category: 'messaging',
  },
  {
    id: 'Matrix',
    icon: Globe,
    tagline: 'Connect a Matrix bot account on any homeserver.',
    connectStyle: 'fields',
    category: 'messaging',
  },
  {
    id: 'Mattermost',
    icon: Server,
    tagline: 'Drive your agent from a Mattermost bot account.',
    connectStyle: 'fields',
    category: 'messaging',
  },
  {
    id: 'BlueBubbles',
    icon: MessageCircle,
    tagline: 'Send and receive iMessage via a BlueBubbles server.',
    connectStyle: 'fields',
    category: 'messaging',
  },
  {
    id: 'X (Twitter)',
    label: 'X',
    icon: Bird,
    tagline: 'Let your agent post and read on X with your API keys.',
    connectStyle: 'fields',
    category: 'messaging',
  },
  {
    id: 'DingTalk',
    icon: Building2,
    tagline: 'Connect a DingTalk enterprise app.',
    connectStyle: 'fields',
    category: 'messaging',
  },
  {
    id: 'WeCom',
    icon: Building2,
    tagline: 'Connect a WeCom (WeChat Work) app.',
    connectStyle: 'fields',
    category: 'messaging',
  },
  {
    id: 'WeChat',
    icon: MessageCircle,
    tagline: 'Connect a WeChat Official Account.',
    connectStyle: 'fields',
    category: 'messaging',
  },
  {
    id: 'Feishu',
    icon: Building2,
    tagline: 'Connect a Feishu (Lark) custom app.',
    connectStyle: 'fields',
    category: 'messaging',
  },
  {
    id: 'Home Assistant',
    icon: Home,
    tagline: 'Give your agent control of your Home Assistant devices.',
    connectStyle: 'fields',
    category: 'tools',
  },
  {
    id: 'GitHub',
    icon: BookOpen,
    tagline: 'Let your agent work with your repos, issues, and pull requests.',
    connectStyle: 'fields',
    category: 'tools',
  },
  {
    id: 'Notion',
    icon: BookOpen,
    tagline: 'Connect Notion pages and databases you share with the integration.',
    connectStyle: 'fields',
    category: 'tools',
  },
  {
    id: 'Linear',
    icon: ListChecks,
    tagline: 'Let your agent create, update, and search your Linear issues.',
    connectStyle: 'fields',
    category: 'tools',
  },
];

export function getChannelSurfaceMeta(id: string): ChannelSurfaceMeta | undefined {
  return CHANNEL_SURFACE.find((c) => c.id.toLowerCase() === id.toLowerCase());
}
