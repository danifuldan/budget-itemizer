# Design tokens

Source of truth for the app's color palette + role assignments. The
literal hex values live in `src/App.css` `:root` and the dark-mode
`[data-theme="dark"]` block; this doc explains the *intent* and the
constraints each role carries.

## Brand palette (6 colors)

| Hex | Role | Where it shows |
|---|---|---|
| `#FAF7F0` | Canvas (gradient top) | `--bg-app` |
| `#FCE3C7` | Canvas (gradient bottom) | `--bg-app-warm` |
| `#2CCD6C` | Primary accent | `--accent` — CTAs, focus ring, success indicators, app icon |
| `#36AFFF` | Brand blue (decoration only) | `--info` — illustrations, icon highlights on non-cream backgrounds |
| `#FF6A40` | Warning / error | `--red` — error banners, destructive confirmations |
| `#525252` | Structural neutral | `--gray-mid` — icon strokes, dividers, monochrome marks |

The cream pair forms a vertical gradient (`linear-gradient(to bottom,
#FAF7F0, #FCE3C7)`) applied to `body`. The warmer pole sits where the
user's attention lands during long sessions.

## Hue relationships

| Pair | Angular distance | Relationship |
|---|---|---|
| Blue (204°) ↔ Coral (14°) | 170° | True complementary |
| Green (142°) ↔ Blue (204°) | 62° | Analogous |
| Coral (14°) ↔ Green (142°) | 128° | Split complement (near-triadic) |

The system is **near-triadic anchored by one true complementary pair**
(blue↔coral). The cream backgrounds (32–36° hue) live in the same
warm-orange family as the coral at very low saturation, which is what
makes the saturated accents feel intentional against the warm canvas.

## Accessibility-driven token splits

Two tokens look superficially redundant but exist for a reason:

### `--info` vs. `--info-text`

| Token | Hex | Use |
|---|---|---|
| `--info` | `#36AFFF` | Icon fills, illustration strokes, badges on non-cream backgrounds |
| `--info-text` | `#006FBF` | Body-text links (e.g. `.help-link`) |

`#36AFFF` on the cream canvas has a contrast ratio of **2.23:1** —
fails WCAG AA for body text (4.5:1) and AA for UI components (3:1).
`--info-text` is the same hue family (HSL 204°) darkened until it
passes AA (**4.83:1** on cream). Keep them distinct so the brand-bright
blue stays available for icons and decoration where it actually works.

### `--accent` vs. `--accent-text`

| Token | Hex | Use |
|---|---|---|
| `--accent` | `#2CCD6C` | Button fills, focus rings, success-state icon fills |
| `--accent-text` | `#13753E` | Text that needs to read "primary-colored" (e.g. inline success text) |

Same hue family; `--accent-text` darkened to clear AA on cream
(**5.40:1**). Don't use `--accent` for inline text — it'll fail
contrast at body sizes.

## Dark mode

The cream gradient does not translate to dark surfaces. In dark mode:

- `--bg-app` and `--bg-app-warm` are set to the same hex
  (`#1A1916`) so the gradient renders as a flat dark canvas.
- `--accent` is the lighter `#5BDB8A` for legibility on dark.
- `--red` is the lighter coral `#FF8B6B` for the same reason.
- `--info-text` is `#7EC4FF` for AA on dark.

A warm-dark analog (cream-tinted dark canvas) is a possible future
direction but adds complexity; not built for v0.1.0.

## Discipline rules

A four-color accent palette this saturated requires restraint. The
following constraints apply:

1. **One color, one role.** Don't reuse `--accent` for secondary
   buttons; don't reuse `--info` for highlights elsewhere. Each
   color does the one job its token names.
2. **Bright colors are sparing.** Most of any view is `--bg-*` + the
   text ladder. The accents are punctuation, not paragraphs.
3. **Adjacent saturation is forbidden.** Blue and coral are true
   complements — they visually vibrate at full saturation. They're
   functionally separate (info vs. warning) so they shouldn't appear
   in the same field of view at full strength. If they ever need to,
   one of them must be tinted (`--info-tint`, `--red-tint`).
4. **The gray (`--gray-mid`) is brand-neutral.** Don't use it where a
   text token already exists (`--text-2`, `--text-3`). It's for
   monochrome marks and structural details that don't read as text.

## Source of truth

Code wins. If this doc disagrees with `src/App.css`, the CSS is right
and this doc needs updating.
