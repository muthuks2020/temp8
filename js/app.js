/* =====================================================================
   SKU Finder dashboard - application logic
   Mirrors the 'SKU Finder' sheet of the IOL Redistribution & Reorder Tool.

   Row layout in data/zone-N.js  (kept in sync with build_data.py)
     rows : 0 branch, 1 sku, 2 oct24, 3 oct25, 4 oct25(1-26), 5 oct26 MTD, 6 avg L3M, 7 avg L12M,
            8 trend, 9 demand/month, 10 free stock, 11 open orders, 12 status, 13 open PO to branch
     moves: 0 priority, 1 sku, 2 from branch, 3 from free, 4 from MOH, 5 from trend,
            6 to branch, 7 to free, 8 to open orders, 9 to demand, 10 to MOH, 11 to trend, 12 qty, 13 same zone
     monthly: [branch, model, 31 monthly values Apr-24 .. Oct-26]
   ===================================================================== */
/* =====================================================================
   SKU Finder dashboard - application logic (v2: branch-manager workflow)
   1. Order check   : can my branch serve this PO from free stock?
   2. Where from    : which branches can release stock (180+ days shelf life, donor keeps its own cover)
   3. DC request    : build the inter-branch DC lines, copy / download
   Planning view    : the original SKU Finder sheet (KPIs, branch position, planner moves)

   Row layout in data/zone-N.js and data/branch-<slug>.js (kept in sync with build_data.py)
     rows : 0 branch, 1 sku, 2 oct24, 3 oct25, 4 oct25(1-26), 5 oct26 MTD, 6 avg L3M, 7 avg L12M,
            8 trend, 9 demand/month, 10 free stock, 11 open orders (reserved), 12 status, 13 open PO to branch
     moves: 0 priority, 1 sku, 2 from branch, 3 from free, 4 from MOH, 5 from trend,
            6 to branch, 7 to free, 8 to open orders, 9 to demand, 10 to MOH, 11 to trend, 12 qty, 13 same zone
     monthly: [branch, model, 31 monthly values Apr-24 .. Oct-26]
   Row layout in data/stock-N.js (quantities only)
     rows : 0 branch, 1 sku, 2 on hand, 3 reserved, 4 free (sellable), 5 transferable (180+ days),
            6 spare (donor keeps Max months; non-moving = all), 7 status, 8 MOH
     moves: [sku, from, to, qty]  planned moves out of this zone's branches
   ===================================================================== */
(function () {
  "use strict";
  var M = window.OV_META, CFG = window.OV_CONFIG, CH = window.OVCharts;
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var N0 = new Intl.NumberFormat("en-IN", { maximumFractionDigits: 0 });
  var N1 = new Intl.NumberFormat("en-IN", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  var DASH = "–";
  function esc(s) { return String(s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }
  function i0(v) { return v ? N0.format(Math.round(v)) : DASH; }
  function n0(v) { return N0.format(Math.round(v)); }
  function d1(v) { return N1.format(v); }
  function pct(v) { return (v >= 0 ? "+" : "") + Math.round(v * 100) + "%"; }
  // Excel ROUNDUP(x,0) for positive numbers, tolerant of binary float noise
  function roundUp(x) { return Math.ceil(Math.round(x * 1e9) / 1e9); }
  function plural(n, one, many) { return n + " " + (n === 1 ? one : many); }

  var ST_RANK = [0, 1, 3, 4, 5, 2, 6];       // sort severity by status index; unknown = 7
  var ST_SHORT = ["Shortage", "Covered by PO", "Healthy", "Excess", "Non-moving", "No free stock", "No activity"];
  var ST_COLOR = ["#C62828", "#F57C00", "#43A047", "#1565C0", "#9AA5B5", "#E57373", "#DDE3EF"];
  var DRAFT_KEY = "ov_skufinder_dc_draft:";

  var CENTRAL = CFG.centralNodes || { 100: "Central warehouse", 101: "Production plant" };
  M.trends = M.trends.map(function (t) { return t === "Declining" ? "Degrowing" : t; });
  var Store = window.OVStore;
  function isCentral(n) { return n >= 100; }
  function nname(n) { return isCentral(n) ? CENTRAL[n] : M.branches[n].name; }
  function nzone(n) { return isCentral(n) ? "Central" : M.branches[n].zone; }
  function typeOf(f, t) { return isCentral(t) ? "return" : isCentral(f) ? "replenish" : "transfer"; }
  var TYPE_LABEL = { transfer: "Branch transfer", "return": "Return", replenish: "Replenishment" };
  function leadDays(f, t) {
    var L = CFG.leadDays || {};
    return isCentral(f) || isCentral(t) ? (L.central || 5) : M.branches[f].zone === M.branches[t].zone ? (L.same || 1) : (L.cross || 3);
  }
  function etaDate(days) { var d = new Date(); d.setDate(d.getDate() + days); return d.toLocaleDateString("en-GB", { day: "2-digit", month: "short" }); }
  function dayWord(n) { return "~" + n + (n === 1 ? " day" : " days"); }

  var S = {
    user: null, role: "admin", zones: [], visible: new Set(), dataKeys: [], stockZones: [], zoneFilter: "all",
    sku: -1, model: -1, selBranch: -1, branch: -1, qty: 0,
    norms: { min: M.settings.minMonths, max: M.settings.maxMonths, dem: M.settings.minDemand },
    sort: { k: "sev", d: 1 }, hideInactive: false, trendMode: "fy",
    bySku: new Map(), movesBySku: new Map(), monthly: new Map(), active: new Set(),
    stock: new Map(), stockMoves: new Map(), draft: [], alloc: null,
    skusByModel: [], lastRecords: [], view: "finder", ready: false, bulk: []
  };
  M.models.forEach(function () { S.skusByModel.push([]); });
  M.skus.forEach(function (s, i) { S.skusByModel[s[1]].push(i); });
  var skuIndex = new Map(M.skus.map(function (s, i) { return [s[0], i]; }));
  function branchIdx(name) { for (var i = 0; i < M.branches.length; i++) if (M.branches[i].name === name) return i; return -1; }
  function bname(i) { return M.branches[i].name; }

  /* ------------------------------------------------------------ user / access */
  function userById(id) {
    var list = CFG.previewUsers || [];
    for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
    return null;
  }
  function resolveUser() {
    var u = Object.assign({}, CFG.user);
    if (CFG.demo) {
      var as = new URLSearchParams(location.search).get("as");
      var p = as && userById(as);
      if (p) u = Object.assign({}, p);
    }
    return u;
  }
  function setScope(u) {
    var bi = u.branch ? branchIdx(u.branch) : -1;
    if (bi >= 0) {
      S.role = "branch"; S.zones = [M.branches[bi].zone]; S.visible = new Set([bi]); S.dataKeys = ["B:" + M.branches[bi].slug];
    } else {
      var all = (u.zones || []).indexOf("*") >= 0;
      S.role = all ? "admin" : "zone";
      S.zones = all ? M.zones.slice() : (u.zones || []).filter(function (x) { return M.zones.indexOf(x) >= 0; });
      S.visible = new Set();
      M.branches.forEach(function (b, i) { if (S.zones.indexOf(b.zone) >= 0) S.visible.add(i); });
      S.dataKeys = S.zones.slice();
    }
    S.stockZones = CFG.stockVisibility === "zone" ? S.zones.slice() : M.zones.slice();
  }
  function isAdmin() { return S.role === "admin"; }
  function scopeLabel() {
    if (S.zoneFilter !== "all") return S.zoneFilter;
    if (S.role === "admin") return "Network";
    if (S.role === "branch") return bname(Array.from(S.visible)[0]);
    return S.zones.length === 1 ? S.zones[0] : "Your zones";
  }
  function scopeBranches() {
    var out = [];
    M.branches.forEach(function (b, i) {
      if (!S.visible.has(i)) return;
      if (S.zoneFilter !== "all" && b.zone !== S.zoneFilter) return;
      out.push(i);
    });
    return out;
  }

  /* ------------------------------------------------------------ data loading */
  function loadScript(src) {
    return new Promise(function (res, rej) {
      var s = document.createElement("script");
      s.src = src; s.onload = res;
      s.onerror = function () { rej(new Error("Could not load " + src)); };
      document.head.appendChild(s);
    });
  }
  function fileFor(key) { return key.indexOf("B:") === 0 ? "branch-" + key.slice(2) + ".js" : "zone-" + key.split("-")[1] + ".js"; }
  function ensureData() {
    window.OV_DATA = window.OV_DATA || {}; window.OV_STOCK = window.OV_STOCK || {};
    var jobs = [];
    S.dataKeys.forEach(function (k) { if (!window.OV_DATA[k]) jobs.push(loadScript(CFG.dataPath + fileFor(k))); });
    S.stockZones.forEach(function (z) { if (!window.OV_STOCK[z]) jobs.push(loadScript(CFG.dataPath + "stock-" + z.split("-")[1] + ".js")); });
    return Promise.all(jobs);
  }
  function buildIndex() {
    S.bySku = new Map(); S.movesBySku = new Map(); S.monthly = new Map(); S.active = new Set();
    S.stock = new Map(); S.stockMoves = new Map();
    var seen = new Set();   // cross-zone moves sit in two zone files: keep each once
    S.dataKeys.forEach(function (k) {
      var d = window.OV_DATA[k];
      d.rows.forEach(function (r) {
        var m = S.bySku.get(r[1]); if (!m) { m = new Map(); S.bySku.set(r[1], m); }
        m.set(r[0], r);
        if (r[10] > 0 || r[9] > 0 || r[2] || r[3] || r[5] || r[13]) S.active.add(r[1]);
      });
      var keys = [];
      d.moves.forEach(function (mv) {
        var key = mv.join("|"); if (seen.has(key)) return;
        keys.push(key);
        var a = S.movesBySku.get(mv[1]); if (!a) { a = []; S.movesBySku.set(mv[1], a); }
        a.push(mv);
      });
      keys.forEach(function (x) { seen.add(x); });
      d.monthly.forEach(function (r) {
        var a = S.monthly.get(r[1]); if (!a) { a = []; S.monthly.set(r[1], a); }
        a.push(r);
      });
    });
    S.stockZones.forEach(function (z) {
      var d = window.OV_STOCK[z];
      d.rows.forEach(function (r) {
        var m = S.stock.get(r[1]); if (!m) { m = new Map(); S.stock.set(r[1], m); }
        m.set(r[0], r);
        if (r[4] > 0) S.active.add(r[1]);
      });
      d.moves.forEach(function (mv) {
        var a = S.stockMoves.get(mv[0]); if (!a) { a = []; S.stockMoves.set(mv[0], a); }
        a.push([mv[1], mv[2], mv[3]]);          // from, to, qty
      });
    });
  }

  /* ---- open WnD POs: stock already committed or on its way ---- */
  var wnd = { dirty: true, inn: new Map(), out: new Map(), pair: new Map(), to: new Map() };
  Store.onChange(function () { wnd.dirty = true; });
  function wndBuild() {
    if (!wnd.dirty) return;
    wnd.dirty = false; wnd.inn = new Map(); wnd.out = new Map(); wnd.pair = new Map(); wnd.to = new Map();
    var add = function (m, k, q) { m.set(k, (m.get(k) || 0) + q); };
    Store.all().forEach(function (p) {
      if (!Store.isOpen(p)) return;
      p.lines.forEach(function (l) {
        if (!isCentral(p.to)) { add(wnd.inn, l.s + "|" + p.to, l.q); var a = wnd.to.get(l.s + "|" + p.to) || []; a.push({ id: p.id, q: l.q, status: p.status, from: p.from }); wnd.to.set(l.s + "|" + p.to, a); }
        if (!isCentral(p.from)) add(wnd.out, l.s + "|" + p.from, l.q);
        add(wnd.pair, l.s + "|" + p.from + "|" + p.to, l.q);
      });
    });
  }
  function wndIn(s, b) { wndBuild(); return wnd.inn.get(s + "|" + b) || 0; }
  function wndOut(s, b) { wndBuild(); return wnd.out.get(s + "|" + b) || 0; }
  function wndPair(s, f, t) { wndBuild(); return wnd.pair.get(s + "|" + f + "|" + t) || 0; }
  function wndPosTo(s, b) { wndBuild(); return wnd.to.get(s + "|" + b) || []; }
  // A planner move that already has an open WnD PO is no longer "planned": the PO carries it.
  function netter(skuI) {
    var left = {};
    return function (f, t, q) {
      var k = f + ">" + t; if (left[k] == null) left[k] = wndPair(skuI, f, t);
      var cut = Math.min(q, left[k]); left[k] -= cut; return q - cut;
    };
  }
  function movesRemaining(skuI) {          // Map(move -> units still to be moved)
    var net = netter(skuI), out = new Map();
    (S.movesBySku.get(skuI) || []).forEach(function (m) { out.set(m, net(m[2], m[6], m[12])); });
    return out;
  }

  /* ------------------------------------------------------------ calculations (= SKU Finder formulas) */
  function moveTotals(skuI) {
    var recv = {}, send = {};
    movesRemaining(skuI).forEach(function (q, m) { recv[m[6]] = (recv[m[6]] || 0) + q; send[m[2]] = (send[m[2]] || 0) + q; });
    return { recv: recv, send: send };
  }
  function makeRecord(b, by, recv, send, skuI) {
    var N = S.norms, r = by.get(b), br = M.branches[b];
    var o = { b: b, name: br.name, zone: br.zone, has: !!r, sku: skuI,
      oct24: r ? r[2] : 0, oct25: r ? r[3] : 0, oct25ly: r ? r[4] : 0, mtd: r ? r[5] : 0,
      l3m: r ? r[6] : 0, l12m: r ? r[7] : 0, trend: r ? r[8] : -1, demand: r ? r[9] : 0,
      free: r ? r[10] : 0, open: r ? r[11] : 0, status: r ? r[12] : -1, po: r ? r[13] : 0 };
    o.min = roundUp(o.demand * N.min);                       // K = ROUNDUP(J * Settings!C6)
    o.max = roundUp(o.demand * N.max);                       // L = ROUNDUP(J * Settings!C7)
    o.moh = o.demand > 0 ? o.free / o.demand : null;         // O = IF(J>0, M/J, "")
    o.recv = recv[b] || 0; o.send = send[b] || 0;            // Q / R from the Move List
    o.after = o.free + o.recv - o.send;                      // S = M + Q - R
    o.wndIn = skuI == null ? 0 : wndIn(skuI, b); o.wndOut = skuI == null ? 0 : wndOut(skuI, b);   // open WnD POs
    var eff = o.after + o.po + o.wndIn - o.wndOut;
    o.reorder = (o.demand >= N.dem && eff < o.min) ? Math.max(0, o.max - eff) : 0;   // T
    o.inactive = !o.has || (!o.free && !o.demand && !o.oct24 && !o.oct25 && !o.mtd && !o.po && !o.open && !o.wndIn);
    return o;
  }
  function records() {
    var by = S.bySku.get(S.sku) || new Map(), t = moveTotals(S.sku);
    return scopeBranches().map(function (b) { return makeRecord(b, by, t.recv, t.send, S.sku); });
  }
  function sum(R, f) { var t = 0; R.forEach(function (r) { t += f(r); }); return t; }
  function movesInScope() {
    var set = new Set(scopeBranches());
    return (S.movesBySku.get(S.sku) || []).filter(function (m) { return set.has(m[2]) || set.has(m[6]); });
  }

  /* ------------------------------------------------------------ rendering */
  function powerLabel(sku) {
    var m = sku.match(/\(([^)]*)\)\s*$/);
    if (!m) return sku;
    var t = m[1].trim();
    if (/^[-+]?\d+(\.\d+)?$/.test(t)) { var v = parseFloat(t); return (v > 0 ? "+" : "") + v.toFixed(1) + " D"; }
    return t;
  }
  function powerKey(sku) {
    var m = sku.match(/\(([^)]*)\)\s*$/); var v = m ? parseFloat(m[1]) : NaN;
    return isNaN(v) ? 1e9 : v;
  }
  function fillModels() {
    $("#selModel").innerHTML = M.models.map(function (m, i) { return '<option value="' + i + '">' + esc(m) + "</option>"; }).join("");
    $("#selModel").value = S.model;
  }
  function fillPowers() {
    var list = S.skusByModel[S.model].slice().sort(function (a, b) {
      return powerKey(M.skus[a][0]) - powerKey(M.skus[b][0]) || (M.skus[a][0] < M.skus[b][0] ? -1 : 1);
    });
    $("#selPower").innerHTML = list.map(function (i) {
      return '<option value="' + i + '">' + esc(powerLabel(M.skus[i][0])) + (S.active.has(i) ? "" : "  · no activity") + "</option>";
    }).join("");
    $("#selPower").value = S.sku;
  }
  function setSku(i, keepQty) {
    S.sku = i; S.model = M.skus[i][1]; S.selBranch = -1;
    if (!keepQty) { S.qty = 0; $("#ordQty").value = ""; }
    $("#selModel").value = S.model; fillPowers();
    setHash();
    render();
  }
  var VIEWS = {
    finder: ["W&D", "Warehouse & Distribution. A customer PO has come in: check your stock, find a branch that can release the rest, and raise the WnD PO."],
    branch: ["Branch View", "Every SKU of one branch with the demand-planning numbers: what to receive, send, reorder or return."],
    moves: ["Move List", "The planner's suggested branch-to-branch moves. Raise the WnD PO in one click."],
    reorder: ["Reorder List", "SKUs that fell below Min. Raise a purchase request up to Max."],
    pos: ["WnD POs", "Every WnD PO: request, approve, dispatch, receive."]
  };
  var ext = {};                              // views registered by views.js
  function setHash() {
    var h;
    if (S.view !== "finder") h = "#view=" + S.view;
    else h = "#sku=" + encodeURIComponent(M.skus[S.sku][0]) + (S.qty > 0 ? "&qty=" + S.qty : "") + (S.role !== "branch" && S.branch >= 0 ? "&br=" + encodeURIComponent(bname(S.branch)) : "");
    try { history.replaceState(null, "", location.pathname + location.search + h); } catch (e) { /* file:// */ }
  }
  function parseHash() {
    var out = { view: "finder", sku: null, qty: 0, br: null }, h = location.hash;
    var v = h.match(/view=(\w+)/); if (v && VIEWS[v[1]]) out.view = v[1];
    var m = h.match(/sku=([^&]+)/);
    if (m) { var s = decodeURIComponent(m[1]); if (skuIndex.has(s)) out.sku = skuIndex.get(s); }
    var q = h.match(/qty=(\d+)/); if (q) out.qty = Math.min(1000000, parseInt(q[1], 10));
    var b = h.match(/br=([^&]+)/); if (b) { var bi = branchIdx(decodeURIComponent(b[1])); if (bi >= 0) out.br = bi; }
    return out;
  }
  function showView(name, push) {
    if (!VIEWS[name]) name = "finder";
    S.view = name;
    Array.prototype.forEach.call(document.querySelectorAll("[data-view]"), function (el) { el.hidden = el.dataset.view !== name; });
    Array.prototype.forEach.call(document.querySelectorAll("[data-nav]"), function (a) { a.classList.toggle("active", a.dataset.nav === name); });
    $("#pgTitle").textContent = VIEWS[name][0]; $("#pgSub").textContent = VIEWS[name][1];
    document.title = VIEWS[name][0] + " · One View";
    document.body.classList.remove("menu-open"); $("#backdrop").hidden = true;
    if (push !== false) setHash();
    renderView();
    window.scrollTo(0, 0);
  }
  function renderView() {
    if (!S.ready) return;
    if (S.view === "finder") render(); else if (ext[S.view]) ext[S.view].render();
  }
  function openFinder(sku, branch, qty) {
    if (branch != null && S.visible.has(branch)) { S.branch = branch; $("#selBranch").value = branch; }
    S.sku = sku; S.model = M.skus[sku][1]; S.qty = qty > 0 ? Math.floor(qty) : 0; S.selBranch = -1;
    $("#ordQty").value = S.qty || ""; $("#selModel").value = S.model; fillPowers();
    showView("finder");
  }

  /* ---- who may do what with a WnD PO ---- */
  function nodeMine(n) { return S.role === "admin" || (!isCentral(n) && S.visible.has(n)); }
  function canAct(po, a) {
    if (!Store.can(po, a)) return false;
    if (S.role === "admin") return true;
    var ty = po.type;
    if (a === "approve" || a === "reject") return ty === "transfer" && nodeMine(po.from);       // donor approves; Central approves returns / purchases
    if (a === "dispatch") return !isCentral(po.from) && nodeMine(po.from);
    if (a === "receive") return !isCentral(po.to) && nodeMine(po.to);
    if (a === "cancel") return po.createdBy === S.user.name || (!isCentral(po.to) && nodeMine(po.to));
    return false;
  }
  function visiblePO(po) { return S.role === "admin" || nodeMine(po.from) || nodeMine(po.to); }
  function awaiting(po) {
    if (!Store.isOpen(po)) return false;
    if (S.role === "admin" && !(isCentral(po.from) || isCentral(po.to))) return false;     // admin is only nagged for Central items
    return (po.status === "Requested" && canAct(po, "approve")) || (po.status === "Approved" && canAct(po, "dispatch")) || (po.status === "In transit" && canAct(po, "receive"));
  }
  function doAct(id, action, note) {
    return Store.act(id, action, S.user.name, note).then(function (p) { toast(p.id + ": " + p.status); return p; }, function (e) { toast(e.message); });
  }
  function updatePills() {
    if (!S.user) return;
    var mineList = Store.all().filter(visiblePO), open = mineList.filter(Store.isOpen), me = mineList.filter(awaiting);
    var n = $("#navPoCnt"); n.hidden = !open.length; n.textContent = open.length;
    var p = $("#poPill"); p.hidden = !me.length; p.textContent = plural(me.length, "WnD PO", "WnD POs") + " awaiting you";
  }


  function render() { renderHead(); renderOrder(); renderPlan(); renderNotes(); }
  function renderPlan() {
    var R = records(); S.lastRecords = R;
    var single = scopeBranches().length <= 1;
    $("#posCard").hidden = single; $("#coverCard").hidden = single; $("#grid2").classList.toggle("one", single);
    renderKpis(R); renderInsights(R); renderTable(R); renderCover(R); renderTrend(); renderMoves();
  }

  function renderHead() {
    var s = M.skus[S.sku];
    $("#skuLine").innerHTML = "<b>" + esc(s[0]) + "</b>" + (s[2] ? '<span class="tag">' + esc(s[2]) + "</span>" : "") +
      '<span class="tag">Serving ' + esc(bname(S.branch)) + " · " + esc(M.branches[S.branch].zone) + "</span>";
  }

  /* ============================================================ ORDER CHECK / DONORS / WnD PO REQUEST */
  function draftedFrom(skuI, from) {
    var t = 0; S.draft.forEach(function (l) { if (l.s === skuI && l.f === from) t += l.q; });
    return t;
  }
  // Stock held by OTHER branches that can be moved to branch `toB` for SKU `skuI`.
  //   surplus = what the donor can release and still keep Max months of its own demand (non-moving: all),
  //   stretch = everything with 180+ days shelf life (cuts into the donor's own cover: needs the donor's OK).
  // Deducted: planner moves not yet raised for other branches, open WnD POs out of the donor, lines in the request.
  function donorList(skuI, toB) {
    var rows = S.stock.get(skuI) || new Map(), mv = S.stockMoves.get(skuI) || [], net = netter(skuI);
    var sendTot = {}, sendToMe = {};
    mv.forEach(function (m) { var q = net(m[0], m[1], m[2]); sendTot[m[0]] = (sendTot[m[0]] || 0) + q; if (m[1] === toB) sendToMe[m[0]] = (sendToMe[m[0]] || 0) + q; });
    var zone = M.branches[toB].zone, out = [];
    rows.forEach(function (r, b) {
      if (b === toB || !(r[4] > 0)) return;
      var other = (sendTot[b] || 0) - (sendToMe[b] || 0), dr = draftedFrom(skuI, b), wo = wndOut(skuI, b);
      out.push({ b: b, name: bname(b), zone: M.branches[b].zone, same: M.branches[b].zone === zone,
        onhand: r[2], reserved: r[3], free: r[4], T: r[5], status: r[7], moh: r[8],
        other: other, forMe: sendToMe[b] || 0, drafted: dr, wout: wo, lead: leadDays(b, toB),
        surplus: Math.max(0, r[6] - other - dr - wo), stretch: Math.max(0, r[5] - other - dr - wo) });
    });
    out.sort(function (x, y) {
      return (y.same ? 1 : 0) - (x.same ? 1 : 0) || (y.surplus > 0 ? 1 : 0) - (x.surplus > 0 ? 1 : 0) ||
        y.surplus - x.surplus || y.stretch - x.stretch || (x.name < y.name ? -1 : 1);
    });
    return out;
  }
  // Greedy cover of `need` units: same-zone first, largest release first (fewest POs); surplus before stretch.
  function allocate(donors, need) {
    var plan = [], left = need;
    donors.forEach(function (d) {
      if (left <= 0 || d.surplus <= 0) return;
      var q = Math.min(d.surplus, left); plan.push({ d: d, q: q, over: 0 }); left -= q;
    });
    if (left > 0) {
      donors.slice().sort(function (x, y) { return (y.same ? 1 : 0) - (x.same ? 1 : 0) || (y.stretch - y.surplus) - (x.stretch - x.surplus); })
        .forEach(function (d) {
          var extra = Math.min(d.stretch - d.surplus, left); if (left <= 0 || extra <= 0) return;
          var p = plan.filter(function (x) { return x.d === d; })[0];
          if (p) { p.q += extra; p.over += extra; } else plan.push({ d: d, q: extra, over: extra });
          left -= extra;
        });
    }
    return { plan: plan, uncovered: left, covered: need - left };
  }
  function sameSummary(alloc) {
    var s = 0, o = 0; alloc.plan.forEach(function (p) { if (p.d.same) s += p.q; else o += p.q; });
    return (s ? n0(s) + " same zone" : "") + (s && o ? ", " : "") + (o ? n0(o) + " other zones" : "");
  }
  function factsFor(sku, b) {
    var by = S.bySku.get(sku) || new Map(), t = moveTotals(sku);
    var rec = makeRecord(b, by, t.recv, t.send, sku), st = (S.stock.get(sku) || new Map()).get(b);
    return { rec: rec, free: rec.free, reserved: rec.open,
      onhand: st ? st[2] : rec.free + rec.open, T: st ? st[5] : null,
      notSellable: st ? Math.max(0, st[2] - st[3] - st[4]) : 0, pend: M.skus[sku][3], pos: wndPosTo(sku, b) };
  }
  function ownFacts() { return factsFor(S.sku, S.branch); }
  function incomingNote(o) {
    if (!(o.rec.wndIn > 0)) return "";
    var l = o.pos.slice(0, 3).map(function (p) { return esc(p.id) + " · " + esc(nname(p.from)) + " · " + n0(p.q) + " · " + esc(p.status); }).join("; ");
    return '<div class="flag">Already coming to this branch on open WnD POs: <b>' + n0(o.rec.wndIn) + "</b> units (" + l + (o.pos.length > 3 ? "…" : "") +
      "). This is counted as incoming. Make sure it is not the same order raised twice.</div>";
  }
  function subsHtml() {
    var cur = powerKey(M.skus[S.sku][0]), out = [];
    S.skusByModel[M.skus[S.sku][1]].forEach(function (i) {
      if (i === S.sku) return;
      var by = S.bySku.get(i), r = by && by.get(S.branch), own = r ? r[10] : 0, rows = S.stock.get(i), net = 0;
      if (rows) rows.forEach(function (x, b) { if (b !== S.branch) net += x[6]; });
      if (own > 0 || net > 0) out.push({ i: i, own: own, net: net, d: Math.abs(powerKey(M.skus[i][0]) - cur) });
    });
    out.sort(function (a, b) { return a.d - b.d; }); out = out.slice(0, 4);
    if (!out.length) return "";
    return '<div class="subs"><b>Same model, other powers in stock</b> (the surgeon decides): ' + out.map(function (x) {
      return '<button type="button" class="chip" data-act="sku" data-sku="' + x.i + '">' + esc(powerLabel(M.skus[x.i][0])) + " · " + n0(x.own) + " here · " + n0(x.net) + " elsewhere</button>";
    }).join("") + "</div>";
  }

  var ICON = {
    ok: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>',
    warn: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M7 7h11l-3-3M17 17H6l3 3"/></svg>',
    bad: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>',
    idle: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"><path d="M12 8v.01M12 11.5V17"/></svg>'
  };
  function zoneTag(same) { return same ? '<span class="same2">Same zone</span>' : '<span class="cross2">Other zone</span>'; }

  function renderOrder() {
    var b = S.branch, br = M.branches[b], o = ownFacts(), rec = o.rec, q = S.qty;
    var donors = donorList(S.sku, b);
    var need = Math.max(0, q - o.free - rec.wndIn);
    var alloc = allocate(donors, need); S.alloc = alloc;
    var totSurplus = 0, totStretch = 0; donors.forEach(function (d) { totSurplus += d.surplus; totStretch += d.stretch; });
    $("#orderSub").textContent = br.name + " (" + br.zone + ") · free stock = on hand − reserved for other customer orders − stock not sellable";
    var inc = incomingNote(o);

    /* ---- verdict ---- */
    var v, lead = 0;
    alloc.plan.forEach(function (p) { lead = Math.max(lead, p.d.lead); });
    var eta = function (days) { return '<div class="eta">Estimated arrival at ' + esc(br.name) + ": <b>" + etaDate(days) + "</b> (" + dayWord(days) + " after dispatch)</div>"; };
    if (!(q > 0)) {
      v = ["idle", "Enter the PO quantity",
        "You hold <b>" + n0(o.free) + "</b> free unit" + (o.free === 1 ? "" : "s") + " here. Other branches can release <b>" + n0(totSurplus) + "</b>" +
        (totStretch > totSurplus ? " (up to <b>" + n0(totStretch) + "</b> if donors agree)" : "") + ".", inc];
    } else if (o.free >= q) {
      var left = o.free - q, cover = rec.demand > 0 ? left / rec.demand : null, flags = "";
      if (o.T != null && q > o.T) flags += '<div class="flag">Only ' + n0(o.T) + " of your free units have " + CFG.shelfDays + "+ days of shelf life. Check the batch expiry before you confirm.</div>";
      if (rec.demand > 0 && left < rec.min) flags += '<div class="flag">After this order you will hold ' + n0(left) + ", below your Min of " + n0(rec.min) + ". Plan a replenishment (see below)" + (rec.reorder > 0 ? "; the planner suggests a reorder of " + n0(rec.reorder) : "") + ".</div>";
      v = ["ok", "Yes, serve it from " + esc(br.name) + " stock",
        "Free stock <b>" + n0(o.free) + "</b> covers the PO of <b>" + n0(q) + "</b>. <b>" + n0(left) + "</b> would be left" + (cover != null ? " (" + d1(cover) + " months of demand)" : "") + ". No WnD PO is needed.", flags + inc];
    } else if (need === 0) {
      v = ["warn", "Covered once the incoming WnD PO arrives",
        "Free stock <b>" + n0(o.free) + "</b> plus <b>" + n0(rec.wndIn) + "</b> already on open WnD POs covers the PO of <b>" + n0(q) + "</b>. Do not raise another PO for this quantity.", inc];
    } else if (alloc.uncovered === 0) {
      var anyOver = alloc.plan.some(function (p) { return p.over > 0; });
      v = ["warn", "Short by " + n0(need) + ": raise a WnD PO",
        "Your stock covers <b>" + n0(o.free) + "</b>" + (rec.wndIn ? " and <b>" + n0(rec.wndIn) + "</b> is already incoming" : "") + ". Request the other <b>" + n0(need) + "</b> from <b>" + plural(alloc.plan.length, "branch", "branches") + "</b> (" + sameSummary(alloc) + "). Quantities are filled in below.",
        (anyOver ? '<div class="flag">Part of this cuts into the donor\'s own ' + n0(S.norms.max) + "-month cover. Agree it with that branch before you raise the PO.</div>" : "") + eta(lead) + inc];
    } else {
      var covered = alloc.covered, cl = leadDays(100, b);
      v = ["bad", covered > 0 ? "Other branches cover only " + n0(covered) + " of the " + n0(need) + " you are short" : "No usable stock in other branches",
        (covered > 0 ? "Other branches can send <b>" + n0(covered) + "</b> (" + sameSummary(alloc) + "). Quantities are filled in below." : "Nothing with " + CFG.shelfDays + "+ days of shelf life can be released.") +
        "<p style='margin-top:8px'>Still short by <b>" + n0(alloc.uncovered) + "</b>: raise a purchase request on Central" +
        (rec.reorder > 0 ? " (planner reorder qty <b>" + n0(rec.reorder) + "</b>)" : "") + ". Pending central PO for this SKU: <b>" + n0(o.pend) + "</b>" +
        (rec.po > 0 ? "; already on order to your branch: <b>" + n0(rec.po) + "</b>" : "") + ".</p>",
        '<div class="btn-row left"><button class="btn sm" type="button" data-act="purchase" data-q="' + alloc.uncovered + '">Add purchase request for ' + n0(alloc.uncovered) + ' to the WnD PO request</button></div>' +
        (covered > 0 ? eta(lead) : "") + inc + subsHtml()];
    }
    $("#verdict").innerHTML = '<div class="vd vd-' + v[0] + '"><div class="vd-ic">' + ICON[v[0]] + "</div><div><h3>" + v[1] + "</h3><p>" + v[2] + "</p>" + v[3] + "</div></div>";

    /* ---- own stock tiles ---- */
    var stPill = rec.status < 0 ? "" : '<span class="st s-' + rec.status + '" style="min-width:0">' + esc(ST_SHORT[rec.status]) + "</span>";
    var tile = function (cls, l, val, sub) { return '<div class="tile ' + cls + '"><div class="l">' + l + '</div><div class="v">' + val + '</div><div class="s">' + sub + "</div></div>"; };
    $("#stockTiles").innerHTML =
      tile("hi", "Free stock (usable now)", n0(o.free), "On hand <b>" + n0(o.onhand) + "</b> · reserved <b>" + n0(o.reserved) + "</b>" + (o.notSellable > 0 ? " · not sellable <b>" + n0(o.notSellable) + "</b>" : "")) +
      tile("", CFG.shelfDays + "+ days shelf life", o.T == null ? DASH : n0(o.T), o.T == null ? "not available" : (o.T < o.free ? "<b>" + n0(o.free - o.T) + "</b> of free stock is shorter-dated" : "all of your free stock")) +
      tile("", "On order to branch", n0(rec.po + rec.wndIn), "FY26 POs <b>" + n0(rec.po) + "</b> · WnD POs <b>" + n0(rec.wndIn) + "</b>") +
      tile("", "Demand / month", d1(rec.demand), rec.moh == null ? "no sales demand" : "Cover <b>" + d1(rec.moh) + "</b> months") +
      tile("", "Min – Max", n0(rec.min) + " – " + n0(rec.max), "months: " + S.norms.min + " – " + S.norms.max) +
      tile("", "Status", stPill || DASH, rec.trend < 0 ? "" : "Trend <b>" + esc(M.trends[rec.trend]) + "</b>");
    var after = $("#afterLine"), low = false;
    if (q > 0) {
      low = o.free >= q && rec.demand > 0 && (o.free - q) < rec.min;
      after.innerHTML = "After this PO: free stock <b>" + n0(Math.max(0, o.free - q)) + "</b>" + (rec.demand > 0 ? " (" + d1(Math.max(0, o.free - q) / rec.demand) + " months)" : "") +
        (rec.wndIn ? " · open WnD PO incoming <b>" + n0(rec.wndIn) + "</b>" : "") + (need > 0 ? " · incoming from new request <b>" + n0(alloc.covered) + "</b>" : "") + (low ? " · <b>below Min</b>" : "");
    } else after.innerHTML = "Enter the PO quantity to see what is left after serving it.";
    after.classList.toggle("low", low);

    renderDonors(donors, alloc, need, totSurplus, totStretch);
    renderDraft();
  }

  function renderDonors(donors, alloc, need, totSurplus, totStretch) {
    var planBy = new Map(); alloc.plan.forEach(function (p) { planBy.set(p.d.b, p); });
    var usable = donors.filter(function (d) { return d.stretch > 0; }).length;
    $("#donorSub").textContent = donors.length ?
      plural(usable, "branch", "branches") + " can release stock: " + n0(totSurplus) + " units without hurting the donor" + (totStretch > totSurplus ? ", up to " + n0(totStretch) + " if donors agree" : "") +
      ". Same-zone branches are listed first. Only batches with " + CFG.shelfDays + "+ days of shelf life count." :
      "No other branch holds free stock of this SKU.";
    var btn = $("#addSuggested");
    if (need > 0 && alloc.plan.length) {
      btn.hidden = false;
      btn.textContent = "Add suggested to WnD PO request (" + n0(alloc.covered) + " units · " + plural(alloc.plan.length, "branch", "branches") + ")";
    } else btn.hidden = true;
    if (!donors.length) { $("#donorTbl").innerHTML = '<tbody><tr><td class="empty">Nothing to move: no branch holds this SKU.</td></tr></tbody>'; return; }
    var head = '<thead><tr class="only"><th class="l stick">Branch</th><th class="l">Status</th><th>Free stock</th><th>' + CFG.shelfDays + '+ days</th><th>Cover (mo)</th><th>Already committed</th><th>Can release</th><th>Max possible</th><th>Arrives</th><th>PO qty</th><th></th></tr></thead>';
    var body = donors.map(function (d) {
      var p = planBy.get(d.b), val = p ? p.q : "", over = p && p.over > 0, zero = d.stretch <= 0, committed = d.other + d.wout;
      return '<tr class="' + (p ? "sug " : "") + (zero ? "zero-row" : "") + '"><td class="l stick bold">' + esc(d.name) + '<span class="zt">' + esc(d.zone.replace("Zone-", "Z")) + "</span>" + zoneTag(d.same) + "</td>" +
        '<td class="l"><span class="st s-' + d.status + '">' + esc(ST_SHORT[d.status]) + "</span></td>" +
        "<td>" + i0(d.free) + "</td><td>" + i0(d.T) + "</td><td>" + (d.moh == null ? DASH : d1(d.moh)) + "</td>" +
        "<td>" + i0(committed) + (d.wout ? '<span class="ghost-note">' + n0(d.wout) + " on open WnD POs</span>" : "") + (d.forMe ? '<span class="ghost-note">' + n0(d.forMe) + " planned for you</span>" : "") + (d.drafted ? '<span class="ghost-note">' + n0(d.drafted) + " in your request</span>" : "") + "</td>" +
        '<td class="rel' + (d.surplus ? "" : " zero") + '">' + i0(d.surplus) + '</td><td class="max' + (d.stretch ? "" : " zero") + '">' + i0(d.stretch) + "</td>" +
        '<td class="eta-c">' + etaDate(d.lead) + "</td>" +
        '<td><input class="dcq' + (over ? " over" : "") + '" type="number" min="0" max="' + d.stretch + '" step="1" data-b="' + d.b + '" value="' + val + '"' + (zero ? " disabled" : "") + ' aria-label="PO quantity from ' + esc(d.name) + '"></td>' +
        '<td class="act"><button class="btn sm" data-add="' + d.b + '"' + (zero ? " disabled" : "") + ">Add</button></td></tr>";
    }).join("");
    $("#donorTbl").innerHTML = head + "<tbody>" + body + "</tbody>";
  }

  /* ---- WnD PO request (draft) ---- */
  function loadDraft() {
    try { var t = localStorage.getItem(DRAFT_KEY + (S.user.email || "")); S.draft = t ? JSON.parse(t) : []; } catch (e) { S.draft = []; }
    S.draft = (S.draft || []).filter(function (l) { return l && l.s >= 0 && l.s < M.skus.length && l.f >= 0 && l.t >= 0 && l.q > 0 && l.f !== l.t; });
  }
  function saveDraft() { try { localStorage.setItem(DRAFT_KEY + (S.user.email || ""), JSON.stringify(S.draft)); } catch (e) { /* storage blocked */ } }
  function pushLine(s, f, t, q, ov, ref) {
    var ex = S.draft.filter(function (l) { return l.s === s && l.f === f && l.t === t; })[0];
    if (ex) { ex.q += q; ex.ov = (ex.ov || 0) + (ov || 0); if (ref) ex.ref = ref; }
    else S.draft.push({ s: s, f: f, t: t, q: q, ov: ov || 0, ref: ref || "" });
    saveDraft();
  }
  function addLine(f, q, quiet) {
    q = Math.floor(q);
    if (!(q > 0)) { toast("Enter a quantity first"); return false; }
    var d = donorList(S.sku, S.branch).filter(function (x) { return x.b === f; })[0];
    if (d && q > d.stretch) { toast("Only " + n0(d.stretch) + " can be taken from " + bname(f)); return false; }
    pushLine(S.sku, f, S.branch, q, d ? Math.max(0, q - d.surplus) : 0, $("#poRef").value.trim());
    if (!quiet) { renderOrder(); toast("Added " + n0(q) + " from " + bname(f) + " to the WnD PO request"); }
    return true;
  }
  function groups() {
    var g = [], idx = {};
    S.draft.forEach(function (l, i) {
      var k = l.f + ">" + l.t;
      if (idx[k] == null) { idx[k] = g.length; g.push({ f: l.f, t: l.t, lines: [] }); }
      g[idx[k]].lines.push({ l: l, i: i });
    });
    return g;
  }
  function renderDraft() {
    var g = groups(), units = 0; S.draft.forEach(function (l) { units += l.q; });
    var pill = $("#dcPill");
    pill.hidden = !S.draft.length; pill.textContent = "WnD PO request · " + plural(S.draft.length, "line", "lines") + " · " + n0(units) + " units";
    $("#dcCopy").disabled = $("#dcCsv").disabled = $("#dcClear").disabled = $("#dcRaise").disabled = !S.draft.length;
    $("#draftSub").textContent = S.draft.length ?
      plural(g.length, "WnD PO", "WnD POs") + " to raise · " + plural(S.draft.length, "line", "lines") + " · " + n0(units) + " units. Saved on this computer until you press Raise." :
      "Nothing added yet. Pick a donor above and press Add, use the suggested request, or add a return or purchase from the other pages.";
    if (!S.draft.length) { $("#draftBody").innerHTML = '<div class="dc-empty">The lines you add are grouped here into one WnD PO per sending → receiving pair.</div>'; return; }
    $("#draftBody").innerHTML = g.map(function (grp, n) {
      var tot = 0, ov = 0; grp.lines.forEach(function (x) { tot += x.l.q; ov += x.l.ov || 0; });
      var ty = typeOf(grp.f, grp.t), same = !isCentral(grp.f) && !isCentral(grp.t) && M.branches[grp.f].zone === M.branches[grp.t].zone;
      return '<div class="dc-group"><div class="dc-h"><span class="no">PO ' + (n + 1) + "</span><span><b>" + esc(nname(grp.f)) + "</b> (" + esc(nzone(grp.f)) + ") → <b>" + esc(nname(grp.t)) + "</b> (" + esc(nzone(grp.t)) + ")</span>" +
        '<span class="ty ty-' + ty + '">' + TYPE_LABEL[ty] + "</span>" + (ty === "transfer" ? zoneTag(same) : "") + (ov > 0 ? '<span class="ok">needs donor OK</span>' : "") +
        '<span class="tot">' + n0(tot) + " units · " + plural(grp.lines.length, "line", "lines") + " · arrives ~" + etaDate(leadDays(grp.f, grp.t)) + "</span></div>" +
        '<table class="dc-t"><tbody>' + grp.lines.map(function (x) {
          return '<tr><td>' + esc(M.skus[x.l.s][0]) + '</td><td class="q"><input class="dcq' + (x.l.ov ? " over" : "") + '" type="number" min="1" step="1" data-line="' + x.i + '" value="' + x.l.q + '" aria-label="Quantity"></td>' +
            '<td class="rf"><input class="rfi" type="text" maxlength="60" data-ref="' + x.i + '" value="' + esc(x.l.ref || "") + '" placeholder="Customer PO / reference"></td>' +
            '<td class="x"><button class="x-btn" data-del="' + x.i + '" aria-label="Remove line" title="Remove">×</button></td></tr>';
        }).join("") + "</tbody></table></div>";
    }).join("") + '<p class="dc-foot">Raising creates the WnD PO in OneView' + (CFG.apiBase ? " and in Odoo" : " (demo: stored in this browser)") + '. The sending side approves and dispatches; the receiving side confirms receipt. Track it under WnD POs.</p>';
  }
  function raiseDraft() {
    if (!S.draft.length) return;
    var g = groups(), dups = [], seen = {};
    g.forEach(function (grp) {
      if (isCentral(grp.t)) return;
      grp.lines.forEach(function (x) {
        wndPosTo(x.l.s, grp.t).forEach(function (p) {
          var k = x.l.s + "|" + p.id + "|" + p.from; if (seen[k]) return; seen[k] = 1;
          dups.push("• " + M.skus[x.l.s][0] + " → " + nname(grp.t) + ": " + p.id + " (" + n0(p.q) + " from " + nname(p.from) + ", " + p.status + ")");
        });
      });
    });
    if (dups.length && !window.confirm("Possible duplicate. These SKUs already have open WnD POs to the same branch:\n\n" + dups.slice(0, 6).join("\n") + (dups.length > 6 ? "\n…" : "") + "\n\nRaise the new PO anyway?")) return;
    var ids = [];
    g.reduce(function (chain, grp) {
      return chain.then(function () {
        return Store.create({ type: typeOf(grp.f, grp.t), from: grp.f, to: grp.t,
          lines: grp.lines.map(function (x) { return { s: x.l.s, q: x.l.q, ov: x.l.ov || 0, ref: x.l.ref || "" }; }) }, S.user.name).then(function (p) { ids.push(p.id); });
      });
    }, Promise.resolve()).then(function () {
      S.draft = []; saveDraft(); renderDraft(); updatePills();
      toast("Raised " + (ids.length > 3 ? ids.length + " WnD POs (" + ids[0] + " to " + ids[ids.length - 1] + ")" : ids.join(", ")));
      if (ext.pos) ext.pos.highlight = ids;
      showView("pos");
    }).catch(function (e) { toast("Could not raise the PO: " + e.message); renderDraft(); });
  }
  function draftText() {
    var date = new Date().toISOString().slice(0, 10), out = [];
    groups().forEach(function (g, n) {
      var refs = {}; g.lines.forEach(function (x) { if (x.l.ref) refs[x.l.ref] = 1; });
      out.push("WnD PO " + (n + 1) + " (" + TYPE_LABEL[typeOf(g.f, g.t)] + "): " + nname(g.f) + " (" + nzone(g.f) + ") -> " + nname(g.t) + " (" + nzone(g.t) + ")" + (Object.keys(refs).length ? "   Ref: " + Object.keys(refs).join(", ") : ""));
      g.lines.forEach(function (x) { out.push("  - " + M.skus[x.l.s][0] + "  x " + x.l.q); });
      out.push("");
    });
    out.push("Requested by " + S.user.name + " on " + date);
    return out.join("\n");
  }
  function csvQ(v) { v = v == null ? "" : String(v); return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; }
  function download(name, text) {
    var blob = new Blob(["﻿" + text], { type: "text/csv;charset=utf-8" });
    var a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
  }
  function exportDraft() {
    var date = new Date().toISOString().slice(0, 10);
    var cols = ["PO no.", "Type", "From", "From zone", "To", "To zone", "Model", "SKU", "Quantity", "Customer PO / reference", "Needs donor OK (units)", "Requested by", "Date"];
    var lines = [cols.join(",")];
    groups().forEach(function (g, n) {
      g.lines.forEach(function (x) {
        var s = M.skus[x.l.s];
        lines.push(["PO " + (n + 1), TYPE_LABEL[typeOf(g.f, g.t)], nname(g.f), nzone(g.f), nname(g.t), nzone(g.t), M.models[s[1]], s[0], x.l.q, x.l.ref || "", x.l.ov || 0, S.user.name, date].map(csvQ).join(","));
      });
    });
    download("WnD-PO-request_" + date + ".csv", lines.join("\n"));
    toast("Downloaded " + S.draft.length + " lines");
  }
  function copyDraft() {
    var t = draftText();
    var ok = function () { toast("WnD PO request copied"); };
    var fallback = function () {
      var ta = document.createElement("textarea"); ta.value = t; ta.style.position = "fixed"; ta.style.opacity = "0";
      document.body.appendChild(ta); ta.select(); try { document.execCommand("copy"); ok(); } catch (e) { toast("Could not copy; use CSV"); } ta.remove();
    };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(t).then(ok, fallback); else fallback();
  }

  /* ---- customer PO with several SKUs ---- */
  var skuLower = null;
  function parseBulk(text) {
    if (!skuLower) { skuLower = new Map(); M.skus.forEach(function (s, i) { skuLower.set(s[0].toLowerCase().replace(/\s+/g, " "), i); }); }
    var rows = [], merged = new Map();
    text.split(/\r?\n/).forEach(function (raw) {
      var line = raw.trim(); if (!line) return;
      var m = line.match(/^(.*?)[\s,;\t]*(?:x|×|qty|:)?\s*(\d+)\s*$/i);
      if (!m || !m[1].trim()) { rows.push({ raw: line, state: "bad" }); return; }
      var name = m[1].trim().replace(/\s+/g, " ").toLowerCase(), q = parseInt(m[2], 10), idx = skuLower.get(name);
      if (idx == null) {
        var toks = name.split(" "), hits = [];
        for (var i = 0; i < M.skus.length && hits.length < 3; i++) { var t = M.skus[i][0].toLowerCase(); if (toks.every(function (w) { return t.indexOf(w) >= 0; })) hits.push(i); }
        if (hits.length === 1) idx = hits[0]; else { rows.push({ raw: line, state: hits.length ? "amb" : "nf", q: q }); return; }
      }
      if (merged.has(idx)) { merged.get(idx).q += q; return; }
      var r = { raw: line, sku: idx, q: q, state: "ok" }; merged.set(idx, r); rows.push(r);
    });
    return rows;
  }
  function bulkLine(r) {
    var o = factsFor(r.sku, S.branch), need = Math.max(0, r.q - o.free - o.rec.wndIn);
    var donors = donorList(r.sku, S.branch), al = allocate(donors, need);
    return { o: o, need: need, al: al };
  }
  function bulkCheck() {
    S.bulk = parseBulk($("#bulkText").value);
    var any = false;
    var body = S.bulk.map(function (r) {
      if (r.state !== "ok") return '<tr><td class="l">' + esc(r.raw) + '</td><td colspan="7" class="l bad-t">' + (r.state === "bad" ? "Could not read a quantity" : r.state === "amb" ? "More than one SKU matches: add the power, e.g. (4)" : "SKU not found") + "</td></tr>";
      var x = bulkLine(r), res;
      if (x.need === 0) res = '<span class="st s-2">' + (r.q <= x.o.free ? "Serve from stock" : "Covered by incoming PO") + "</span>";
      else if (x.al.uncovered === 0) { res = '<span class="st s-1">Raise WnD PO</span>'; any = true; }
      else { res = '<span class="st s-0">Partly short</span>'; any = true; }
      return '<tr><td class="l">' + esc(M.skus[r.sku][0]) + "</td><td>" + n0(r.q) + "</td><td>" + i0(x.o.free) + "</td><td>" + i0(x.o.rec.wndIn) + "</td><td>" + i0(x.need) + "</td><td>" + i0(x.al.covered) + "</td><td>" + i0(x.al.uncovered) + '</td><td class="l">' + res + "</td></tr>";
    }).join("");
    $("#bulkOut").innerHTML = S.bulk.length ? '<table class="tbl"><thead><tr class="only"><th class="l">SKU</th><th>PO qty</th><th>Free here</th><th>Incoming</th><th>Short</th><th>Other branches can send</th><th>Still short</th><th class="l">Result</th></tr></thead><tbody>' + body + "</tbody></table>" : "";
    $("#bulkAdd").hidden = !any;
  }
  function bulkAdd() {
    var lines = 0, units = 0, ref = $("#poRef").value.trim();
    S.bulk.forEach(function (r) {
      if (r.state !== "ok") return;
      var x = bulkLine(r); if (x.need === 0) return;
      x.al.plan.forEach(function (p) { pushLine(r.sku, p.d.b, S.branch, p.q, p.over, ref); lines++; units += p.q; });
      if (x.al.uncovered > 0) { pushLine(r.sku, 100, S.branch, x.al.uncovered, 0, ref); lines++; units += x.al.uncovered; }
    });
    renderOrder(); bulkCheck();
    toast(lines ? "Added " + lines + " lines (" + n0(units) + " units) to the WnD PO request" : "Nothing to add");
  }

  function renderKpis(R) {
    var o24 = sum(R, function (r) { return r.oct24; }), o25 = sum(R, function (r) { return r.oct25; });
    var mtd = sum(R, function (r) { return r.mtd; }), mtdLY = sum(R, function (r) { return r.oct25ly; });
    var dem = sum(R, function (r) { return r.demand; }), free = sum(R, function (r) { return r.free; });
    var count = function (i) { return R.filter(function (r) { return r.status === i; }).length; };
    var nShort = count(0), nCov = count(1), nOk = count(2), nExc = count(3) + count(4);
    var po = sum(R, function (r) { return r.po; }), reo = sum(R, function (r) { return r.reorder; });
    var recv = sum(R, function (r) { return r.recv; }), send = sum(R, function (r) { return r.send; });
    var mv = movesInScope(), cross = mv.filter(function (m) { return !m[13]; }).length;
    var pend = M.skus[S.sku][3];
    var minSum = sum(R, function (r) { return r.min; }), maxSum = sum(R, function (r) { return r.max; });
    var sc = scopeLabel();
    var yoy = o24 > 0 ? o25 / o24 - 1 : null, mtdYoy = mtdLY > 0 ? mtd / mtdLY - 1 : null;
    var pl = function (v) { return v == null ? '<span class="pill flat">n/a</span>' : '<span class="pill ' + (v > 0.005 ? "up" : v < -0.005 ? "down" : "flat") + '">' + pct(v) + "</span>"; };
    var stack = [0, 1, 2, 3, 4, 5].map(function (i) {
      var c = count(i); return c ? '<i style="width:' + (c / Math.max(1, R.filter(function (r) { return r.status >= 0 && r.status < 6; }).length) * 100) + "%;background:" + ST_COLOR[i] + '" title="' + esc(M.statuses[i]) + ": " + c + '"></i>' : "";
    }).join("");

    $("#kpis").innerHTML =
      '<div class="kpi"><div class="kpi-h"><span>Oct sales</span>' + pl(yoy) + '</div><div class="kpi-big">' + n0(o25) + '<small>Oct-25</small></div>' +
      '<div class="kpi-row"><span>Oct-24</span><b>' + n0(o24) + "</b></div>" +
      '<div class="kpi-row"><span>Oct-26 MTD</span><b>' + n0(mtd) + " " + pl(mtdYoy) + "</b></div>" +
      '<div class="kpi-note">MTD change is vs Oct-25 same 1–26 window (' + n0(mtdLY) + ").</div></div>" +

      '<div class="kpi"><div class="kpi-h"><span>Demand / month</span><span class="pill blue">' + esc(sc) + '</span></div><div class="kpi-big">' + n0(dem) + "<small>units</small></div>" +
      '<div class="kpi-row"><span>Free stock</span><b>' + n0(free) + "</b></div>" +
      '<div class="kpi-row"><span>Cover (MOH)</span><b>' + (dem > 0 ? d1(free / dem) + " mo" : DASH) + "</b></div>" +
      '<div class="kpi-note">Norm: Min ' + n0(minSum) + " – Max " + n0(maxSum) + " units across branches.</div></div>" +

      '<div class="kpi"><div class="kpi-h"><span>Branch health</span>' + (nShort ? '<span class="pill down">' + nShort + " short</span>" : '<span class="pill up">none short</span>') + '</div>' +
      '<div class="kpi-big ' + (nShort ? "c-short" : "") + '">' + nShort + "<small>short</small></div>" +
      '<div class="stack">' + stack + "</div>" +
      '<div class="kpi-row"><span>Short, covered by open PO</span><b>' + nCov + "</b></div>" +
      '<div class="kpi-row"><span>Healthy</span><b>' + nOk + "</b></div>" +
      '<div class="kpi-row"><span>Excess + non-moving</span><b>' + nExc + "</b></div></div>" +

      '<div class="kpi"><div class="kpi-h"><span>Pending PO (central)</span></div><div class="kpi-big">' + n0(pend) + "<small>units</small></div>" +
      '<div class="kpi-row"><span>Open PO to branches (FY26)</span><b>' + n0(po) + "</b></div>" +
      '<div class="kpi-row"><span>Reorder qty to raise</span><b class="' + (reo ? "c-short" : "") + '">' + n0(reo) + "</b></div>" +
      '<div class="kpi-note">Central = open FY26 POs raised by 2/2 IOL Chennai on Pondy / AI Optics / others. Reorder = Max − (stock after moves + open PO).</div></div>' +

      '<div class="kpi"><div class="kpi-h"><span>Suggested moves</span>' + (mv.length ? '<span class="pill warn">' + mv.length + " move" + (mv.length > 1 ? "s" : "") + "</span>" : '<span class="pill flat">none</span>') + '</div>' +
      '<div class="kpi-big">' + n0(Math.max(recv, send)) + "<small>units</small></div>" +
      '<div class="kpi-row"><span>Receive into ' + esc(sc) + "</span><b>" + n0(recv) + "</b></div>" +
      '<div class="kpi-row"><span>Send from ' + esc(sc) + "</span><b>" + n0(send) + "</b></div>" +
      '<div class="kpi-row"><span>Cross-zone moves</span><b>' + cross + "</b></div></div>";
  }

  function renderInsights(R) {
    var mv = S.movesBySku.get(S.sku) || [];
    var out = [];
    // 1. act now
    var sh = R.filter(function (r) { return r.status === 0; }).sort(function (a, b) { return (a.moh || 0) - (b.moh || 0); });
    var cov = R.filter(function (r) { return r.status === 1; }).length;
    if (sh.length) {
      var lines = sh.slice(0, 3).map(function (r) {
        var inc = mv.filter(function (m) { return m[6] === r.b; });
        var src = inc.map(function (m) { return "<b>" + n0(m[12]) + "</b> from " + esc(M.branches[m[2]].name) + (m[13] ? "" : " (cross-zone)"); }).join(", ");
        var tail = src ? "receive " + src : "no donor stock available" + (r.reorder > 0 ? " – raise <b>" + n0(r.reorder) + "</b> on central" : "");
        return "<b>" + esc(r.name) + "</b> has " + (r.moh == null ? "no demand data" : d1(r.moh) + " months cover") + " → " + tail + ".";
      });
      out.push('<div class="ins bad"><h3>Act now</h3>' + lines.join("<br>") + (sh.length > 3 ? "<br>+" + (sh.length - 3) + " more short branches in the table." : "") + "</div>");
    } else {
      out.push('<div class="ins good"><h3>No branch is short</h3>' + (cov ? n0(cov) + " branch" + (cov > 1 ? "es are" : " is") + " below Min but covered by an open PO." : "Every selling branch holds at least the shortage threshold of stock.") + "</div>");
    }
    // 2. idle stock
    var idle = R.filter(function (r) { return r.status === 4; });
    var idleU = sum(idle, function (r) { return r.free; });
    var excU = sum(R.filter(function (r) { return r.status === 3; }), function (r) { return Math.max(0, r.after - r.max); });
    if (idleU + excU > 0) {
      var parts = [];
      if (idleU > 0) parts.push("<b>" + n0(idleU) + " units</b> sit in " + idle.length + " non-moving branch" + (idle.length === 1 ? "" : "es") + " (no sale in 6 months)");
      if (excU > 0) parts.push("<b>" + n0(excU) + " units</b> are above Max in excess branches after planned moves");
      out.push('<div class="ins warn"><h3>Idle stock</h3>' + parts.join(" and ") + ".</div>");
    } else {
      out.push('<div class="ins good"><h3>No idle stock</h3>Nothing is stuck in non-moving or excess positions for this SKU.</div>');
    }
    // 3. momentum
    var l3 = sum(R, function (r) { return r.l3m; }), l12 = sum(R, function (r) { return r.l12m; });
    if (l12 > 0) {
      var ch = l3 / l12 - 1;
      out.push('<div class="ins info"><h3>Momentum</h3>Last 3 months run <b>' + pct(ch) + "</b> vs the 12-month average (" + d1(l3) + " vs " + d1(l12) + " units / month)" +
        (ch < -0.15 ? " – demand is cooling; avoid over-ordering." : ch > 0.15 ? " – demand is rising; check cover." : ".") + "</div>");
    } else {
      out.push('<div class="ins info"><h3>Momentum</h3>No sales for this SKU in the last 12 months in ' + esc(scopeLabel()) + ".</div>");
    }
    $("#insights").innerHTML = out.join("");
  }

  /* ---- branch table ---- */
  var COLS = [
    { k: "name", t: "Branch", cls: "l stick" },
    { k: "oct24", t: "Oct‑24" }, { k: "oct25", t: "Oct‑25" }, { k: "mtd", t: "Oct‑26 MTD" }, { k: "l3m", t: "Avg L3M" }, { k: "l12m", t: "Avg L12M" }, { k: "trend", t: "Trend", cls: "l" },
    { k: "demand", t: "Demand / month", sep: 1 }, { k: "min", t: "Min" }, { k: "max", t: "Max" },
    { k: "free", t: "Free stock", sep: 1 }, { k: "open", t: "Open orders" }, { k: "moh", t: "MOH" }, { k: "status", t: "Status", cls: "l" },
    { k: "recv", t: "Receive", sep: 1 }, { k: "send", t: "Send" }, { k: "after", t: "Stock after moves" }, { k: "reorder", t: "Reorder qty" }, { k: "po", t: "Open PO to branch" }
  ];
  function sortVal(r, k) {
    if (k === "sev") return ST_RANK[r.status] != null && r.status >= 0 ? ST_RANK[r.status] : 7;
    if (k === "moh") return r.moh == null ? 1e9 : r.moh;
    if (k === "trend") return r.trend;
    if (k === "status") return r.status < 0 ? 99 : ST_RANK[r.status];
    return r[k];
  }
  function renderTable(R) {
    var rows = R.slice();
    if (S.hideInactive) rows = rows.filter(function (r) { return !r.inactive; });
    var k = S.sort.k, d = S.sort.d;
    rows.sort(function (a, b) {
      var x = sortVal(a, k), y = sortVal(b, k);
      if (typeof x === "string") { var c = x.localeCompare(y); if (c) return c * d; }
      else if (x !== y) return (x - y) * d;
      if (k === "sev") { if (b.demand !== a.demand) return b.demand - a.demand; }
      return a.name.localeCompare(b.name);
    });
    var arrow = function (c) { return '<span class="ar">' + (S.sort.k === c.k ? (S.sort.d > 0 ? "▲" : "▼") : "") + "</span>"; };
    var th = function (c) {
      return '<th class="sortable ' + (c.cls || "r") + (c.sep ? " sep" : "") + '" data-k="' + c.k + '" aria-sort="' + (S.sort.k === c.k ? (S.sort.d > 0 ? "ascending" : "descending") : "none") + '">' + c.t + arrow(c) + "</th>";
    };
    var head = '<thead><tr class="grp"><th rowspan="2" class="sortable l stick" data-k="name">Branch' + arrow({ k: "name" }) + "</th>" +
      '<th colspan="6">Sales (units)</th><th colspan="3" class="sep">Demand &amp; norm</th><th colspan="4" class="sep">Stock</th><th colspan="5" class="sep">Plan</th></tr><tr class="cols">' +
      COLS.slice(1).map(th).join("") + "</tr></thead>";
    var body = rows.map(function (r) {
      var low = r.moh != null && r.moh < M.settings.shortMoh;
      return '<tr data-b="' + r.b + '" class="' + (r.b === S.selBranch ? "sel " : "") + (r.inactive ? "dim" : "") + '">' +
        '<td class="l stick bold">' + esc(r.name) + ' <span class="zt">' + esc(r.zone.replace("Zone-", "Z")) + "</span></td>" +
        "<td>" + i0(r.oct24) + "</td><td>" + i0(r.oct25) + "</td><td>" + i0(r.mtd) + "</td><td>" + d1(r.l3m) + "</td><td>" + d1(r.l12m) + "</td>" +
        '<td class="l"><span class="tr t-' + (r.trend < 0 ? "x" : r.trend) + '">' + (r.trend < 0 ? DASH : esc(M.trends[r.trend])) + "</span></td>" +
        '<td class="sep">' + d1(r.demand) + "</td><td>" + i0(r.min) + "</td><td>" + i0(r.max) + "</td>" +
        '<td class="sep">' + i0(r.free) + "</td><td>" + i0(r.open) + '</td><td class="moh' + (low ? " low" : "") + '">' + (r.moh == null ? "" : d1(r.moh)) + "</td>" +
        '<td class="l"><span class="st s-' + (r.status < 0 ? "x" : r.status) + '" title="' + (r.status < 0 ? "" : esc(M.statuses[r.status])) + '">' + (r.status < 0 ? DASH : esc(ST_SHORT[r.status])) + "</span></td>" +
        '<td class="sep recv' + (r.recv ? " has" : "") + '">' + i0(r.recv) + '</td><td class="send' + (r.send ? " has" : "") + '">' + i0(r.send) + "</td>" +
        "<td>" + i0(r.after) + '</td><td class="reo' + (r.reorder ? " has" : "") + '">' + i0(r.reorder) + "</td><td>" + i0(r.po) + (r.wndIn ? '<span class="wnd-in" title="Open WnD PO to this branch">+' + n0(r.wndIn) + "</span>" : "") + "</td></tr>";
    }).join("");
    var T = function (f) { return sum(R, f); }, tdem = T(function (r) { return r.demand; }), tfree = T(function (r) { return r.free; });
    var foot = '<tfoot><tr><td class="l stick">' + esc(scopeLabel()) + ' total</td>' +
      "<td>" + i0(T(function (r) { return r.oct24; })) + "</td><td>" + i0(T(function (r) { return r.oct25; })) + "</td><td>" + i0(T(function (r) { return r.mtd; })) + "</td><td>" + d1(T(function (r) { return r.l3m; })) + "</td><td>" + d1(T(function (r) { return r.l12m; })) + "</td><td></td>" +
      '<td class="sep">' + d1(tdem) + "</td><td>" + i0(T(function (r) { return r.min; })) + "</td><td>" + i0(T(function (r) { return r.max; })) + "</td>" +
      '<td class="sep">' + i0(tfree) + "</td><td>" + i0(T(function (r) { return r.open; })) + "</td><td>" + (tdem > 0 ? d1(tfree / tdem) : "") + "</td><td></td>" +
      '<td class="sep">' + i0(T(function (r) { return r.recv; })) + "</td><td>" + i0(T(function (r) { return r.send; })) + "</td><td>" + i0(T(function (r) { return r.after; })) + "</td><td>" + i0(T(function (r) { return r.reorder; })) + "</td><td>" + i0(T(function (r) { return r.po; })) + "</td></tr></tfoot>";
    $("#branchTbl").innerHTML = head + "<tbody>" + (body || '<tr><td colspan="19" class="empty">No branches to show.</td></tr>') + "</tbody>" + foot;
  }

  /* ---- stock cover chart ---- */
  function renderCover(R) {
    var rows = R.filter(function (r) { return r.demand > 0; }).sort(function (a, b) { return a.moh - b.moh; });
    var idle = R.filter(function (r) { return r.demand <= 0 && r.free > 0; });
    var CAP = Math.max(6, S.norms.max * 2.5);
    var band = S.norms.max > S.norms.min ? '<div class="cv-band" style="left:' + (S.norms.min / CAP * 100) + "%;width:" + ((S.norms.max - S.norms.min) / CAP * 100) + '%"></div>' : "";
    var html = rows.length ? '<div class="cv-head"><span>0 months</span><span>' + CAP + "+ months</span></div>" + rows.map(function (r) {
      var st = r.status < 0 ? 6 : r.status;
      return '<div class="cv-row"><div class="nm" title="' + esc(r.name) + '">' + esc(r.name) + "<small>" + esc(r.zone.replace("Zone-", "Z")) + '</small></div><div class="cv-track">' + band +
        '<div class="cv-bar bar-' + st + '" style="width:' + Math.min(100, r.moh / CAP * 100) + '%"></div></div><div class="v">' + d1(r.moh) + "</div></div>";
    }).join("") : '<div class="empty">No branch has demand for this SKU in ' + esc(scopeLabel()) + ".</div>";
    if (idle.length) html += '<div class="cv-foot">Not charted: ' + idle.length + " branch" + (idle.length === 1 ? "" : "es") + " hold " + n0(sum(idle, function (r) { return r.free; })) + " units but have no demand.</div>";
    $("#coverChart").innerHTML = html;
  }

  /* ---- model sales trend ---- */
  function renderTrend() {
    var model = S.model, set = new Set(S.selBranch >= 0 ? [S.selBranch] : scopeBranches());
    var tot = new Array(31).fill(0), any = false;
    (S.monthly.get(model) || []).forEach(function (r) {
      if (!set.has(r[0])) return;
      for (var i = 0; i < 31; i++) { tot[i] += r[2 + i]; if (r[2 + i]) any = true; }
    });
    var who = S.selBranch >= 0 ? M.branches[S.selBranch].name : scopeLabel();
    $("#trendTitle").textContent = "Sales trend · " + M.models[model];
    $("#trendSub").textContent = "All powers of the model · " + who + (S.selBranch >= 0 ? " (click the row again to clear)" : "") + " · Oct-26 is 1–26 Oct only";
    var host = $("#trendChart");
    if (!any) { host.innerHTML = '<div class="empty">No sales recorded for this model in ' + esc(who) + ".</div>"; $("#trendLegend").innerHTML = ""; return; }
    var cfg;
    if (S.trendMode === "fy") {
      var mon = ["Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec", "Jan", "Feb", "Mar"];
      var fy = function (a, b) { var v = []; for (var i = 0; i < 12; i++) v.push(a + i <= b ? tot[a + i] : null); return v; };
      cfg = { labels: mon, aria: "Monthly sales by financial year", series: [
        { name: "FY24-25", color: "#9AA5B5", values: fy(0, 11) },
        { name: "FY25-26", color: "#2A4F9F", values: fy(12, 23) },
        { name: "FY26-27", color: "#0097A7", values: fy(24, 30), hollowLast: true }
      ], tipTitle: function (i) { return mon[i]; } };
    } else {
      cfg = { labels: M.months, aria: "Monthly sales, 31 months", series: [{ name: "Units", color: "#2A4F9F", values: tot, hollowLast: true }], tipTitle: function (i) { return M.months[i] + (i === 30 ? " (1–26 Oct)" : ""); } };
    }
    $("#trendLegend").innerHTML = cfg.series.map(function (s) { return '<span><i style="background:' + s.color + '"></i>' + s.name + "</span>"; }).join("") +
      (S.trendMode === "fy" ? '<span style="color:var(--text-muted)">○ Oct-26 partial</span>' : "");
    CH.lineChart(host, cfg);
  }

  /* ---- planner's suggested moves ---- */
  function renderMoves() {
    var rem = movesRemaining(S.sku), mv = movesInScope().slice().sort(function (a, b) { return a[0] - b[0] || b[12] - a[12]; });
    var units = 0, cross = 0, raised = 0; mv.forEach(function (m) { units += rem.get(m); if (!m[13]) cross++; if (rem.get(m) < m[12]) raised++; });
    $("#movesSub").textContent = mv.length ? mv.length + " move" + (mv.length > 1 ? "s" : "") + " · " + n0(units) + " units still to move · " + cross + " cross-zone" + (raised ? " · " + raised + " already have a WnD PO" : "") + ". Receivers are filled to 1.5 months; donors keep 2 months; same-zone donors are used first." :
      "No transfer is suggested for this SKU in your scope.";
    if (!mv.length) { $("#movesTbl").innerHTML = '<tbody><tr><td class="empty">Nothing planned for this SKU. Use the order check above for an ad-hoc request.</td></tr></tbody>'; return; }
    var head = "<thead><tr class=\"only\"><th class=\"l\">Priority</th><th class=\"l\">From branch</th><th>From MOH</th><th class=\"l\">From trend</th><th></th><th class=\"l\">To branch</th><th>To MOH</th><th class=\"l\">To trend</th><th>Move qty</th><th class=\"l\">Zone</th><th></th></tr></thead>";
    var br = function (i) { return esc(M.branches[i].name) + ' <span style="color:var(--text-muted);font-size:11.5px">' + esc(M.branches[i].zone) + "</span>"; };
    var body = mv.map(function (m) {
      var left = rem.get(m), done = m[12] - left;
      return '<tr><td class="l"><span class="pri p' + m[0] + '">' + esc(M.priorities[m[0]]) + '</span></td><td class="l bold">' + br(m[2]) + "</td><td>" + d1(m[4]) + '</td><td class="l"><span class="tr t-' + m[5] + '">' + esc(M.trends[m[5]]) + '</span></td><td class="arrow">→</td>' +
        '<td class="l bold">' + br(m[6]) + "</td><td>" + d1(m[10]) + '</td><td class="l"><span class="tr t-' + m[11] + '">' + esc(M.trends[m[11]]) + '</span></td><td class="bold">' + n0(left) + (done ? '<span class="ghost-note">' + n0(done) + " on a WnD PO</span>" : "") + '</td><td class="l">' + (m[13] ? '<span class="same">Same zone</span>' : '<span class="cross">Cross-zone</span>') + "</td>" +
        '<td class="act">' + (left > 0 ? '<button class="btn sm" data-pl-from="' + m[2] + '" data-pl-to="' + m[6] + '" data-pl-qty="' + left + '">Add to PO</button>' : '<span class="st s-2">PO raised</span>') + "</td></tr>";
    }).join("");
    $("#movesTbl").innerHTML = head + "<tbody>" + body + "</tbody>";
  }

  function renderNotes() {
    $("#notes").innerHTML = "<b>WnD POs.</b> A WnD PO moves stock between branches (or returns it to Central / the Production plant, or requests a purchase from Central). Open POs count as incoming for the receiving branch and as committed for the sending branch, and a planner move that already has a PO is no longer shown as planned.<br>" +
      "<b>Order check.</b> Free stock = on hand − reserved for other customer orders − stock that is not sellable. A donor branch can release stock with " + CFG.shelfDays + "+ days of shelf life and keeps " + M.settings.maxMonths + " months of its own demand (non-moving stock is fully available). " +
      "“Max possible” goes beyond that and needs the donor's OK. Stock the planner has already earmarked for other branches, and quantities already in your DC request, are deducted. The shelf life of your own batches is not in this data: check the expiry in the system before you confirm.<br>" +
      "<b>How the planning numbers are built.</b> Planning demand / month = 0.5 × Avg L3M (Jul–Sep 26) + 0.3 × Avg L6M + 0.2 × Avg L12M; Oct-26 is partial and excluded. " +
      "Trend = last 6 months vs same 6 months last year (Growing &gt; +15%, Declining &lt; −15%). MOH = free stock ÷ demand. " +
      "Status: Shortage MOH &lt; " + M.settings.shortMoh + ", Healthy 1–2, Excess &gt; 2, Non-moving = stock but no sales in 6 months. Min / Max = demand × " + S.norms.min + " / " + S.norms.max + " months (rounded up). " +
      "FY26 open POs count as stock on order; FY25 POs still open are ignored (likely stale). Excluded: central 2/2 IOL Chennai, Pondy, AI Optics, export stock, control samples, injector cartridges, discontinued SKUs. " +
      "Stock as of " + CFG.stockAsOf + "; sales to " + CFG.salesTo + ".";
  }

  /* ------------------------------------------------------------ interactions */
  function toast(msg) { var t = $("#toast"); t.textContent = msg; t.hidden = false; clearTimeout(toast._t); toast._t = setTimeout(function () { t.hidden = true; }, 2600); }

  function exportCsv() {
    var R = S.lastRecords, s = M.skus[S.sku][0];
    var cols = ["Branch", "Zone", "Oct-24", "Oct-25", "Oct-26 MTD", "Avg L3M", "Avg L12M", "Trend", "Demand / month", "Min", "Max", "Free stock", "Open orders", "MOH", "Status", "Receive", "Send", "Stock after moves", "Reorder qty", "Open PO to branch"];
    var q = function (v) { v = v == null ? "" : String(v); return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; };
    var lines = [cols.join(",")].concat(R.map(function (r) {
      return [r.name, r.zone, r.oct24, r.oct25, r.mtd, r.l3m, r.l12m, r.trend < 0 ? "" : M.trends[r.trend], r.demand, r.min, r.max, r.free, r.open, r.moh == null ? "" : r.moh.toFixed(2), r.status < 0 ? "" : M.statuses[r.status], r.recv, r.send, r.after, r.reorder, r.po].map(q).join(",");
    }));
    var blob = new Blob(["﻿" + lines.join("\n")], { type: "text/csv;charset=utf-8" });
    var a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "WD_" + s.replace(/[^\w.-]+/g, "_") + "_" + scopeLabel().replace(/\s+/g, "") + ".csv";
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
    toast("CSV downloaded (" + R.length + " branches)");
  }

  function setQty(v) {
    S.qty = isNaN(v) || v < 0 ? 0 : Math.min(1000000, Math.floor(v));
    setHash(); renderOrder();
  }

  function wire() {
    $("#selModel").addEventListener("change", function () {
      var m = +this.value, list = S.skusByModel[m];
      var pick = list.filter(function (i) { return S.active.has(i); });
      pick.sort(function (a, b) { return powerKey(M.skus[a][0]) - powerKey(M.skus[b][0]); });
      S.model = m; setSku((pick.length ? pick : list)[0]);
    });
    $("#selPower").addEventListener("change", function () { setSku(+this.value); });
    $("#selBranch").addEventListener("change", function () { S.branch = +this.value; render(); });
    $("#selZone").addEventListener("change", function () { S.zoneFilter = this.value; S.selBranch = -1; renderPlan(); });
    $("#hideInactive").addEventListener("change", function () { S.hideInactive = this.checked; renderTable(S.lastRecords); });
    $("#csvBtn").addEventListener("click", exportCsv);
    $("#planView").addEventListener("toggle", function () { if (this.open) renderTrend(); });

    /* order check */
    $("#ordQty").addEventListener("input", function () { setQty(parseInt(this.value, 10)); });
    $("#qPlus").addEventListener("click", function () { $("#ordQty").value = S.qty + 1; setQty(S.qty + 1); });
    $("#qMinus").addEventListener("click", function () { var v = Math.max(0, S.qty - 1); $("#ordQty").value = v || ""; setQty(v); });
    $("#donorTbl").addEventListener("click", function (e) {
      var btn = e.target.closest("button[data-add]"); if (!btn) return;
      var b = +btn.dataset.add, inp = $('.dcq[data-b="' + b + '"]', this);
      addLine(b, inp ? parseFloat(inp.value) : 0);
    });
    $("#donorTbl").addEventListener("keydown", function (e) {
      if (e.key !== "Enter" || !e.target.matches(".dcq[data-b]")) return;
      addLine(+e.target.dataset.b, parseFloat(e.target.value));
    });
    $("#addSuggested").addEventListener("click", function () {
      var plan = S.alloc ? S.alloc.plan.slice() : [], n = 0, u = 0;
      plan.forEach(function (p) { if (addLine(p.d.b, p.q, true)) { n++; u += p.q; } });
      renderOrder(); if (n) toast("Added " + n0(u) + " units from " + plural(n, "branch", "branches") + " to the DC request");
    });
    $("#movesTbl").addEventListener("click", function (e) {
      var btn = e.target.closest("button[data-pl-from]"); if (!btn) return;
      pushLine(S.sku, +btn.dataset.plFrom, +btn.dataset.plTo, +btn.dataset.plQty, 0, "");
      renderOrder(); renderMoves(); toast("Added to the WnD PO request");
    });
    $("#verdict").addEventListener("click", function (e) {
      var b = e.target.closest("button[data-act]"); if (!b) return;
      if (b.dataset.act === "purchase") {
        pushLine(S.sku, 100, S.branch, +b.dataset.q, 0, $("#poRef").value.trim());
        renderOrder(); toast("Added a purchase request for " + n0(+b.dataset.q) + " to the WnD PO request");
      } else if (b.dataset.act === "sku") { var q = S.qty; setSku(+b.dataset.sku, true); S.qty = q; $("#ordQty").value = q || ""; renderOrder(); }
    });
    $("#bulkCheck").addEventListener("click", bulkCheck);
    $("#bulkAdd").addEventListener("click", bulkAdd);
    $("#dcRaise").addEventListener("click", raiseDraft);
    $("#dcPill").addEventListener("click", function () { showView("finder", true); var c = $("#draftCard"); if (c && c.scrollIntoView) c.scrollIntoView({ block: "start" }); });
    $("#poPill").addEventListener("click", function () { if (ext.pos) ext.pos.filter = "me"; showView("pos"); });
    /* DC request */
    $("#draftBody").addEventListener("change", function (e) {
      var t = e.target;
      if (t.dataset.line != null) {
        var l = S.draft[+t.dataset.line], nq = Math.floor(parseFloat(t.value));
        if (!l || !(nq > 0)) { t.value = l ? l.q : ""; return; }
        var d = donorList(l.s, l.t).filter(function (x) { return x.b === l.f; })[0], cap = d ? d.stretch + l.q : Infinity;
        if (nq > cap) { toast("Only " + n0(cap) + " can be taken from " + bname(l.f)); nq = cap; }
        l.ov = d ? Math.max(0, nq - (d.surplus + l.q)) : (l.ov || 0); l.q = nq;
        saveDraft(); renderOrder();
      } else if (t.dataset.ref != null && S.draft[+t.dataset.ref]) { S.draft[+t.dataset.ref].ref = t.value.trim(); saveDraft(); }
    });
    $("#draftBody").addEventListener("click", function (e) {
      var b = e.target.closest("button[data-del]"); if (!b) return;
      S.draft.splice(+b.dataset.del, 1); saveDraft(); renderOrder();
    });
    $("#dcCopy").addEventListener("click", copyDraft);
    $("#dcCsv").addEventListener("click", exportDraft);
    $("#dcClear").addEventListener("click", function () {
      if (!S.draft.length || !window.confirm("Remove all " + S.draft.length + " lines from the WnD PO request?")) return;
      S.draft = []; saveDraft(); renderOrder();
    });

    $("#branchTbl").addEventListener("click", function (e) {
      var th = e.target.closest("th[data-k]");
      if (th) { var k = th.dataset.k; S.sort = S.sort.k === k ? { k: k, d: -S.sort.d } : { k: k, d: (k === "name" || k === "zone" || k === "status" || k === "trend" || k === "sev" || k === "moh") ? 1 : -1 }; renderTable(S.lastRecords); return; }
      var tr = e.target.closest("tbody tr[data-b]");
      if (tr) { var b = +tr.dataset.b; S.selBranch = S.selBranch === b ? -1 : b; renderTable(S.lastRecords); renderTrend(); }
    });
    $("#trendSeg").addEventListener("click", function (e) {
      var b = e.target.closest("button"); if (!b) return;
      S.trendMode = b.dataset.m;
      Array.prototype.forEach.call(this.children, function (x) { x.classList.toggle("on", x === b); });
      renderTrend();
    });
    var rt; window.addEventListener("resize", function () { clearTimeout(rt); rt = setTimeout(renderTrend, 150); });

    /* typeahead */
    var inp = $("#skuSearch"), ul = $("#skuSuggest"), hi = -1, hits = [];
    function draw() {
      ul.innerHTML = hits.length ? hits.map(function (i, n) {
        return '<li data-i="' + i + '" class="' + (n === hi ? "on" : "") + '"><span>' + esc(M.skus[i][0]) + "</span><small>" + (S.active.has(i) ? "active" : "no activity") + "</small></li>";
      }).join("") : '<li class="none">No SKU matches</li>';
      ul.hidden = false;
    }
    inp.addEventListener("input", function () {
      var q = this.value.toLowerCase().split(/\s+/).filter(Boolean);
      if (!q.length) { ul.hidden = true; return; }
      hits = []; hi = -1;
      for (var i = 0; i < M.skus.length && hits.length < 400; i++) {
        var t = M.skus[i][0].toLowerCase();
        if (q.every(function (w) { return t.indexOf(w) >= 0; })) hits.push(i);
      }
      hits.sort(function (a, b) { return (S.active.has(b) ? 1 : 0) - (S.active.has(a) ? 1 : 0); });
      hits = hits.slice(0, 12); draw();
    });
    inp.addEventListener("keydown", function (e) {
      if (ul.hidden) return;
      if (e.key === "ArrowDown") { hi = Math.min(hits.length - 1, hi + 1); draw(); e.preventDefault(); }
      else if (e.key === "ArrowUp") { hi = Math.max(0, hi - 1); draw(); e.preventDefault(); }
      else if (e.key === "Enter" && hits.length) { pickHit(hits[hi < 0 ? 0 : hi]); e.preventDefault(); }
      else if (e.key === "Escape") ul.hidden = true;
    });
    function pickHit(i) { ul.hidden = true; inp.value = ""; setSku(i); }
    ul.addEventListener("mousedown", function (e) { var li = e.target.closest("li[data-i]"); if (li) pickHit(+li.dataset.i); });
    document.addEventListener("click", function (e) {
      if (!e.target.closest(".search-box")) ul.hidden = true;
      if (!e.target.closest(".norms-wrap")) $("#normsPanel").hidden = true;
    });

    /* norms */
    $("#normsBtn").addEventListener("click", function () {
      var p = $("#normsPanel"); p.hidden = !p.hidden;
      if (p.hidden) return;
      // open towards the side that stays on screen (never under the sidebar)
      var r = $(".norms-wrap").getBoundingClientRect(), fitsRight = r.left + p.offsetWidth <= window.innerWidth - 16;
      p.style.left = fitsRight ? "0" : "auto"; p.style.right = fitsRight ? "auto" : "0";
    });
    var normIn = { nMin: "min", nMax: "max", nDem: "dem" };
    Object.keys(normIn).forEach(function (id) {
      $("#" + id).addEventListener("change", function () {
        var v = parseFloat(this.value); if (isNaN(v) || v < 0) { this.value = S.norms[normIn[id]]; return; }
        S.norms[normIn[id]] = v;
        if (S.norms.max < S.norms.min) { S.norms.max = S.norms.min; $("#nMax").value = S.norms.max; }
        render();
      });
    });
    $("#nReset").addEventListener("click", function () {
      S.norms = { min: M.settings.minMonths, max: M.settings.maxMonths, dem: M.settings.minDemand }; syncNorms(); render();
    });

    /* shell */
    $("#menuBtn").addEventListener("click", function () { document.body.classList.toggle("menu-open"); $("#backdrop").hidden = !document.body.classList.contains("menu-open"); });
    $("#backdrop").addEventListener("click", function () { document.body.classList.remove("menu-open"); $("#backdrop").hidden = true; });
    window.addEventListener("hashchange", function () {
      if (!S.ready) return;
      var h = parseHash();
      if (h.view !== S.view) { showView(h.view, false); return; }
      if (S.view !== "finder") return;
      if (h.br != null && S.visible.has(h.br) && h.br !== S.branch) { S.branch = h.br; $("#selBranch").value = h.br; }
      if (h.sku != null && h.sku !== S.sku) { S.qty = h.qty; $("#ordQty").value = h.qty || ""; setSku(h.sku, true); }
      else if (h.sku != null && h.qty !== S.qty) { S.qty = h.qty; $("#ordQty").value = h.qty || ""; renderOrder(); }
    });
    $("#previewAs").addEventListener("change", function () {
      var u = new URL(location.href); u.searchParams.set("as", this.value);
      try { history.replaceState(null, "", u.pathname + u.search + location.hash); } catch (e) { /* file:// */ }
      applyUser();
    });
  }

  function syncNorms() {
    $("#nMin").value = S.norms.min; $("#nMax").value = S.norms.max; $("#nDem").value = S.norms.dem;
    var can = isAdmin() && CFG.adminCanEditNorms !== false;
    ["nMin", "nMax", "nDem"].forEach(function (id) { $("#" + id).disabled = !can; });
    $("#nReset").hidden = !can;
    $("#normsLock").textContent = can ? "" : "Read-only";
  }

  /* ------------------------------------------------------------ boot */
  function pickBranch() {
    var vis = Array.from(S.visible).sort(function (x, y) { return bname(x) < bname(y) ? -1 : 1; });
    if (S.role === "branch") return vis[0];
    var by = S.bySku.get(S.sku) || new Map();
    for (var i = 0; i < vis.length; i++) { var r = by.get(vis[i]); if (r && r[12] === 0) return vis[i]; }
    return vis[0];
  }
  function shell() {
    var u = S.user, nb = S.visible.size, lock = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 018 0v4"/></svg>';
    $("#userName").textContent = u.name; $("#userMail").textContent = u.email || "";
    $("#avatar").textContent = (u.name || "?").charAt(0).toUpperCase();
    var own = S.role === "branch" ? bname(S.branch) : "";
    $("#rolePill").textContent = S.role === "admin" ? "All zones" : S.role === "branch" ? own + " branch" : S.zones.join(" + ");
    var stockTxt = S.role === "admin" ? "" : (CFG.stockVisibility === "zone" ? " · stock view: your zone" : " · stock view: all branches");
    $("#scopeBadge").innerHTML = lock + (S.role === "admin" ? "Access: all zones · " + nb + " branches" : S.role === "branch" ? "Access: " + esc(own) + " (" + esc(S.zones[0]) + ")" + stockTxt : "Access: " + esc(S.zones.join(", ")) + " · " + nb + " branches" + stockTxt);
    $("#sideScope").innerHTML = "<b>" + esc(u.name) + "</b><br>" + (S.role === "admin" ? "Head-office view · all zones" : S.role === "branch" ? esc(own) + " branch" : esc(S.zones.join(", ")) + " only");
    $("#freshTxt").textContent = "Stock as of " + CFG.stockAsOf + " · sales to " + CFG.salesTo + " · Oct-26 is month-to-date";
    var zf = $("#zoneFld"); zf.hidden = S.role === "branch" || S.zones.length < 2;
    $("#selZone").innerHTML = '<option value="all">All zones</option>' + S.zones.map(function (z) { return '<option value="' + z + '">' + z + "</option>"; }).join("");
    $("#selZone").value = S.zoneFilter;
    var vis = Array.from(S.visible).sort(function (x, y) { return bname(x) < bname(y) ? -1 : 1; });
    $("#selBranch").innerHTML = vis.map(function (b) { return '<option value="' + b + '">' + esc(bname(b)) + " (" + esc(M.branches[b].zone) + ")</option>"; }).join("");
    $("#selBranch").value = S.branch; $("#selBranch").disabled = S.role === "branch";
    $("#planView").open = S.role !== "branch";
    $("#csvBtn").hidden = S.role === "branch"; $(".norms-wrap").hidden = S.role === "branch";
    syncNorms();
  }
  function fail(msg) {
    $("#verdict").innerHTML = '<div class="err" style="margin:0"><b>Could not load data.</b><br>' + esc(msg) + "</div>";
  }
  function applyUser() {
    S.user = resolveUser(); setScope(S.user); S.zoneFilter = "all"; S.selBranch = -1;
    if (!S.visible.size || (S.user.branch && branchIdx(S.user.branch) < 0)) { fail("This account has no branch or zone access. Please contact the OneView administrator."); return; }
    S.ready = false;
    Promise.all([ensureData(), Store.refresh()]).then(function () {
      var first = !S.booted; S.booted = true;
      buildIndex(); loadDraft();
      var h = parseHash();
      if (S.sku < 0) {
        var d = skuIndex.get(CFG.defaultSku);
        S.sku = h.sku != null ? h.sku : d != null ? d : 0; S.model = M.skus[S.sku][1];
        S.qty = h.sku != null ? h.qty : 0; fillModels();
      }
      if (!S.visible.has(S.branch)) S.branch = pickBranch();
      if (first && h.br != null && S.visible.has(h.br)) S.branch = h.br;
      if (first) S.view = h.view;
      shell();
      $("#ordQty").value = S.qty || ""; $("#selModel").value = S.model; fillPowers();
      S.ready = true; updatePills(); showView(S.view, false);
    }).catch(function (e) { fail(e.message + ". Check that the data/ folder is deployed next to index.html."); });
  }
  function boot() {
    var lg = $("#logoImg");
    if (CFG.logo) { lg.onload = function () { lg.parentNode.classList.add("has-img"); }; lg.src = CFG.logo; }
    if (CFG.demo) {
      $("#demoBox").hidden = false;
      $("#previewAs").innerHTML = (CFG.previewUsers || []).map(function (u) { return '<option value="' + u.id + '">' + esc(u.label) + "</option>"; }).join("");
      $("#previewAs").value = new URLSearchParams(location.search).get("as") || "admin";
    }
    wire();
    $("#verdict").innerHTML = '<div class="loading">Loading…</div>';
    applyUser();
  }
  Store.onChange(function () { if (S.ready) { updatePills(); renderView(); } });
  window.OVDebug = { records: records, state: S, skuIndex: skuIndex, setSku: setSku, donorList: donorList, allocate: allocate, ownFacts: ownFacts };
  /* what views.js needs */
  window.OVCore = { S: S, M: M, CFG: CFG, Store: Store, $: $, esc: esc, n0: n0, i0: i0, d1: d1, DASH: DASH, plural: plural, bname: bname, nname: nname, nzone: nzone, isCentral: isCentral,
    typeOf: typeOf, TYPE_LABEL: TYPE_LABEL, ST_SHORT: ST_SHORT, powerLabel: powerLabel, leadDays: leadDays, etaDate: etaDate, makeRecord: makeRecord, moveTotals: moveTotals, movesRemaining: movesRemaining,
    wndPair: wndPair, wndIn: wndIn, pushLine: pushLine, renderDraft: renderDraft, toast: toast, showView: showView, openFinder: openFinder, canAct: canAct, visiblePO: visiblePO, awaiting: awaiting,
    doAct: doAct, updatePills: updatePills, scopeBranches: scopeBranches, csvQ: csvQ, download: download, factsFor: factsFor, donorList: donorList, powerKey: powerKey,
    register: function (name, impl) { ext[name] = impl; } };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot); else boot();
})();
