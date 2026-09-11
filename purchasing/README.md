# Purchasing Dashboard

Enterprise procurement intelligence dashboard for SAP ECC/PRD data. Built from the SAP PRD DuckDB extracts.

## Output
- `index.html` — dashboard entry point (open in a browser; works on `file://`)
- `styles.css` — corporate design system (Inventory / Material Aging dashboard family)
- `app.js` — client-side analytics & rendering (Chart.js)
- `auth-config.js` / `auth.js` — Supabase email+password login gate (per-dashboard access)
- `assets/` — Chart.js UMD, logo, favicon
- `data/data.js` (`window.__PURCHASING__`) — pre-aggregated analytical payload
- `data/purchasing.json` — same payload (JSON form)
- `data/export_purchasing.py` — regenerates the payload from DuckDB; run with the 3.14 Python:
  `C:/Users/c.crizaldo/AppData/Local/Python/pythoncore-3.14-64/python.exe data/export_purchasing.py`

## Auth
The dashboard is gated by a **Supabase email + password** login (`auth-config.js` holds the publishable key; `auth.js` checks the user's `app_metadata.dashboards` allowlist for `"purchasing"`). Boot waits for the `auth:ready` event; opening `index.html` via `file://` without the auth files boots directly (local testing fallback).

## Data sources (Documents/duckdb, schema `sap_prd`)
| Logical dataset            | DuckDB file          | Table           | Role                                             |
|----------------------------|----------------------|-----------------|--------------------------------------------------|
| Goods-receipt ledger       | `po_receipt.duckdb`  | `po_receipt`    | spend / receipts / delivery / lead-time (history)|
| Open commitments           | `fact_incoming.duckdb`| `fact_incoming` | open PO lines still to receive                   |
| Landed-cost conditions     | `fact_konv.duckdb`   | `fact_konv`     | customs, freight, duty, charges ledger           |
| Current stock              | `fact_inventory.duckdb`| `fact_inventory`| stock for purchasing-vs-inventory alignment     |
| Vendor master              | `dim_vendors.duckdb` | `dim_vendors`   | vendor names / local-foreign                     |

## Model decisions
- `po_receipt` grain = one row per goods-receipt posting line (movement type `101` = receipt;
  `102/161/122/162` = reversals / returns). Value = `dmbtr` (local-currency SAR posting value) so all
  currencies sum cleanly. Reversals are shown separately, never silently netted into spend.
- `fact_incoming` = the open-commitment layer (same one used by the PSI & Inventory dashboards).
- `fact_konv` has no PO/material key -> aggregated independently by vendor + condition type + month;
  it is never joined to PO lines (no spend double count).
- `fact_inventory` is used at material level only to flag purchasing/incoming-vs-stock alignment.
- Analysis window = 2024 onward (2023 is a partial extract year, excluded, matching sibling dashboards).
- **No raw fact-to-fact join.** History-vs-open are different snapshots, so no
  "Ordered = Received + Open" identity is forced. Every KPI reconciles to its own source table
  (see the Methodology card inside the dashboard).

## Reconcile
After regenerating `data.js`, run the export and read the printed `==== RECONCILIATION ====` block —
it diffs each analytical total against an independent source query. All lines must report `OK`
before trusting the dashboard numbers.

## Cache-busting
After any `data.js` / `app.js` change, bump the `?v=` on the three asset tags in `index.html`
(exact-string replace) so browsers/CDNs pick up the new payload.
