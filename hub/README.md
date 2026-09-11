# ERP Dashboards Hub

Landing page that links every reporting dashboard. Same design system as its
siblings (Inventory / Purchasing / Material Aging), static, no build step, no auth.

## What it is

One page, one card per dashboard: title, byline, the dashboard's own last data
refresh stamp, and a link to the live site. A "Open locally" button appears when
the page is opened from `file://`, pointing at the sibling folder on this machine.

The hub is deliberately **not** login-gated. Each dashboard keeps its own Supabase
gate (`app_metadata.dashboards` allowlist). A hub login would not carry across
subdomains anyway — Supabase stores its session per origin in `localStorage`.

## Interaction and polish notes

These are deliberate; don't "simplify" them away.

- **The whole card is clickable.** A single stretched anchor (`.card-hit`,
  `position:absolute; inset:0`) covers each card, so there is one tab stop per card
  instead of a nested duplicate link. The visible call-to-action (`.btn.cta`) is a
  decorative `aria-hidden` span with `pointer-events:none`; the "Open locally" ghost
  link sits above the overlay with `z-index:1`. Verified with `elementFromPoint`.
- **Card text is clamped to fixed line counts** (byline 2, description 3). Without
  the clamps a longer wrap pushes one card's pill row and buttons ~19px below its
  neighbours. If you edit `desc` in `build_hub.py`, keep it short enough not to clip
  at the narrowest 3-column width.
- **Button labels are contrast-derived, not hard-coded.** `build_hub.py` picks each
  card's `ink` by walking `INK_CANDIDATES` for the first colour that clears WCAG AA
  (4.5:1) against that card's accent, and **fails the build** if none does. White on
  the amber accent is only 2.03:1 — unreadable. The fill is the inline `--card-accent`,
  which does not change with the theme, so a single `ink` covers both themes.
- **Focus is styled.** Chrome's default ring is near-black (~1.2:1) and invisible on
  this background, so `:focus-visible` draws a 2px accent ring.
- **Icons are one SVG set**, 2px stroke, `currentColor`, `aria-hidden`. No emoji —
  they render differently per platform and clash with the monochrome system. The
  theme toggle cross-fades sun/moon (both in the DOM) at the standard
  `opacity` / `scale(0.25→1)` / `blur(4px→0)` values.
- **Transitions name their properties** (never `transition: all`), and
  `prefers-reduced-motion` drops movement while keeping the colour cues.
- **Hit areas**: 40×40 minimum on desktop, 44×44 under 640px.


## Files

| File | Purpose |
|------|---------|
| `index.html` | Layout: topbar, hero, card grid, notice, footer |
| `styles.css` | Same design tokens as the sibling dashboards (dark + light) |
| `app.js` | Renders cards from `data/hub.js`; theme toggle (`hub-theme`) |
| `data/hub.js` | Generated payload (`window.__HUB__`) — card list + refresh stamps |
| `data/build_hub.py` | Regenerates `data/hub.js` from the sibling exports |
| `assets/logo.png`, `assets/favicon.ico` | Branding (copied from the dashboards) |
| `CNAME` | `hub.abederp.com` |

## Refresh the refresh-dates

```bash
cd "C:/Users/crackdcode/Downloads/dashboards/hub"
python data/build_hub.py
```

It reads `generated_at` from the head of each sibling export
(`../inventory/data/inventory.json`, `../purchasing/data/purchasing.json`,
`../aging/data/material_aging.json`) — nothing is hard-coded. Then bump the two
`?v=` cache-busters in `index.html`.

## Add a dashboard

Append an entry to `DASHBOARDS` in `data/build_hub.py` (order, id, title, byline,
desc, url, host, local, accent, icon, stamp_file), re-run the script, done.

## Deploy

Repo root = this folder. GitHub Pages serves `index.html`; `CNAME` gives it
`hub.abederp.com`. Needs a DNS record for `hub` (it is currently NXDOMAIN), plus
the same Cloudflare proxy setup the other three subdomains use.

## Run locally

Double-click `index.html`, or serve it:

```bash
cd "C:/Users/crackdcode/Downloads/dashboards/hub"
python -m http.server 8099
# http://localhost:8099
```
