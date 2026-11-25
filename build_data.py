#!/usr/bin/env python3
"""
Build the SKU Finder dashboard data files from the IOL Redistribution & Reorder workbook.

Usage:
    python3 build_data.py "IOL_Redistribution__Reorder_Tool.xlsx" [out_dir]

Output (default ./data):
    meta.js        branches, zones, SKU catalogue, enums, months   (non-sensitive, loaded by everyone)
    zone-<n>.js    one file per zone: stock/sales rows, suggested moves, monthly model sales
                   (a zone user only ever downloads their own file)

Re-run this whenever the workbook is refreshed.
"""
import sys, json, collections, os, re, math
import openpyxl

SRC = sys.argv[1]
OUT = sys.argv[2] if len(sys.argv) > 2 else os.path.join(os.path.dirname(os.path.abspath(__file__)), "data")
os.makedirs(OUT, exist_ok=True)

wb = openpyxl.load_workbook(SRC, data_only=True, read_only=True)


def table(name):
    it = wb[name].iter_rows(values_only=True)
    hdr = next(it)
    return hdr, [r for r in it if any(v is not None for v in r)]


def num(v, nd=6):
    if v is None or v == "":
        return 0
    try:
        f = float(v)
    except (TypeError, ValueError):
        return 0
    f = round(f, nd)
    return int(f) if f == int(f) else f


# ---------------------------------------------------------------- Settings
ws = wb["Settings"]
settings = {
    "shortMoh": num(ws["C5"].value),
    "minMonths": num(ws["C6"].value),
    "maxMonths": num(ws["C7"].value),
    "minDemand": num(ws["C8"].value),
}

# ---------------------------------------------------------------- Data (branch x SKU)
_, data = table("Data")
ix = {n: i for i, n in enumerate(
    ["branch", "zone", "model", "sku", "family", "oct24", "oct25", "oct25_126", "octmtd", "l3m", "l6m", "l12m", "a24m",
     "trend", "yoy6", "demand", "onhand", "reserved", "free", "transferable", "moh", "status", "pendingCentral",
     "receive", "send", "after", "reorder", "key", "l12mTot", "p12mTot", "openPO", "oldPO"])}

branches = {}
for r in data:
    branches[r[0]] = r[1]
# the SKU Finder sheet fixes the branch list / order (36 branches)
sf = wb["SKU Finder"]
sf_branches = []
for row in sf.iter_rows(min_row=14, max_row=49, min_col=2, max_col=3, values_only=True):
    if row[0]:
        sf_branches.append((row[0], row[1]))
def slug(name):
    return re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")


branch_list = [{"name": b, "zone": z, "slug": slug(b)} for b, z in sf_branches]
for b, z in branches.items():  # safety: anything in Data but not on the sheet
    if b not in dict(sf_branches):
        branch_list.append({"name": b, "zone": z, "slug": slug(b)})
b_idx = {b["name"]: i for i, b in enumerate(branch_list)}
zones = sorted({b["zone"] for b in branch_list})

# SKU catalogue (Lists sheet: C = model, D = SKU) + family from Data
fam = {}
pend = {}
for r in data:
    if r[4]:
        fam[r[3]] = r[4]
    if r[3] not in pend:
        pend[r[3]] = num(r[22])
cat = []
seen = set()
ws = wb["Lists"]  # no header row
for row in ws.iter_rows(min_row=1, values_only=True):
    model, sku = row[2], row[3]
    if model and sku and sku not in seen:
        seen.add(sku)
        cat.append((model, sku))
# SKUs present in Data but not in Lists
for r in data:
    if r[3] not in seen:
        seen.add(r[3])
        cat.append((r[2], r[3]))
models = sorted({m for m, _ in cat})
m_idx = {m: i for i, m in enumerate(models)}
cat.sort(key=lambda t: (t[0], t[1]))
sku_idx = {s: i for i, (_, s) in enumerate(cat)}

# pending central is a per-SKU value -> verify
chk = collections.defaultdict(set)
for r in data:
    chk[r[3]].add(num(r[22]))
bad = [k for k, v in chk.items() if len(v) > 1]
assert not bad, f"Pending PO central is not constant per SKU: {bad[:3]}"

TRENDS = ["Growing", "Stable", "Declining", "New / revived", "Stopped", "No recent sales"]
STATUSES = ["Shortage", "Short - covered by open PO", "Healthy", "Excess", "Non-moving", "No free stock", "No activity"]
t_idx = {t: i for i, t in enumerate(TRENDS)}
s_idx = {s: i for i, s in enumerate(STATUSES)}
unk_t = {r[13] for r in data} - set(TRENDS)
unk_s = {r[21] for r in data} - set(STATUSES)
assert not unk_t and not unk_s, (unk_t, unk_s)

# ---------------------------------------------------------------- Move List
_, moves = table("Move List")
PRI = sorted({m[0] for m in moves})
p_idx = {p: i for i, p in enumerate(PRI)}

# ---------------------------------------------------------------- MonthlyData (branch x model)
mh, monthly = table("MonthlyData")
months = [str(h) for h in mh[2:33]]  # Apr-24 .. Oct-26 (31 months; Oct-26 is MTD to 26 Oct)

meta = {
    "generated": "from workbook, FG stock 04 Nov 2026, sales to 26 Oct 2026",
    "settings": settings,
    "zones": zones,
    "branches": branch_list,
    "models": models,
    "skus": [[s, m_idx[m], fam.get(s, ""), pend.get(s, 0)] for m, s in cat],
    "trends": TRENDS,
    "statuses": STATUSES,
    "priorities": PRI,
    "months": months,
}
with open(os.path.join(OUT, "meta.js"), "w") as f:
    f.write("window.OV_META=" + json.dumps(meta, separators=(",", ":")) + ";\n")

# ---------------------------------------------------------------- scope files (zone files + one file per branch)
sizes = {}
unmapped = collections.defaultdict(int)
no_model = collections.defaultdict(int)
seen_unmapped = set()


def scope_blob(key, names):
    """rows / moves / monthly for a set of branch names (a zone, or a single branch)."""
    rows = []
    for r in data:
        if r[0] not in names:
            continue
        nums = [r[5], r[6], r[7], r[8], r[9], r[11], r[15], r[18], r[17], r[30]]
        if all((v in (None, 0)) for v in nums) and not r[16] and not r[22] and not r[31]:
            continue  # completely empty row == "-" on the sheet
        # row layout (kept in sync with js/app.js):
        # 0 branch, 1 sku, 2 oct24, 3 oct25, 4 oct25(1-26), 5 oct26 MTD, 6 avg L3M, 7 avg L12M,
        # 8 trend, 9 demand/month, 10 free stock, 11 open orders (reserved), 12 status, 13 open PO to branch
        rows.append([
            b_idx[r[0]], sku_idx[r[3]],
            num(r[5]), num(r[6]), num(r[7]), num(r[8]),
            num(r[9]), num(r[11]),
            t_idx[r[13]],
            num(r[15]),
            num(r[18]), num(r[17]),
            s_idx[r[21]],
            num(r[30]),
        ])
    mv = []
    for m in moves:
        if m[3] not in names and m[8] not in names:
            continue
        mv.append([
            p_idx[m[0]], sku_idx[m[1]], b_idx[m[3]], num(m[5]), num(m[6]), t_idx.get(m[7], 1),
            b_idx[m[8]], num(m[10]), num(m[11]), num(m[12]), num(m[13]), t_idx.get(m[14], 1),
            num(m[15]), 1 if m[16] == "Yes" else 0,
        ])
    mo = []
    for r in monthly:
        if r[0] not in names or r[1] not in m_idx:
            continue
        mo.append([b_idx[r[0]], m_idx[r[1]]] + [num(v) for v in r[2:33]])
    return {"key": key, "rows": rows, "moves": mv, "monthly": mo}


def write_scope(key, fname, names):
    blob = scope_blob(key, names)
    path = os.path.join(OUT, fname)
    with open(path, "w") as f:
        f.write("(window.OV_DATA=window.OV_DATA||{})[%s]=%s;\n" % (json.dumps(key), json.dumps(blob, separators=(",", ":"))))
    return len(blob["rows"]), len(blob["moves"]), len(blob["monthly"]), os.path.getsize(path)


for r in monthly:   # report what the dashboard leaves out (counted once)
    tot_ = sum(num(v) for v in r[2:33])
    if r[0] not in b_idx:
        unmapped[r[0]] += tot_            # branch with sales but no zone / stock mapping
    elif r[1] not in m_idx:
        no_model[r[1]] += tot_            # model not in the SKU catalogue (not in the stock plan)
for z in zones:
    names = {b["name"] for b in branch_list if b["zone"] == z}
    sizes[z] = write_scope(z, "zone-" + z.split("-")[1] + ".js", names)
bsizes = []
for b in branch_list:
    bsizes.append(write_scope("B:" + b["slug"], "branch-" + b["slug"] + ".js", {b["name"]}))

# ---------------------------------------------------------------- stock files (quantities only, for "where can I get it?")
# Donor view needs stock quantities from OTHER branches but none of their sales.
#   row : 0 branch, 1 sku, 2 on hand, 3 reserved, 4 free (sellable), 5 transferable (180+ days shelf life),
#         6 spare (what the donor can release and still keep Max months of its own demand; non-moving = all),
#         7 status, 8 MOH
#   moves: [sku, from, to, qty]  planned moves whose FROM branch is in this zone (already earmarked stock)
send_by = collections.defaultdict(float)
for m in moves:
    send_by[(m[3], m[1])] += float(m[15] or 0)
viol = 0
chk_rows = 0
stock_sizes = {}
maxM = settings["maxMonths"]
neg_gap = 0
t_gt_free = 0
for z in zones:
    names = {b["name"] for b in branch_list if b["zone"] == z}
    srows = []
    for r in data:
        if r[0] not in names:
            continue
        onhand, resv, free, T = num(r[16]), num(r[17]), num(r[18]), num(r[19])
        if onhand <= 0 and free <= 0 and T <= 0:
            continue
        dem = num(r[15])
        mx = math.ceil(round(dem * maxM, 9))
        spare = T if r[21] == "Non-moving" else min(T, max(0, free - mx))
        chk_rows += 1
        if send_by.get((r[0], r[3]), 0) > spare + 1e-9:
            viol += 1
        if onhand - resv - free < -1e-9:
            neg_gap += 1
        if T > free + 1e-9:
            t_gt_free += 1
        srows.append([b_idx[r[0]], sku_idx[r[3]], onhand, resv, free, T, spare, s_idx[r[21]],
                      None if r[20] is None else round(float(r[20]), 1)])
    smoves = [[sku_idx[m[1]], b_idx[m[3]], b_idx[m[8]], num(m[15])] for m in moves if m[3] in names]
    path = os.path.join(OUT, "stock-" + z.split("-")[1] + ".js")
    with open(path, "w") as f:
        f.write("(window.OV_STOCK=window.OV_STOCK||{})[%s]=%s;\n" % (json.dumps(z), json.dumps({"zone": z, "rows": srows, "moves": smoves}, separators=(",", ":"))))
    stock_sizes[z] = (len(srows), len(smoves), os.path.getsize(path))
print("CHECK planner Send > donor spare:", viol, "of", chk_rows, "stock rows (expect 0)")
print("CHECK on hand - reserved < free (free exceeds sellable maths):", neg_gap, "| transferable > free:", t_gt_free)

print("UNMAPPED branches in MonthlyData (excluded):", dict(unmapped))
print("Models in MonthlyData but not in SKU catalogue (excluded):", dict(no_model))
print("settings", settings)
print("branches", len(branch_list), "zones", zones, "skus", len(cat), "models", len(models))
for z, s in sizes.items():
    print(z, "rows=%d moves=%d monthly=%d  %.0f KB" % (s[0], s[1], s[2], s[3] / 1024), "| stock rows=%d moves=%d %.0f KB" % (stock_sizes[z][0], stock_sizes[z][1], stock_sizes[z][2] / 1024))
print("branch files:", len(bsizes), "avg %.0f KB, max %.0f KB" % (sum(b[3] for b in bsizes) / len(bsizes) / 1024, max(b[3] for b in bsizes) / 1024))
print("meta.js %.0f KB" % (os.path.getsize(os.path.join(OUT, "meta.js")) / 1024))
