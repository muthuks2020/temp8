/* ------------------------------------------------------------------
   WnD (Warehouse & Distribution) - runtime configuration
   ------------------------------------------------------------------
   A user is one of:
     branch manager : { branch: "Bihar" }        sees own branch in detail
     zone manager   : { zones: ["Zone-3"] }      sees the zone's branches in detail
     head office    : { zones: ["*"] }           sees everything
   In production OneView injects this from the signed-in user (SSO / JWT)
   AND serves only the data files that user is entitled to:
     branch manager -> data/branch-<slug>.js   (+ stock files, see below)
     zone manager   -> data/zone-N.js          (+ stock files)
     head office    -> all data/zone-N.js      (+ stock files)
   The browser only requests those files, so a branch manager never
   receives another branch's sales or demand.

   stockVisibility - "Where can I get it?" needs STOCK QUANTITIES in other
   branches (no sales, no demand):
     "network" : every user sees stock quantities at all branches (default;
                 this is what lets a branch manager find stock lying elsewhere)
     "zone"    : users only see stock in their own zone(s)

   demo:true shows a "Preview as" switcher. Set demo:false before go-live.
------------------------------------------------------------------- */
window.OV_CONFIG = {
  demo: true,
  dataPath: "data/",
  logo: "",                          // optional: e.g. "assets/logo.png" (white-box header logo, ~32px tall)
  stockVisibility: "network",        // "network" | "zone"
  user: { name: "Muthu", email: "muthu.balakrishnan@appasamy.com", zones: ["*"] },
  previewUsers: [
    { id: "admin",     label: "HO / Admin (all zones)",        name: "Muthu",          email: "muthu.balakrishnan@appasamy.com", zones: ["*"] },
    { id: "zone-1",    label: "Zone-1 manager",                name: "Zone-1 manager", email: "zone1@appasamy.com", zones: ["Zone-1"] },
    { id: "zone-2",    label: "Zone-2 manager",                name: "Zone-2 manager", email: "zone2@appasamy.com", zones: ["Zone-2"] },
    { id: "zone-3",    label: "Zone-3 manager",                name: "Zone-3 manager", email: "zone3@appasamy.com", zones: ["Zone-3"] },
    { id: "zone-4",    label: "Zone-4 manager",                name: "Zone-4 manager", email: "zone4@appasamy.com", zones: ["Zone-4"] },
    { id: "zone-5",    label: "Zone-5 manager",                name: "Zone-5 manager", email: "zone5@appasamy.com", zones: ["Zone-5"] },
    { id: "zone-6",    label: "Zone-6 manager",                name: "Zone-6 manager", email: "zone6@appasamy.com", zones: ["Zone-6"] },
    { id: "bm-chennai",   label: "Branch manager · Chennai (Z1)",   name: "Chennai branch",   email: "chennai@appasamy.com",   branch: "Chennai" },
    { id: "bm-bangalore", label: "Branch manager · Bangalore (Z2)", name: "Bangalore branch", email: "bangalore@appasamy.com", branch: "Bangalore" },
    { id: "bm-bihar",     label: "Branch manager · Bihar (Z3)",     name: "Bihar branch",     email: "bihar@appasamy.com",     branch: "Bihar" },
    { id: "bm-pune",      label: "Branch manager · Pune (Z4)",      name: "Pune branch",      email: "pune@appasamy.com",      branch: "Pune" },
    { id: "bm-lucknow",   label: "Branch manager · Lucknow (Z5)",   name: "Lucknow branch",   email: "lucknow@appasamy.com",   branch: "Lucknow" },
    { id: "bm-ahmedabad", label: "Branch manager · Ahmedabad (Z6)", name: "Ahmedabad branch", email: "ahmedabad@appasamy.com", branch: "Ahmedabad" }
  ],
  // Only head office may change stock norms (Min / Max months, min demand to reorder)
  adminCanEditNorms: true,
  defaultSku: "NON PRELOADED HYDROPHOBIC INTRA OCULAR LENS SPNT300 (30)",
  // WnD PO: where the data goes. Leave apiBase empty for the local demo (POs stay in this browser).
  // With apiBase set, OneView's back-end creates the document in Odoo (see API.md).
  apiBase: "",
  // Expected days for stock to reach the requesting branch (shown as an estimated arrival date)
  leadDays: { same: 1, cross: 3, central: 5 },
  centralNodes: { 100: "Central warehouse", 101: "Production plant" },
  shelfDays: 180,                    // transfer rule used by the planner (batches with >= 180 days shelf life)
  stockAsOf: "04 Nov 2026",
  salesTo: "26 Oct 2026"
};
