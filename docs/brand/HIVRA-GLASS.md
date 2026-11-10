# Hivra Glass: the design language

Hivra's interface follows the design language of MonoCode Hub: monochrome
glass. This page is the reference for anyone styling a Hivra screen. The tokens
live at the top of `dashboard/src/app/globals.css`.

## Principles

1. **One ink, one base.** Every colour on screen is the neutral ink
   (`--hg-fg`) mixed over the neutral base (`--hg-bg`) at some strength. Light
   and dark mode swap only those two inputs, so a screen built on the tokens
   works in both without extra rules.
2. **Colour means something.** Green, amber and red are for status only
   (`--hg-ok`, `--hg-warn`, `--hg-bad`). Hivra red (`--hg-brand`) is for the
   mark and for destructive actions. It is never a decoration, a hover tint or
   a primary button.
3. **Glass over haze.** Panels, cards, bars and menus are translucent and
   frosted (`backdrop-filter: blur(24px) saturate(1.3)`) over a soft ambient
   haze painted behind the page. Hairline strokes (6 to 16% ink) define edges;
   shadows are soft and short.
4. **Quiet type.** System faces (SF Pro, Segoe UI, Roboto) at compact sizes:
   13 to 14 px body, 12 px secondary, 11 px labels. Display headings are the
   same face, semibold, tracked tight (-0.02 to -0.04em). Monospace is for
   code, paths, IDs and numbers, never for labels.
5. **Rounded, not boxy.** 7 px controls, 10 px small cards and inputs, 14 px
   cards and panels, 20 px dialogs and the composer, 999 px for pills.
6. **Short, eased motion.** 120 ms for feedback, 200 ms for state changes,
   `cubic-bezier(0.22, 1, 0.36, 1)`. Respect `prefers-reduced-motion`.
7. **Thinking orbs for activity.** Anything running, loading or waiting shows a
   dotted thinking orb (`@/components/ui/ThinkingOrb`), not a spinner.

## Tokens

| Token | Use |
|---|---|
| `--hg-bg`, `--hg-fg` | Base and ink. Theme inputs. |
| `--hg-text`, `--hg-text-2`, `--hg-text-3` | Primary, secondary (68%), muted (46%) text |
| `--hg-stroke-subtle`, `--hg-stroke`, `--hg-stroke-strong` | Lines at 6%, 9%, 16% |
| `--hg-fill-1`, `--hg-fill-2`, `--hg-fill-3`, `--hg-fill-hover` | Selection and raised fills at 4%, 7%, 11%, 9% |
| `--hg-surface`, `--hg-surface-2` | Opaque surfaces when nothing may show through |
| `--hg-glass`, `--hg-glass-strong`, `--hg-glass-blur`, `--hg-glass-edge` | Glass panels, menus, the top highlight |
| `--hg-shadow-sm`, `--hg-shadow-md`, `--hg-shadow-lg` | Elevation |
| `--hg-accent`, `--hg-on-accent` | Primary action fill and its text (ink and base) |
| `--hg-focus` | Focus ring (system blue) |
| `--hg-ok`, `--hg-warn`, `--hg-bad`, `--hg-brand` | Status and the Hivra mark |
| `--hg-radius-xs` … `--hg-radius-xl` | 4, 7, 10, 14, 20 px |
| `--hg-ease`, `--hg-fast`, `--hg-medium` | Motion |
| `--font-sans`, `--font-display`, `--font-mono` | System faces |

The older names (`--vellum-bg`, `--ink-black`, `--bg-surface`,
`--bg-elevated`, `--etched-border`, `--text-secondary`, `--text-muted`,
`--gold-leaf`, `--hivra-red-soft`, `--hivra-red-line` and the rest) are mapped
onto these tokens, so existing components follow the new language. Prefer the
`--hg-*` names in new code.

## Primitives

- `.hg-glass`, `.hg-glass-strong`: frosted panels.
- `.hg-btn`, `.hg-btn-primary`, `.hg-btn-danger`: buttons.
- `.hg-pill`: chips and small status labels.
- `.hg-label`: small uppercase section labels.
- `.etched-card`: the glass card. `.action-button`: the primary action.
- `<ThinkingOrb state="working" size={20 | 32 | 64 | any} />`.

## Global defaults

`globals.css` gives Tailwind-built bordered boxes (`border` class) a 10 px
radius and unrounded buttons and inputs a 7 px radius, unless they carry their
own `rounded*` class or a component class sets a radius. Uppercase labels set
in the monospace face are drawn in the sans face, whether the uppercase comes
from a class or an inline style. Emphasis inside a `.serif` heading is upright,
not italic, and `--font-serif` names the display face. The focus ring is the
system blue everywhere.

Text on an ink fill (`--hg-accent`, or the legacy `--gold-leaf`) uses
`--hg-on-accent`, never `--ink-black`, which is the same ink and would vanish.
