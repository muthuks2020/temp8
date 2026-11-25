# WnD PO API contract (OneView back-end -> Odoo)

The dashboard runs in demo mode (POs kept in the browser) until `apiBase` is set in `js/config.js`.
With `apiBase: "/api/wnd"` the front-end calls the endpoints below with the signed-in user's session cookie.
The server must **enforce access itself** (a branch user may only see / act on POs of their own branch, a zone user on their zones).

| Call | Purpose | Body | Returns |
|---|---|---|---|
| `GET  {apiBase}/wnd-pos` | POs visible to the user | – | `PO[]`, newest first |
| `POST {apiBase}/wnd-pos` | Raise a PO | PO without `id` | the saved `PO` (with `id`, `odooRef`) |
| `POST {apiBase}/wnd-pos/{id}/{action}` | `approve`, `reject`, `dispatch`, `receive`, `cancel` | `{ "note": "" }` | the updated `PO` |

```json
PO = {
  "id": "WND-2611-0001",
  "type": "transfer | return | replenish",
  "from": 5,            // branch index in data/meta.js (branches[]), or 100 = Central warehouse, 101 = Production plant
  "to": 12,
  "lines": [ { "s": 331, "q": 19, "ov": 0, "ref": "PO-2026-1187" } ],   // s = SKU index (meta.js skus[]), q = qty, ov = units that needed the donor's OK, ref = customer PO
  "status": "Requested | Approved | In transit | Received | Rejected | Cancelled",
  "odooRef": "S01234",  // set by the server once the Odoo document exists
  "created": "2026-11-20T09:15:00Z", "createdBy": "Bihar branch",
  "history": [ { "st": "Requested", "at": "2026-11-20T09:15:00Z", "by": "Bihar branch", "note": "" } ]
}
```

## Suggested mapping to Odoo 19
| WnD PO type | Odoo document |
|---|---|
| `transfer` (branch -> branch) | Internal transfer / inter-warehouse resupply (route via Inter-warehouse transit) |
| `return` (branch -> Central / Plant) | Return transfer to the central warehouse / plant location |
| `replenish` (Central -> branch) | Purchase request / replenishment (reordering rule up to Max) |

Status changes should follow the Odoo picking state: Approved = confirmed, In transit = delivery validated at the sender, Received = receipt validated.

## Rules the front-end already applies
- Open POs (Requested, Approved, In transit) count as **incoming** for the receiving branch and **committed** for the sending branch.
- A planner move that already has an open PO between the same two branches is no longer shown as planned.
- Who may act: the sending branch approves and dispatches a branch transfer, the receiving branch confirms receipt. Returns and purchases are approved by head office (Central). The requester can cancel.
- The front-end is a convenience: the server must re-check every action.
