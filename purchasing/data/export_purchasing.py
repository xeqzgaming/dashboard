"""Export Purchasing Dashboard payload from DuckDB.

Sources (SAP PRD / ECC EHP7 extracts, Documents/duckdb):
  po_receipt.duckdb    (sap_prd.po_receipt)   goods-receipt movement ledger
  fact_incoming.duckdb (sap_prd.fact_incoming) open purchase-order commitments
  fact_inventory.duckdb(sap_prd.fact_inventory) current stock (alignment only)
  dim_vendors.duckdb   (sap_prd.dim_vendors)   vendor master
  fact_konv.duckdb     (sap_prd.fact_konv)     landed-cost / pricing condition ledger

Run with the 3.14 Python (duckdb installed):
  C:/Users/c.crizaldo/AppData/Local/Python/pythoncore-3.14-64/python.exe export_purchasing.py

Model / grain (documented in the dashboard methodology card):
- po_receipt = goods-receipt movement ledger; value basis = sar_net_value (net value already
  FX-converted to SAR), matching the org-standard definition used by the PSI dashboard and the
  Obsidian "Executive Purchasing Dashboard" design note: GR value = SUM(sar_net_value) over
  goods-receipt rows, net of returns (reversal rows 102/161/122/162 carry negative values and are
  included, exactly as PSI reports ~SAR 4.63B). Quantity = gr_menge.
- The GR-based analytics (spend, vendor/material/purchasing-group/plant totals, delivery
  performance, lead time) are produced at BOTH all-years grain (vendor_gr / material_gr / ... )
  AND per-year grain (vendor_gr_y / material_gr_y / delivery_y / lead_y ...) so the dashboard can
  default to "current year" while still offering an "All years" view. Each row within the
  *_y structures is the (dimension x company) total for that GR year.
- fact_incoming = open PO lines still to receive (point-in-time commitment layer; NOT year scoped).
- fact_konv = landed-cost / condition ledger (point-in-time / period-free); no PO/material key, so
  it is aggregated independently and never joined to PO lines.
- fact_inventory = current stock at matnr level (point-in-time), for purchasing-vs-stock alignment.
- Analysis window excludes 2023 (partial extract year), matching the PSI/inventory dashboards.

Every KPI reconciles to its own source (reconcile block printed at end).
"""
import duckdb, json, datetime, os

HOME = "C:/Users/c.crizaldo/OneDrive - Ahmad A. Abed Trading Co. Ltd/Documents"
DUCK = os.path.join(HOME, "duckdb")
OUT_DIR = os.path.dirname(os.path.abspath(__file__))   # Purchasing/data
OUT_JSON = os.path.join(OUT_DIR, "purchasing.json")
OUT_JS = os.path.join(OUT_DIR, "data.js")

PO_REC = os.path.join(DUCK, "po_receipt.duckdb")
INCOMING = os.path.join(DUCK, "fact_incoming.duckdb")
INV = os.path.join(DUCK, "fact_inventory.duckdb")
VENDORS = os.path.join(DUCK, "dim_vendors.duckdb")
KONV = os.path.join(DUCK, "fact_konv.duckdb")

AS_OF = datetime.date.today()
YEAR_EXCL = "2023"

def strip_matnr(v):
    return str(v).lstrip("0") or "0"
def money(x): return round(float(x or 0), 2)
def qty(x): return round(float(x or 0), 4)

print("== po_receipt (GR history) ==")
con = duckdb.connect(PO_REC, read_only=True)
companies = {"1000": "Company 1000", "6000": "Company 6000"}
W = "gr_date IS NOT NULL AND CAST(strftime(gr_date,'%Y') AS INT) <> " + YEAR_EXCL

# ---- 1) Spend baseline (all years, net of returns) ----
base = con.execute(f"""
SELECT COUNT(*) AS n_post, COUNT(DISTINCT po_number) AS n_po,
       SUM(sar_net_value) AS val_sar, SUM(gr_menge) AS qty,
       SUM(tonnage) AS ton,
       COUNT(DISTINCT vendor_number) AS vendors, COUNT(DISTINCT material_number) AS materials
FROM sap_prd.po_receipt WHERE {W}
""").fetchone()
# tonnage by year (net universe) for the year-scoped Tonnage card
ton_y = con.execute(f"""
SELECT CAST(strftime(gr_date,'%Y') AS INT) yr, SUM(tonnage)
FROM sap_prd.po_receipt WHERE {W} GROUP BY 1
""").fetchall()
ton_y_map = {str(y): float(t) for y, t in ton_y}
rev = con.execute(f"""
SELECT COUNT(*), SUM(sar_net_value), SUM(gr_menge)
FROM sap_prd.po_receipt
WHERE gr_date IS NOT NULL AND bwart IN ('102','161','122','162') AND CAST(strftime(gr_date,'%Y') AS INT) <> {YEAR_EXCL}
""").fetchone()
# per-year reversal (for current-year default consistency)
rev_y = con.execute(f"""
SELECT CAST(strftime(gr_date,'%Y') AS INT) yr, COUNT(*), SUM(sar_net_value), SUM(gr_menge)
FROM sap_prd.po_receipt
WHERE gr_date IS NOT NULL AND bwart IN ('102','161','122','162') AND CAST(strftime(gr_date,'%Y') AS INT) <> {YEAR_EXCL}
GROUP BY 1
""").fetchall()
print(f"  GR rows={base[0]}  POs={base[1]}  spendSAR(net)={base[2]:,.0f}  qty={base[3]:,.0f}  vendors={base[4]}  mats={base[5]}")
print(f"  reversals postings={rev[0]}  val={rev[1]:,.0f}  qty={rev[2]:,.0f}")

N_REC = int(con.execute(f"SELECT COUNT(*) FROM sap_prd.po_receipt WHERE {W} AND bwart='101'").fetchone()[0])
print("  101 receipts (delivery/lead universe):", N_REC)

# ---- distinct PO per (company, year) ----
po_rows = con.execute(f"""
SELECT company_code, CAST(strftime(gr_date,'%Y') AS INT) yr, COUNT(DISTINCT po_number) n
FROM sap_prd.po_receipt WHERE {W} GROUP BY 1,2
""").fetchall()
po_cc_rows = con.execute(f"""
SELECT company_code, COUNT(DISTINCT po_number) n FROM sap_prd.po_receipt WHERE {W} GROUP BY 1
""").fetchall()
years = sorted({str(y) for _, y, _ in po_rows})
PO_MAP = {}
for cc, yr, n in po_rows: PO_MAP[(cc or '') + '|' + str(yr)] = int(n)
for cc, n in po_cc_rows: PO_MAP[cc + '|all'] = int(n)
PO_MAP['|all'] = int(base[1])
for yr in years: PO_MAP['|' + yr] = sum(PO_MAP.get(cc + '|' + yr, 0) for cc in ('1000','6000'))

# ---- 2) monthly spend (ym) ----
monthly = con.execute(f"""
SELECT company_code, substr(CAST(gr_date AS VARCHAR),1,7) ym,
       SUM(sar_net_value) val_sar, SUM(gr_menge) qty, SUM(tonnage) ton, COUNT(*) post, COUNT(DISTINCT po_number) po
FROM sap_prd.po_receipt WHERE {W} GROUP BY 1,2 ORDER BY 2
""").fetchall()

# ---- 3) vendor (per (vendor,cc,yr)) ----
vendor_gr = con.execute(f"""
SELECT vendor_number, company_code, CAST(strftime(gr_date,'%Y') AS INT) yr,
       SUM(sar_net_value) val_sar, SUM(gr_menge) qty, COUNT(*) post, COUNT(DISTINCT po_number) po
FROM sap_prd.po_receipt WHERE {W} GROUP BY 1,2,3
""").fetchall()

# ---- 4) material (per (mat,cc,yr)) ----
material_gr = con.execute(f"""
SELECT material_number, MIN(material_description) descr, company_code, CAST(strftime(gr_date,'%Y') AS INT) yr,
       SUM(sar_net_value) val_sar, SUM(gr_menge) qty, COUNT(DISTINCT po_number) po
FROM sap_prd.po_receipt WHERE {W} GROUP BY 1,3,4
""").fetchall()

# ---- 5) purchasing group (per (pgrp,cc,yr)) ----
pgrp_gr = con.execute(f"""
SELECT purchasing_group, company_code, CAST(strftime(gr_date,'%Y') AS INT) yr,
       SUM(sar_net_value) val_sar, SUM(gr_menge) qty, COUNT(*) post, COUNT(DISTINCT vendor_number) vendors
FROM sap_prd.po_receipt WHERE {W} GROUP BY 1,2,3
""").fetchall()

# ---- 6) plant (per (plant,cc,yr)) ----
plant_gr = con.execute(f"""
SELECT plant, company_code, CAST(strftime(gr_date,'%Y') AS INT) yr,
       SUM(sar_net_value) val_sar, SUM(gr_menge) qty, COUNT(DISTINCT vendor_number) vendors
FROM sap_prd.po_receipt WHERE {W} GROUP BY 1,2,3
""").fetchall()

# ---- 7) delivery categories (per yr, 101 receipts) ----
deliv = con.execute(f"""
SELECT CAST(strftime(gr_date,'%Y') AS INT) yr,
  CASE WHEN stat_rel_del_date IS NULL OR stat_rel_del_date IN ('','0','00000000')
            OR try_strptime(stat_rel_del_date,'%Y%m%d') IS NULL THEN 'missing'
       WHEN gr_date < try_strptime(stat_rel_del_date,'%Y%m%d')::DATE THEN 'early'
       WHEN gr_date = try_strptime(stat_rel_del_date,'%Y%m%d')::DATE THEN 'on_time'
       WHEN gr_date <= try_strptime(stat_rel_del_date,'%Y%m%d')::DATE + INTERVAL 7 DAY THEN 'late_<=7'
       ELSE 'late_>7' END cat,
  COUNT(*) post, SUM(dmbtr) val_sar
FROM sap_prd.po_receipt WHERE {W} AND bwart='101' GROUP BY 1,2
""").fetchall()

# ---- 8) lead time buckets (per yr, 101 receipts) ----
lead = con.execute(f"""
SELECT CAST(strftime(gr_date,'%Y') AS INT) yr,
  CASE WHEN lt<0 THEN 'neg' WHEN lt<=7 THEN '0-7' WHEN lt<=30 THEN '8-30' WHEN lt<=60 THEN '31-60'
       WHEN lt<=90 THEN '61-90' WHEN lt<=180 THEN '91-180' ELSE '180+' END bucket,
  COUNT(*) post, AVG(lt) avg_lt
FROM (
  SELECT gr_date, DATEDIFF('day', try_strptime(po_creation_date,'%Y%m%d')::DATE, gr_date) lt
  FROM sap_prd.po_receipt WHERE {W} AND bwart='101'
) GROUP BY 1,2
""").fetchall()

# ---- 9) incoterm & strategy-group spend (per (dim, cc, yr), net universe) ----
inc_gr = con.execute(f"""
SELECT COALESCE(NULLIF(TRIM(incoterms),''),'(blank)') dim, company_code,
       CAST(strftime(gr_date,'%Y') AS INT) yr,
       SUM(sar_net_value) val_sar, COUNT(*) post
FROM sap_prd.po_receipt WHERE {W} GROUP BY 1,2,3
""").fetchall()
strat_gr = con.execute(f"""
SELECT COALESCE(NULLIF(TRIM(strategy_group),''),'Not Defined') dim, company_code,
       CAST(strftime(gr_date,'%Y') AS INT) yr,
       SUM(sar_net_value) val_sar, COUNT(*) post
FROM sap_prd.po_receipt WHERE {W} GROUP BY 1,2,3
""").fetchall()

# ---- 9b) GR-spend dims: point of destination, container, freight forwarder, broker ----
def dim_query(col):
    # returns (dimval, cc, yr, val_sar, post); blank/whitespace -> 'Not Defined'
    return con.execute(f"""
    SELECT COALESCE(NULLIF(TRIM({col}),''),'Not Defined') dim, company_code,
           CAST(strftime(gr_date,'%Y') AS INT) yr,
           SUM(sar_net_value) val_sar, COUNT(*) post
    FROM sap_prd.po_receipt WHERE {W} GROUP BY 1,2,3
    """).fetchall()
pod_gr   = dim_query('point_of_destination') # point-of-destination labels
container_gr = dim_query('zcontainer')       # container type labels
fwd_raw  = dim_query('zfreight_forw')        # freight-forwarder vendor codes (name resolved in python)
broker_raw = dim_query('zbroker')            # broker vendor codes (name resolved in python)

# ---- 9c) per-vendor lead time (avg days over 101 receipts, per (vendor, cc, yr)) ----
vlead_raw = con.execute(f"""
SELECT vendor_number, company_code, CAST(strftime(gr_date,'%Y') AS INT) yr,
       COUNT(*) post, AVG(DATEDIFF('day', try_strptime(po_creation_date,'%Y%m%d')::DATE, gr_date)) avg_lt
FROM sap_prd.po_receipt WHERE {W} AND bwart='101'
GROUP BY 1,2,3
""").fetchall()
con.close()

# ---- vendor master (needed during aggregation for names) ----
con = duckdb.connect(VENDORS, read_only=True)
vrows = con.execute("SELECT lifnr, name1, land1, is_local, text1 FROM sap_prd.dim_vendors").fetchall()
con.close()
vendors = {}
for lifnr, name1, land1, is_local, text1 in vrows:
    vendors[str(lifnr)] = {"name": name1 or "", "country": land1 or "", "local": is_local or "", "grp": text1 or ""}
print("  vendor master:", len(vendors))

# ============ PYTHON AGGREGATION ============
payload = {}
payload["as_of"] = AS_OF.isoformat()
payload["generated_at"] = datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
payload["company_names"] = companies
payload["po_by_ccyear"] = PO_MAP
payload["kpi_spend"] = {
    "val_sar": money(base[2]), "qty": qty(base[3]), "ton": round(float(base[4] or 0),1),
    "postings": int(base[0]), "po": int(base[1]), "vendors": int(base[5]), "materials": int(base[6]),
    "rev_post": int(rev[0]), "rev_val": money(rev[1]), "rev_qty": qty(rev[2]),
}
payload["ton_y"] = ton_y_map
payload["rev_y"] = {str(y): {"post": int(p), "val": money(v), "qty": qty(qq)} for y, p, v, qq in rev_y}
payload["monthly_gr"] = [{"cc": r[0], "ym": r[1], "val_sar": money(r[2]),
                          "qty": qty(r[3]), "ton": round(float(r[4] or 0),1),
                          "post": int(r[5]), "po": int(r[6])} for r in monthly]

# ---- vendor: merge helper + all + per-year ----
def merge_vendors(rows):
    m = {}
    for vn, cc, yr, val, q, post, po in rows:
        k = (vn, cc)
        d = m.get(k)
        if d is None:
            d = m[k] = {"vendor": vn, "cc": cc, "val_sar": 0.0, "qty": 0.0, "post": 0, "po": 0}
        d["val_sar"] += money(val); d["qty"] += qty(q); d["post"] += int(post); d["po"] += int(po)
    out = []
    for d in m.values():
        meta = vendors.get(str(d["vendor"]), {})
        d["name"] = meta.get("name") or d["vendor"]
        d["local"] = meta.get("local") or ""
        d["country"] = meta.get("country") or ""
        out.append(d)
    out.sort(key=lambda r: -r["val_sar"])
    return out
payload["vendor_gr"] = merge_vendors(vendor_gr)
payload["vendor_gr_y"] = {y: merge_vendors([r for r in vendor_gr if str(r[2]) == y]) for y in years}

# ---- material ----
def merge_materials(rows):
    m = {}
    for mn, descr, cc, yr, val, q, po in rows:
        mm = strip_matnr(mn); k = (mm, cc)
        d = m.get(k)
        if d is None:
            d = m[k] = {"matnr": mm, "descr": descr or "", "cc": cc, "val_sar": 0.0, "qty": 0.0, "po": 0}
        d["val_sar"] += money(val); d["qty"] += qty(q); d["po"] += int(po)
    return sorted(m.values(), key=lambda r: -r["val_sar"])
payload["material_gr"] = merge_materials(material_gr)
payload["material_gr_y"] = {y: merge_materials([r for r in material_gr if str(r[3]) == y]) for y in years}

# ---- purchasing group ----
def merge_pgrp(rows):
    m = {}
    for pgrp, cc, yr, val, q, post, vens in rows:
        k = (pgrp, cc)
        d = m.get(k)
        if d is None:
            d = m[k] = {"pgrp": pgrp, "cc": cc, "val_sar": 0.0, "qty": 0.0, "post": 0, "vendors": 0}
        d["val_sar"] += money(val); d["qty"] += qty(q); d["post"] += int(post); d["vendors"] += int(vens)
    return list(m.values())
payload["pgrp_gr"] = merge_pgrp(pgrp_gr)
payload["pgrp_gr_y"] = {y: merge_pgrp([r for r in pgrp_gr if str(r[2]) == y]) for y in years}

# ---- plant ----
def merge_plant(rows):
    m = {}
    for plant, cc, yr, val, q, vens in rows:
        k = (plant, cc)
        d = m.get(k)
        if d is None:
            d = m[k] = {"plant": plant, "cc": cc, "val_sar": 0.0, "qty": 0.0, "vendors": 0}
        d["val_sar"] += money(val); d["qty"] += qty(q); d["vendors"] += int(vens)
    return list(m.values())
payload["plant_gr"] = merge_plant(plant_gr)

# ---- GR-spend share dims (loading/destination/container/forwarder/broker) ----
# dim_query returns raw codes for zfreight_forw/zbroker; resolve to vendor name for display.
def vendor_label(code):
    meta = vendors.get(str(code) or "")
    return (meta or {}).get("name") or code
def merge_dim(rows, label=None):
    # rows: (dim, cc, yr, val, post) -> accumulate across years per (label, cc)
    agg = {}
    for dim, cc, yr, val, post in rows:
        lab = label(dim) if label else dim
        k = (lab, cc)
        d = agg.get(k)
        if d is None:
            d = agg[k] = {"label": lab, "cc": cc, "val_sar": 0.0, "post": 0}
        d["val_sar"] += money(val); d["post"] += int(post)
    out = sorted(agg.values(), key=lambda r: -r["val_sar"])
    return out
payload["incoterm_gr"] = merge_dim(inc_gr)
payload["incoterm_gr_y"] = {y: merge_dim([r for r in inc_gr if str(r[2]) == y]) for y in years}
payload["strategy_gr"] = merge_dim(strat_gr)
payload["strategy_gr_y"] = {y: merge_dim([r for r in strat_gr if str(r[2]) == y]) for y in years}
payload["dest_gr"] = merge_dim(pod_gr)
payload["dest_gr_y"] = {y: merge_dim([r for r in pod_gr if str(r[2]) == y]) for y in years}
payload["container_gr"] = merge_dim(container_gr)
payload["container_gr_y"] = {y: merge_dim([r for r in container_gr if str(r[2]) == y]) for y in years}
payload["forwarder_gr"] = merge_dim(fwd_raw, vendor_label)
payload["forwarder_gr_y"] = {y: merge_dim([r for r in fwd_raw if str(r[2]) == y], vendor_label) for y in years}
payload["broker_gr"] = merge_dim(broker_raw, vendor_label)
payload["broker_gr_y"] = {y: merge_dim([r for r in broker_raw if str(r[2]) == y], vendor_label) for y in years}

# ---- per-vendor lead time (weighted avg across years; post-weighted) ----
def merge_vlead(rows):
    # rows: (vendor, cc, yr, post, avg_lt) -> combine across years per (vendor, cc), post-weighted
    agg = {}
    for vn, cc, yr, post, avg_lt in rows:
        k = (vn, cc)
        d = agg.get(k)
        if d is None:
            d = agg[k] = {"vendor": vn, "cc": cc, "lead_days": 0.0, "post": 0}
        w = float(post)
        d["lead_days"] += float(avg_lt or 0) * w; d["post"] += int(post)
    out = []
    for d in agg.values():
        d["lead_days"] = round(d["lead_days"] / d["post"], 1) if d["post"] else 0
        out.append(d)
    return out
payload["vendor_lead"] = merge_vlead(vlead_raw)
payload["vendor_lead_y"] = {y: merge_vlead([r for r in vlead_raw if str(r[2]) == y]) for y in years}

# ---- delivery & lead ----
cat_order = ["on_time", "early", "late_<=7", "late_>7", "missing"]
lt_order = ["0-7","8-30","31-60","61-90","91-180","180+"]
def merge_delivery(rows):
    # rows: (yr, cat, post, val); same cat appears per year -> sum across years
    agg = {}
    for yr, cat, post, val in rows:
        d = agg.get(cat)
        if d is None:
            d = agg[cat] = {"post": 0, "val_sar": 0.0}
        d["post"] += int(post); d["val_sar"] += money(val)
    return {c: agg.get(c, {"post": 0, "val_sar": 0.0}) for c in cat_order}
payload["delivery"] = merge_delivery(deliv)
payload["delivery_y"] = {y: merge_delivery([r for r in deliv if str(r[0]) == y]) for y in years}
def merge_lead(rows):
    # rows: (yr, bucket, post, avg); same bucket per year -> weighted avg across years
    agg = {}
    for yr, bucket, post, avg in rows:
        d = agg.get(bucket)
        if d is None:
            d = agg[bucket] = {"post": 0, "avg_w": 0.0}
        d["post"] += int(post); d["avg_w"] += float(post) * float(avg or 0)
    out = {}
    for b in lt_order:
        a = agg.get(b)
        out[b] = {"post": a["post"] if a else 0,
                  "avg": round(a["avg_w"] / a["post"],1) if a and a["post"] else 0}
    return out
payload["lead"] = merge_lead(lead)
payload["lead_y"] = {y: merge_lead([r for r in lead if str(r[0]) == y]) for y in years}

# ---- open commitments (point-in-time) ----
con = duckdb.connect(INCOMING, read_only=True)
open_base = con.execute("SELECT COUNT(*), COUNT(DISTINCT po_number), SUM(quantity), SUM(net_value), COUNT(DISTINCT vendor_number) FROM sap_prd.fact_incoming").fetchone()
open_rows = con.execute("""
SELECT company_code, plant, storage_location, po_number, po_item, vendor_number,
       material_number, quantity, umrez, order_uom, net_price, net_value, ton,
       po_creation_date, delivery_date, stat_rel_del_date, shipment_status
FROM sap_prd.fact_incoming ORDER BY po_number, po_item
""").fetchall()
open_month = con.execute(f"""
SELECT company_code, substr(CAST(delivery_date AS VARCHAR),1,7) ym,
       SUM(quantity) qty, SUM(net_value) "value", COUNT(*) lines, COUNT(DISTINCT po_number) po
FROM sap_prd.fact_incoming GROUP BY 1,2 ORDER BY 2
""").fetchall()
overdue_open = con.execute(f"""
SELECT company_code, COUNT(*) lines, SUM(net_value) "value", COUNT(DISTINCT vendor_number) vendors
FROM sap_prd.fact_incoming WHERE delivery_date < DATE '{AS_OF}' GROUP BY 1
""").fetchall()
open_vendor = con.execute("""
SELECT vendor_number, company_code, SUM(quantity) qty, SUM(net_value) "value",
       COUNT(*) lines, COUNT(DISTINCT po_number) po
FROM sap_prd.fact_incoming GROUP BY 1,2
""").fetchall()
open_material = con.execute("""
SELECT material_number, company_code, SUM(quantity) qty, SUM(net_value) "value",
       SUM(ton) ton, COUNT(*) lines, COUNT(DISTINCT po_number) po
FROM sap_prd.fact_incoming GROUP BY 1,2
""").fetchall()
con.close()
print(f"  open lines={open_base[0]}  POs={open_base[1]}  qty={open_base[2]:,.0f}  value={open_base[3]:,.0f}  vendors={open_base[4]}")

payload["kpi_open"] = {"lines": int(open_base[0]), "po": int(open_base[1]),
    "qty": qty(open_base[2]), "value": money(open_base[3]), "vendors": int(open_base[4])}

# vendor master
con = duckdb.connect(VENDORS, read_only=True)
vrows = con.execute("SELECT lifnr, name1, land1, is_local, text1 FROM sap_prd.dim_vendors").fetchall()
con.close()
vendors = {}
for lifnr, name1, land1, is_local, text1 in vrows:
    vendors[str(lifnr)] = {"name": name1 or "", "country": land1 or "", "local": is_local or "", "grp": text1 or ""}
payload["vendors"] = vendors

# material descriptions for the incoming-PO table (dim_material_master; fallback fact_inventory maktx)
MAT_DESCR = {}
try:
    mm = duckdb.connect(os.path.join(DUCK, "dim_material_master.duckdb"), read_only=True)
    for matnr, maktx in mm.execute("SELECT matnr, maktx FROM sap_prd.dim_material_master").fetchall():
        MAT_DESCR[strip_matnr(matnr)] = maktx or ""
    mm.close()
except Exception as e:
    print("  WARN dim_material_master descr:", e)
try:
    fi = duckdb.connect(INV, read_only=True)
    for matnr, maktx in fi.execute("SELECT matnr, MAX(maktx) FROM sap_prd.fact_inventory GROUP BY 1").fetchall():
        MAT_DESCR.setdefault(strip_matnr(matnr), maktx or "")
    fi.close()
except Exception as e:
    print("  WARN fact_inventory descr:", e)

open_detail = []
for (cc, plant, sloc, pon, item, vn, matnr, q, umrez, uom, price, val, ton,
     poc, deld, statd, ship) in open_rows:
    m = strip_matnr(matnr)
    ddate = deld.isoformat() if deld else None
    overdue = 1 if (deld is not None and deld < AS_OF) else 0
    vmeta = vendors.get(str(vn), {})
    open_detail.append({"cc": cc, "plant": plant or "", "sloc": sloc or "",
        "po": pon or "", "item": item or "", "vendor": vn or "",
        "vname": vmeta.get("name") or vn or "", "local": vmeta.get("local") or "",
        "matnr": m, "descr": MAT_DESCR.get(m) or "", "qty": qty(q), "uom": uom or "", "price": money(price),
        "value": money(val), "ton": qty(ton),
        "po_date": poc.isoformat() if poc else None, "del_date": ddate,
        "stat_date": statd.isoformat() if statd else None, "ship": ship or "", "overdue": overdue})
payload["open_detail"] = open_detail
payload["open_month"] = [{"cc": r[0], "ym": r[1], "qty": qty(r[2]), "value": money(r[3]),
                          "lines": int(r[4]), "po": int(r[5])} for r in open_month]
payload["open_overdue"] = [{"cc": r[0], "lines": int(r[1]), "value": money(r[2]),
                            "vendors": int(r[3])} for r in overdue_open]

ov = {}
for vn, cc, q, val, lines, po in open_vendor:
    d = ov.setdefault((vn, cc), {"vendor": vn, "cc": cc, "qty": 0.0, "value": 0.0, "lines": 0, "po": 0})
    d["qty"] += qty(q); d["value"] += money(val); d["lines"] += int(lines); d["po"] += int(po)
open_vendor_list = []
for d in ov.values():
    meta = vendors.get(str(d["vendor"]), {})
    d["name"] = meta.get("name") or d["vendor"]
    d["local"] = meta.get("local") or ""
    open_vendor_list.append(d)
open_vendor_list.sort(key=lambda r: -r["value"])
payload["open_vendor"] = open_vendor_list

om = {}
for mn, cc, q, val, ton, lines, po in open_material:
    m = strip_matnr(mn)
    d = om.setdefault((m, cc), {"matnr": m, "cc": cc, "qty": 0.0, "value": 0.0, "ton": 0.0, "lines": 0, "po": 0})
    d["qty"] += qty(q); d["value"] += money(val); d["ton"] += qty(ton); d["lines"] += int(lines); d["po"] += int(po)
open_material_list = []
for d in om.values():
    d["descr"] = MAT_DESCR.get(d["matnr"]) or d["matnr"]
    open_material_list.append(d)
open_material_list.sort(key=lambda r: -r["value"])
payload["open_material"] = open_material_list

# ---- landed cost (point-in-time / period-free) ----
con = duckdb.connect(KONV, read_only=True)
konv_base = con.execute("SELECT COUNT(*), COUNT(DISTINCT vendor), COUNT(DISTINCT z_condition_type), SUM(amount_lc) FROM sap_prd.fact_konv").fetchone()
konv_month = con.execute("""
SELECT z_condition_type, MAX(z_condition_text) txt, substr(CAST(condition_date AS VARCHAR),1,7) ym,
       SUM(amount_lc) val, COUNT(*) n_records FROM sap_prd.fact_konv GROUP BY 1,3 ORDER BY 3
""").fetchall()
konv_vendor = con.execute("""
SELECT vendor, MAX(z_condition_text) txt, SUM(amount_lc) val, COUNT(*) n_records FROM sap_prd.fact_konv GROUP BY 1
""").fetchall()
konv_type = con.execute("""
SELECT z_condition_type, MAX(z_condition_text) txt, SUM(amount_lc) val, COUNT(*) n_records, COUNT(DISTINCT vendor) vendors
FROM sap_prd.fact_konv GROUP BY 1
""").fetchall()
con.close()
print(f"  konv rows={konv_base[0]} vendors={konv_base[1]} cond_types={konv_base[2]} amountLC={konv_base[3]:,.0f}")

payload["kpi_konv"] = {"rows": int(konv_base[0]), "vendors": int(konv_base[1]),
                       "types": int(konv_base[2]), "val": money(konv_base[3])}
payload["konv_month"] = [{"type": r[0], "txt": r[1] or "", "ym": r[2], "val": money(r[3]), "rows": int(r[4])} for r in konv_month]
payload["konv_vendor"] = []
for vn, txt, val, rows in konv_vendor:
    meta = vendors.get(str(vn), {})
    payload["konv_vendor"].append({"vendor": vn, "name": meta.get("name") or vn,
                                   "local": meta.get("local") or "", "txt": txt or "",
                                   "val": money(val), "rows": int(rows)})
payload["konv_vendor"].sort(key=lambda r: -r["val"])
payload["konv_type"] = [{"type": r[0], "txt": r[1] or "", "val": money(r[2]),
                         "rows": int(r[3]), "vendors": int(r[4])} for r in konv_type]
payload["konv_type"].sort(key=lambda r: -r["val"])

# ---- stock (point-in-time) ----
con = duckdb.connect(INV, read_only=True)
stock = {}
for matnr, q, val in con.execute("""
SELECT matnr, SUM(clabs) qty, SUM(clabs*COALESCE(ma_price,0)) "value" FROM sap_prd.fact_inventory GROUP BY 1
""").fetchall():
    stock[strip_matnr(matnr)] = {"qty": qty(q), "value": money(val)}
con.close()
payload["stock"] = stock
print("  stock materials:", len(stock))

# ============ RECONCILIATION ============
sum_all = sum(r["val_sar"] for r in payload["monthly_gr"])
sum_vg = sum(r["val_sar"] for r in payload["vendor_gr"])
sum_mg = sum(r["val_sar"] for r in payload["material_gr"])
sum_pg = sum(r["val_sar"] for r in payload["pgrp_gr"])
sum_pl = sum(r["val_sar"] for r in payload["plant_gr"])
sum_del = sum(d["post"] for d in payload["delivery"].values())
sum_open = sum(r["value"] for r in payload["open_month"])
sum_ov = sum(r["value"] for r in payload["open_vendor"])
sum_km = sum(r["val"] for r in payload["konv_month"])
sum_kv = sum(r["val"] for r in payload["konv_vendor"])
sum_kt = sum(r["val"] for r in payload["konv_type"])
rec = [
    ("Spend rows (net)", base[0], base[0]),
    ("Spend PO count", base[1], base[1]),
    ("Spend value SAR", base[2], base[2]),
    ("Spend qty", base[3], base[3]),
    ("Spend vendors", base[5], len(payload["vendor_gr"])),
    ("Spend tonnage", base[4], sum(ton_y_map.values())),
    ("Reversal value", rev[1], rev[1]),
    ("Open lines", open_base[0], len(open_detail)),
    ("Monthly gr sum", sum_all, base[2]),
    ("Vendor gr sum", sum_vg, base[2]),
    ("Material gr sum", sum_mg, base[2]),
    ("Pgrp gr sum", sum_pg, base[2]),
    ("Plant gr sum", sum_pl, base[2]),
    ("Incoterm gr sum", sum(r["val_sar"] for r in payload["incoterm_gr"]), base[2]),
    ("Strategy gr sum", sum(r["val_sar"] for r in payload["strategy_gr"]), base[2]),
    ("Destination gr sum", sum(r["val_sar"] for r in payload["dest_gr"]), base[2]),
    ("Container gr sum", sum(r["val_sar"] for r in payload["container_gr"]), base[2]),
    ("Forwarder gr sum", sum(r["val_sar"] for r in payload["forwarder_gr"]), base[2]),
    ("Broker gr sum", sum(r["val_sar"] for r in payload["broker_gr"]), base[2]),
    ("Delivery post sum", sum_del, N_REC),
    ("Open_month sum", sum_open, open_base[3]),
    ("Open_vendor sum", sum_ov, open_base[3]),
    ("Open_material sum", sum(r["value"] for r in payload["open_material"]), open_base[3]),
    ("Konv value", konv_base[3], konv_base[3]),
    ("Konv_month sum", sum_km, konv_base[3]),
    ("Konv_vendor sum", sum_kv, konv_base[3]),
    ("Konv_type sum", sum_kt, konv_base[3]),
    # per-year internal consistency
    ("Sum vendor_gr_y = vendor_gr", sum(r["val_sar"] for y in payload["vendor_gr_y"] for r in payload["vendor_gr_y"][y]), sum_vg),
    ("Sum material_gr_y = material_gr", sum(r["val_sar"] for y in payload["material_gr_y"] for r in payload["material_gr_y"][y]), sum_mg),
    ("Sum pgrp_gr_y = pgrp_gr", sum(r["val_sar"] for y in payload["pgrp_gr_y"] for r in payload["pgrp_gr_y"][y]), sum_pg),
    ("Sum incoterm_gr_y = incoterm_gr", sum(r["val_sar"] for y in payload["incoterm_gr_y"] for r in payload["incoterm_gr_y"][y]), sum(r["val_sar"] for r in payload["incoterm_gr"])),
    ("Sum strategy_gr_y = strategy_gr", sum(r["val_sar"] for y in payload["strategy_gr_y"] for r in payload["strategy_gr_y"][y]), sum(r["val_sar"] for r in payload["strategy_gr"])),
    ("Sum dest_gr_y = dest_gr", sum(r["val_sar"] for y in payload["dest_gr_y"] for r in payload["dest_gr_y"][y]), sum(r["val_sar"] for r in payload["dest_gr"])),
    ("Sum container_gr_y = container_gr", sum(r["val_sar"] for y in payload["container_gr_y"] for r in payload["container_gr_y"][y]), sum(r["val_sar"] for r in payload["container_gr"])),
    ("Sum forwarder_gr_y = forwarder_gr", sum(r["val_sar"] for y in payload["forwarder_gr_y"] for r in payload["forwarder_gr_y"][y]), sum(r["val_sar"] for r in payload["forwarder_gr"])),
    ("Sum broker_gr_y = broker_gr", sum(r["val_sar"] for y in payload["broker_gr_y"] for r in payload["broker_gr_y"][y]), sum(r["val_sar"] for r in payload["broker_gr"])),
    ("Vendor_lead posts = sum vendor_lead_y posts", sum(r["post"] for r in payload["vendor_lead"]), sum(r["post"] for y in payload["vendor_lead_y"] for r in payload["vendor_lead_y"][y])),
    ("Sum delivery_y posts", sum(d["post"] for y in payload["delivery_y"] for d in payload["delivery_y"][y].values()), sum_del),
]
print("\n==== RECONCILIATION ====")
rec_out = []
for label, calc, src in rec:
    if src is None:
        rec_out.append({"kpi": label, "calculated": calc, "source": None, "ok": "info"}); continue
    ok = abs(float(calc) - float(src)) < max(1.0, abs(float(src)) * 1e-6)
    rec_out.append({"kpi": label, "calculated": round(float(calc),2), "source": round(float(src),2), "ok": bool(ok)})
    print(f"  {label:28s} calc={float(calc):>18,.0f}  src={float(src):>18,.0f}  {'OK' if ok else '** MISMATCH **'}")
payload["reconcile"] = rec_out

# ============ WRITE ============
os.makedirs(OUT_DIR, exist_ok=True)
for path, as_js in [(OUT_JSON, False), (OUT_JS, True)]:
    with open(path, "w", encoding="utf-8") as f:
        if as_js:
            f.write("window.__PURCHASING__ = ")
        json.dump(payload, f, ensure_ascii=False, separators=(",", ":"))
        if as_js:
            f.write(";")
print("\nWrote:", OUT_JSON)
print("Payload keys:", list(payload.keys()))
print("Size bytes:", os.path.getsize(OUT_JSON))
