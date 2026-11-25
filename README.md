# One View · IOL Redistribution · SKU Finder + WnD POs (v3)

Static HTML + CSS + JavaScript. No build step. Open `index.html` (or serve the folder).

## What it does (from the Customer Operations requirement)
Branch-wise demand planning per SKU, and **WnD (Warehouse & Distribution) POs** between branches.

| Page | Use |
|---|---|
| **SKU Finder** | A customer PO comes in: can my branch serve it? If not, which branches can release stock (same zone first, 180+ days shelf life, donor keeps its own cover), estimated arrival, same-model alternatives, purchase request for what the network cannot cover. Multi-SKU PO check. Zone / head-office planning view below. |
| **Branch View** | All SKUs of one branch with every requirement column (sales Oct-24 / Oct-25 / Oct-26 MTD, Avg L3M / L12M, trend, demand, Min, Max, free stock, open orders, MOH, status, receive, send, stock after moves, reorder qty, open PO to branch, WnD PO in). Tabs: Needs stock / Excess & ageing / All. **Create PO** for shortages; **Return** (to Central warehouse or Production plant) for excess, non-moving or short-dated stock. |
| **Move List** | The planner's suggested branch-to-branch moves with one-click PO. |
| **Reorder List** | SKUs below Min; purchase request up to Max (Central -> branch). |
| **WnD POs** | Tracker: Requested -> Approved -> In transit -> Received (or Rejected / Cancelled), awaiting-me list, overdue flag, history, Odoo reference. |

WnD PO types: **Branch transfer**, **Return** (to Central / Plant), **Replenishment** (purchase from Central).
Open POs count as incoming for the receiver and committed for the sender, and duplicates are flagged before a new PO is raised.

## Roles (js/config.js)
Branch manager (`branch: "Bihar"`), zone manager (`zones: ["Zone-3"]`), head office (`zones: ["*"]`).
Branch users only download their own branch file (`data/branch-<slug>.js`) plus stock quantities (`stockVisibility: "network"` lets them find donors; `"zone"` restricts it).
Set `demo: false` and feed `user` from OneView login before go-live. Browser-side scoping is not security: serve data files per user on the server.

## Odoo / OneView connection
`apiBase` empty = demo (POs stored in the browser, shared across Preview-as users).
Set `apiBase` to your OneView endpoint to create real POs in Odoo. The contract is in `API.md`. `leadDays` in config sets the estimated arrival (same zone, cross-zone, Central).

## Rebuild data
`python3 -I build_data.py "<IOL Redistribution workbook>.xlsx" [out_dir]` regenerates `data/`.

## Known points
- Own-branch shelf life is only known as "180+ days" in total: check batch expiry in Odoo before confirming.
- Reorder uses `demand >= 0.5` as in the SKU Finder sheet (the pipeline uses `>`): 16 SKU-branch cells differ by 1 unit at exactly 0.5 demand.
- Azhiyur has sales but no zone / stock mapping (3,103 units) and is excluded.
- "Declining" in the workbook is shown as "Degrowing" (wording of the requirement).
