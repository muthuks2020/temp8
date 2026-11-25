/* =====================================================================
   WnD views: Branch View, Move List, Reorder List, WnD POs (tracker)
   Uses the shared state and helpers exported by app.js (window.OVCore).
   ===================================================================== */
(function () {
  "use strict";
  var C = window.OVCore, S = C.S, M = C.M, $ = C.$, esc = C.esc, n0 = C.n0, i0 = C.i0, d1 = C.d1, DASH = C.DASH, plural = C.plural, Store = C.Store;
  var CAP = 600;                                         // rows drawn at most; filters narrow the rest
  var RANK = [0, 1, 3, 4, 5, 2, 6];
  function root(name) { return $("#view-" + name); }
  function chips(list, cur, attr) {
    return list.map(function (c) { return '<button type="button" class="chip' + (c[0] === cur ? " on" : "") + '" data-' + attr + '="' + c[0] + '">' + esc(c[1]) + (c[2] != null ? " <b>" + n0(c[2]) + "</b>" : "") + "</button>"; }).join("");
  }
  function skuCell(i) { var n = M.skus[i][0], m = n.match(/^(.*?)\s*\(([^)]*)\)\s*$/); return m ? esc(m[1]) + ' <span class="pw">' + esc(C.powerLabel(n)) + "</span>" : esc(n); }
  function stPill(s) { return s < 0 ? DASH : '<span class="st s-' + s + '" title="' + esc(M.statuses[s]) + '">' + esc(C.ST_SHORT[s]) + "</span>"; }
  function trPill(t) { return t < 0 ? DASH : '<span class="tr t-' + t + '">' + esc(M.trends[t]) + "</span>"; }
  function scopedBranches() { return Array.from(S.visible).sort(function (a, b) { return C.bname(a) < C.bname(b) ? -1 : 1; }); }
  function branchOpts(sel, all) {
    return (all ? '<option value="-1">All branches</option>' : "") + scopedBranches().map(function (b) { return '<option value="' + b + '"' + (b === sel ? " selected" : "") + ">" + esc(C.bname(b)) + " (" + esc(M.branches[b].zone) + ")</option>"; }).join("");
  }
  function sortBy(rows, keyFn, dir) { return rows.sort(function (a, b) { var x = keyFn(a), y = keyFn(b); if (typeof x === "string") return x.localeCompare(y) * dir; return (x - y) * dir; }); }

  /* ================================================================ BRANCH VIEW */
  var bv = { branch: -1, tab: "need", q: "", sort: { k: "sev", d: 1 }, rows: [] };
  function bvCompute() {
    var b = bv.branch, out = [];
    S.bySku.forEach(function (by, sku) {
      if (!by.has(b)) return;
      var t = C.moveTotals(sku), rec = C.makeRecord(b, by, t.recv, t.send, sku);
      if (rec.inactive) return;
      var st = (S.stock.get(sku) || new Map()).get(b), T = st ? st[5] : null;
      rec.shortDated = T == null ? 0 : Math.max(0, rec.free - T);
      rec.excess = rec.demand > 0 ? Math.max(0, rec.free - rec.max) : (rec.status === 4 ? rec.free : 0);
      rec.retQty = Math.min(rec.free, Math.max(rec.excess, rec.shortDated, rec.status === 4 ? rec.free : 0));
      rec.needStock = rec.status === 0 || rec.reorder > 0;
      rec.ageing = rec.retQty > 0 && (rec.status === 3 || rec.status === 4 || rec.shortDated > 0);
      rec.createQty = rec.reorder > 0 ? rec.reorder : Math.max(1, rec.min - rec.after);
      rec.sev = RANK[rec.status] == null ? 7 : RANK[rec.status];
      out.push(rec);
    });
    return out;
  }
  var BV_COLS = [
    ["name", "SKU", "l stick"], ["oct24", "Oct-24"], ["oct25", "Oct-25"], ["mtd", "Oct-26 MTD"], ["l3m", "Avg L3M"], ["l12m", "Avg L12M"], ["trend", "Trend", "l"],
    ["demand", "Demand / month", "r sep"], ["min", "Min"], ["max", "Max"], ["free", "Free stock", "r sep"], ["open", "Open orders"], ["moh", "MOH"], ["sev", "Status", "l"],
    ["recv", "Receive", "r sep"], ["send", "Send"], ["after", "Stock after moves"], ["reorder", "Reorder qty"], ["po", "Open PO to branch"], ["wndIn", "WnD PO in"],
    ["shortDated", "Short-dated (<" + C.CFG.shelfDays + "d)", "r sep"], ["act", "Action", "l"]
  ];
  function bvRender() {
    var el = root("branch");
    if (!el.dataset.built) {
      el.dataset.built = "1";
      el.innerHTML = '<section class="card"><div class="card-h"><div><h2 id="bvTitle"></h2><p id="bvSub"></p></div></div>' +
        '<div class="view-bar"><label class="fld" id="bvBrFld"><span>Branch</span><select id="bvBranch"></select></label><div class="chips" id="bvTabs"></div>' +
        '<label class="fld grow"><span>Search SKU</span><input id="bvQ" class="txt" placeholder="model or power, e.g. SPNT300 30" autocomplete="off"></label></div>' +
        '<div class="tbl-wrap tall"><table class="tbl" id="bvTbl"></table></div></section>';
      $("#bvBranch").addEventListener("change", function () { bv.branch = +this.value; bvRender(); });
      $("#bvQ").addEventListener("input", function () { bv.q = this.value; bvDraw(); });
      $("#bvTabs").addEventListener("click", function (e) { var b = e.target.closest("[data-t]"); if (b) { bv.tab = b.dataset.t; bvDraw(); } });
      $("#bvTbl").addEventListener("click", function (e) {
        var th = e.target.closest("th[data-k]");
        if (th && th.dataset.k !== "act") { var k = th.dataset.k; bv.sort = bv.sort.k === k ? { k: k, d: -bv.sort.d } : { k: k, d: (k === "name" || k === "sev" || k === "trend" || k === "moh") ? 1 : -1 }; bvDraw(); return; }
        var btn = e.target.closest("button[data-bv]"); if (!btn) return;
        var s = +btn.dataset.s;
        if (btn.dataset.bv === "po") C.openFinder(s, bv.branch, +btn.dataset.q);
        else if (btn.dataset.bv === "ret") {
          var tr = btn.closest("tr"), q = Math.floor(parseFloat(tr.querySelector("input.dcq").value)), dest = +tr.querySelector("select").value, max = +btn.dataset.max;
          if (!(q > 0) || q > max) { C.toast("Enter 1 to " + n0(max) + " units"); return; }
          C.pushLine(s, bv.branch, dest, q, 0, ""); C.renderDraft(); C.toast("Added a return of " + n0(q) + " to " + C.nname(dest) + " to the WnD PO request");
        }
      });
    }
    if (bv.branch < 0 || !S.visible.has(bv.branch)) bv.branch = S.visible.has(S.branch) ? S.branch : scopedBranches()[0];
    $("#bvBranch").innerHTML = branchOpts(bv.branch); $("#bvBranch").disabled = S.role === "branch"; $("#bvBrFld").hidden = S.role === "branch";
    bv.rows = bvCompute(); bvDraw();
  }
  function bvDraw() {
    var all = bv.rows, q = bv.q.toLowerCase().split(/\s+/).filter(Boolean);
    var cnt = { need: all.filter(function (r) { return r.needStock; }).length, age: all.filter(function (r) { return r.ageing; }).length, all: all.length };
    $("#bvTabs").innerHTML = chips([["need", "Needs stock", cnt.need], ["age", "Excess & ageing", cnt.age], ["all", "All SKUs", cnt.all]], bv.tab, "t");
    var br = C.bname(bv.branch);
    $("#bvTitle").textContent = br + " · " + M.branches[bv.branch].zone + " · demand planning by SKU";
    $("#bvSub").textContent = bv.tab === "need" ? "SKUs that are short or below Min. Create PO opens the order check with the quantity filled in." :
      bv.tab === "age" ? "Stock above Max, not moving, or with less than " + C.CFG.shelfDays + " days of shelf life. Return it to Central or the Production plant, or let another branch use it." : "Every SKU with stock, sales or an open PO at this branch.";
    var rows = all.filter(function (r) {
      if (bv.tab === "need" && !r.needStock) return false; if (bv.tab === "age" && !r.ageing) return false;
      var t = M.skus[r.sku][0].toLowerCase(); return q.every(function (w) { return t.indexOf(w) >= 0; });
    });
    var k = bv.sort.k, d = bv.sort.d;
    rows.sort(function (a, b) {
      var x = k === "name" ? M.skus[a.sku][0] : k === "moh" ? (a.moh == null ? 1e9 : a.moh) : a[k], y = k === "name" ? M.skus[b.sku][0] : k === "moh" ? (b.moh == null ? 1e9 : b.moh) : b[k];
      if (x == null) x = -1; if (y == null) y = -1;
      if (typeof x === "string") { var c = x.localeCompare(y); if (c) return c * d; } else if (x !== y) return (x - y) * d;
      return (a.moh == null ? 1e9 : a.moh) - (b.moh == null ? 1e9 : b.moh) || b.demand - a.demand;
    });
    var arrow = function (c) { return '<span class="ar">' + (bv.sort.k === c ? (bv.sort.d > 0 ? "▲" : "▼") : "") + "</span>"; };
    var head = "<thead><tr class=\"only\">" + BV_COLS.map(function (c) { return '<th class="' + (c[2] || "r") + (c[0] === "act" ? "" : " sortable") + '" data-k="' + c[0] + '">' + c[1] + (c[0] === "act" ? "" : arrow(c[0])) + "</th>"; }).join("") + "</tr></thead>";
    var shown = rows.slice(0, CAP);
    var body = shown.map(function (r) {
      var low = r.moh != null && r.moh < M.settings.shortMoh, act = "";
      if (r.needStock) act += '<button class="btn sm" data-bv="po" data-s="' + r.sku + '" data-q="' + r.createQty + '">Create PO</button> ';
      if (r.ageing) act += '<span class="ret"><input class="dcq" type="number" min="1" max="' + r.retQty + '" value="' + r.retQty + '" aria-label="Return quantity"><select aria-label="Return to">' +
        '<option value="100">Central</option><option value="101">Plant</option></select><button class="btn-sec sm" data-bv="ret" data-s="' + r.sku + '" data-max="' + r.retQty + '">Return</button></span>';
      return '<tr class="' + (r.needStock ? "need" : "") + '"><td class="l stick bold">' + skuCell(r.sku) + "</td>" +
        "<td>" + i0(r.oct24) + "</td><td>" + i0(r.oct25) + "</td><td>" + i0(r.mtd) + "</td><td>" + d1(r.l3m) + "</td><td>" + d1(r.l12m) + "</td><td class=\"l\">" + trPill(r.trend) + "</td>" +
        '<td class="sep">' + d1(r.demand) + "</td><td>" + i0(r.min) + "</td><td>" + i0(r.max) + "</td>" +
        '<td class="sep">' + i0(r.free) + "</td><td>" + i0(r.open) + '</td><td class="moh' + (low ? " low" : "") + '">' + (r.moh == null ? "" : d1(r.moh)) + '</td><td class="l">' + stPill(r.status) + "</td>" +
        '<td class="sep recv' + (r.recv ? " has" : "") + '">' + i0(r.recv) + '</td><td class="send' + (r.send ? " has" : "") + '">' + i0(r.send) + "</td><td>" + i0(r.after) + '</td><td class="reo' + (r.reorder ? " has" : "") + '">' + i0(r.reorder) + "</td><td>" + i0(r.po) + "</td><td>" + i0(r.wndIn) + "</td>" +
        '<td class="sep">' + i0(r.shortDated) + '</td><td class="l act">' + act + "</td></tr>";
    }).join("");
    $("#bvTbl").innerHTML = head + "<tbody>" + (body || '<tr><td colspan="' + BV_COLS.length + '" class="empty">Nothing in this list.</td></tr>') + "</tbody>" +
      (rows.length > CAP ? '<tfoot><tr><td class="l" colspan="' + BV_COLS.length + '">Showing the first ' + CAP + " of " + n0(rows.length) + " SKUs. Use the search to narrow down.</td></tr></tfoot>" : "");
  }

  /* ================================================================ MOVE LIST */
  var ml = { chip: "todo", q: "" };
  function mlCompute() {
    var out = [];
    S.movesBySku.forEach(function (list, sku) {
      var rem = C.movesRemaining(sku);
      list.forEach(function (m) { if (S.visible.has(m[2]) || S.visible.has(m[6])) out.push({ m: m, sku: sku, left: rem.get(m), cross: !m[13] }); });
    });
    out.sort(function (a, b) { return a.m[0] - b.m[0] || b.left - a.left || M.skus[a.sku][0].localeCompare(M.skus[b.sku][0]); });
    return out;
  }
  function mlRender() {
    var el = root("moves");
    if (!el.dataset.built) {
      el.dataset.built = "1";
      el.innerHTML = '<section class="card"><div class="card-h"><div><h2>Planner\'s suggested moves</h2><p id="mlSub"></p></div><div class="btn-row"><button class="btn" id="mlAll" type="button">Add all shown to WnD PO request</button></div></div>' +
        '<div class="view-bar"><div class="chips" id="mlChips"></div><label class="fld grow"><span>Search SKU or branch</span><input id="mlQ" class="txt" placeholder="e.g. NAS207 or Kolkata" autocomplete="off"></label></div>' +
        '<div class="tbl-wrap tall"><table class="tbl" id="mlTbl"></table></div></section>';
      $("#mlQ").addEventListener("input", function () { ml.q = this.value; mlDraw(); });
      $("#mlChips").addEventListener("click", function (e) { var b = e.target.closest("[data-c]"); if (b) { ml.chip = b.dataset.c; mlDraw(); } });
      $("#mlTbl").addEventListener("click", function (e) {
        var b = e.target.closest("button[data-i]"); if (!b) return;
        var r = ml.shown[+b.dataset.i]; if (!r || !(r.left > 0)) return;
        C.pushLine(r.sku, r.m[2], r.m[6], r.left, 0, ""); C.renderDraft(); C.updatePills(); C.toast("Added to the WnD PO request"); mlDraw();
      });
      $("#mlAll").addEventListener("click", function () {
        var rows = ml.shown.filter(function (r) { return r.left > 0; });
        if (!rows.length) { C.toast("Nothing to add"); return; }
        if (rows.length > 40 && !window.confirm("Add " + rows.length + " lines to the WnD PO request?")) return;
        rows.forEach(function (r) { C.pushLine(r.sku, r.m[2], r.m[6], r.left, 0, ""); });
        C.renderDraft(); C.toast("Added " + rows.length + " lines to the WnD PO request"); mlDraw();
      });
    }
    ml.all = mlCompute(); mlDraw();
  }
  function mlDraw() {
    var all = ml.all, q = ml.q.toLowerCase().split(/\s+/).filter(Boolean);
    var cnt = { todo: 0, raised: 0, same: 0, cross: 0, all: all.length };
    all.forEach(function (r) { if (r.left > 0) cnt.todo++; else cnt.raised++; if (r.cross) cnt.cross++; else cnt.same++; });
    $("#mlChips").innerHTML = chips([["todo", "Needs a PO", cnt.todo], ["raised", "PO raised", cnt.raised], ["same", "Same zone", cnt.same], ["cross", "Cross-zone", cnt.cross], ["all", "All", cnt.all]], ml.chip, "c");
    var rows = all.filter(function (r) {
      if (ml.chip === "todo" && !(r.left > 0)) return false; if (ml.chip === "raised" && r.left > 0) return false;
      if (ml.chip === "same" && r.cross) return false; if (ml.chip === "cross" && !r.cross) return false;
      var t = (M.skus[r.sku][0] + " " + C.bname(r.m[2]) + " " + C.bname(r.m[6])).toLowerCase(); return q.every(function (w) { return t.indexOf(w) >= 0; });
    });
    var units = 0; rows.forEach(function (r) { units += r.left; });
    ml.shown = rows.slice(0, CAP);
    $("#mlSub").textContent = n0(rows.length) + " moves · " + n0(units) + " units still to move. Receivers are filled to 1.5 months, donors keep 2 months, same-zone donors are used first. A move with an open WnD PO is shown as raised.";
    var br = function (i) { return esc(C.bname(i)) + ' <span class="zt">' + esc(M.branches[i].zone.replace("Zone-", "Z")) + "</span>"; };
    var head = '<thead><tr class="only"><th class="l">Priority</th><th class="l">SKU</th><th class="l">From</th><th>From MOH</th><th class="l">To</th><th>To MOH</th><th>Move qty</th><th class="l">Zone</th><th>Arrives</th><th></th></tr></thead>';
    var body = ml.shown.map(function (r, i) {
      var m = r.m, done = m[12] - r.left;
      return '<tr><td class="l"><span class="pri p' + m[0] + '">' + esc(M.priorities[m[0]]) + '</span></td><td class="l bold">' + skuCell(r.sku) + '</td><td class="l">' + br(m[2]) + "</td><td>" + d1(m[4]) + '</td><td class="l bold">' + br(m[6]) + "</td><td>" + d1(m[10]) + '</td><td class="bold">' + n0(r.left) +
        (done ? '<span class="ghost-note">' + n0(done) + " on a WnD PO</span>" : "") + '</td><td class="l">' + (r.cross ? '<span class="cross">Cross-zone</span>' : '<span class="same">Same zone</span>') + "</td><td class=\"eta-c\">" + C.etaDate(C.leadDays(m[2], m[6])) + "</td>" +
        '<td class="act">' + (r.left > 0 ? '<button class="btn sm" data-i="' + i + '">Add to PO</button>' : '<span class="st s-2">PO raised</span>') + "</td></tr>";
    }).join("");
    $("#mlTbl").innerHTML = head + "<tbody>" + (body || '<tr><td colspan="10" class="empty">No moves in this list.</td></tr>') + "</tbody>" +
      (rows.length > CAP ? '<tfoot><tr><td class="l" colspan="10">Showing the first ' + CAP + " of " + n0(rows.length) + ". Use the search or the chips to narrow down.</td></tr></tfoot>" : "");
  }

  /* ================================================================ REORDER LIST */
  var ro = { branch: -1, q: "", edit: {}, sel: {} };
  function roCompute() {
    var out = [];
    S.bySku.forEach(function (by, sku) {
      var t = null;
      S.visible.forEach(function (b) {
        if (ro.branch >= 0 && ro.branch !== b) return;
        if (!by.has(b)) return;
        t = t || C.moveTotals(sku);
        var rec = C.makeRecord(b, by, t.recv, t.send, sku);
        if (rec.reorder > 0) { rec.pend = M.skus[sku][3]; out.push(rec); }
      });
    });
    out.sort(function (a, b) { return (a.moh == null ? 1e9 : a.moh) - (b.moh == null ? 1e9 : b.moh) || b.reorder - a.reorder; });
    return out;
  }
  function roRender() {
    var el = root("reorder");
    if (!el.dataset.built) {
      el.dataset.built = "1";
      el.innerHTML = '<section class="card"><div class="card-h"><div><h2>SKUs below Min</h2><p id="roSub"></p></div><div class="btn-row"><button class="btn-sec" id="roCsv" type="button">CSV</button><button class="btn" id="roAdd" type="button">Add selected to WnD PO request</button></div></div>' +
        '<div class="view-bar"><label class="fld" id="roBrFld"><span>Branch</span><select id="roBranch"></select></label><label class="fld grow"><span>Search SKU</span><input id="roQ" class="txt" placeholder="model or power" autocomplete="off"></label></div>' +
        '<div class="tbl-wrap tall"><table class="tbl" id="roTbl"></table></div></section>';
      $("#roBranch").addEventListener("change", function () { ro.branch = +this.value; ro.sel = {}; roRender(); });
      $("#roQ").addEventListener("input", function () { ro.q = this.value; roDraw(); });
      $("#roTbl").addEventListener("change", function (e) {
        var t = e.target, k = t.dataset.k;
        if (t.matches("input[data-sel]")) { if (t.dataset.sel === "all") { ro.shown.forEach(function (r) { ro.sel[r.sku + "|" + r.b] = t.checked; }); roDraw(); } else ro.sel[t.dataset.sel] = t.checked; roCount(); }
        else if (t.matches("input.dcq")) { var v = Math.floor(parseFloat(t.value)); if (v > 0) ro.edit[k] = v; else { delete ro.edit[k]; t.value = ro.rowBy[k].reorder; } }
      });
      $("#roTbl").addEventListener("click", function (e) {
        var b = e.target.closest("button[data-one]"); if (!b) return;
        var r = ro.rowBy[b.dataset.one]; roPush(r); C.renderDraft(); C.toast("Added a purchase request for " + n0(ro.edit[b.dataset.one] || r.reorder) + " to the WnD PO request");
      });
      $("#roAdd").addEventListener("click", function () {
        var rows = ro.shown.filter(function (r) { return ro.sel[r.sku + "|" + r.b]; });
        if (!rows.length) { C.toast("Tick the SKUs first"); return; }
        rows.forEach(roPush); ro.sel = {}; C.renderDraft(); C.toast("Added " + rows.length + " purchase requests to the WnD PO request"); roDraw();
      });
      $("#roCsv").addEventListener("click", function () {
        var lines = [["Branch", "Zone", "SKU", "Status", "Demand/month", "Min", "Max", "Free stock", "Stock after moves", "Open PO to branch", "WnD PO in", "Reorder qty", "Pending central PO"].join(",")];
        ro.rows.forEach(function (r) { lines.push([C.bname(r.b), r.zone, M.skus[r.sku][0], r.status < 0 ? "" : M.statuses[r.status], r.demand, r.min, r.max, r.free, r.after, r.po, r.wndIn, r.reorder, r.pend].map(C.csvQ).join(",")); });
        C.download("Reorder-list_" + new Date().toISOString().slice(0, 10) + ".csv", lines.join("\n")); C.toast("Downloaded " + ro.rows.length + " rows");
      });
    }
    if (S.role === "branch") ro.branch = Array.from(S.visible)[0];
    else if (ro.branch >= 0 && !S.visible.has(ro.branch)) ro.branch = -1;
    $("#roBranch").innerHTML = branchOpts(ro.branch, true); $("#roBranch").disabled = S.role === "branch"; $("#roBrFld").hidden = S.role === "branch";
    ro.rows = roCompute(); roDraw();
  }
  function roPush(r) { C.pushLine(r.sku, 100, r.b, ro.edit[r.sku + "|" + r.b] || r.reorder, 0, ""); }
  function roCount() { var n = 0; Object.keys(ro.sel).forEach(function (k) { if (ro.sel[k]) n++; }); $("#roAdd").textContent = n ? "Add " + n + " selected to WnD PO request" : "Add selected to WnD PO request"; }
  function roDraw() {
    var q = ro.q.toLowerCase().split(/\s+/).filter(Boolean);
    var rows = ro.rows.filter(function (r) { var t = M.skus[r.sku][0].toLowerCase(); return q.every(function (w) { return t.indexOf(w) >= 0; }); });
    var units = 0; rows.forEach(function (r) { units += ro.edit[r.sku + "|" + r.b] || r.reorder; });
    $("#roSub").textContent = n0(rows.length) + " SKU-branch lines · " + n0(units) + " units to procure. After planned moves, open POs and WnD POs the stock is still below Min. The quantity takes it up to Max; edit it if needed.";
    ro.shown = rows.slice(0, CAP); ro.rowBy = {};
    var head = '<thead><tr class="only"><th class="l"><input type="checkbox" data-sel="all" aria-label="Select all shown"></th><th class="l">Branch</th><th class="l">SKU</th><th class="l">Status</th><th>Demand / month</th><th>Min</th><th>Max</th><th>Free stock</th><th>MOH</th><th>Stock after moves</th><th>Open PO to branch</th><th>WnD PO in</th><th>Reorder qty</th><th>Pending central PO</th><th>Arrives</th><th></th></tr></thead>';
    var body = ro.shown.map(function (r) {
      var k = r.sku + "|" + r.b; ro.rowBy[k] = r;
      return '<tr><td class="l"><input type="checkbox" data-sel="' + k + '"' + (ro.sel[k] ? " checked" : "") + ' aria-label="Select"></td><td class="l bold">' + esc(C.bname(r.b)) + ' <span class="zt">' + esc(r.zone.replace("Zone-", "Z")) + '</span></td><td class="l">' + skuCell(r.sku) + '</td><td class="l">' + stPill(r.status) + "</td>" +
        "<td>" + d1(r.demand) + "</td><td>" + i0(r.min) + "</td><td>" + i0(r.max) + "</td><td>" + i0(r.free) + '</td><td class="moh' + (r.moh != null && r.moh < M.settings.shortMoh ? " low" : "") + '">' + (r.moh == null ? "" : d1(r.moh)) + "</td><td>" + i0(r.after) + "</td><td>" + i0(r.po) + "</td><td>" + i0(r.wndIn) + "</td>" +
        '<td><input class="dcq" type="number" min="1" step="1" data-k="' + k + '" value="' + (ro.edit[k] || r.reorder) + '" aria-label="Reorder quantity"></td><td>' + i0(r.pend) + '</td><td class="eta-c">' + C.etaDate(C.leadDays(100, r.b)) + '</td><td class="act"><button class="btn sm" data-one="' + k + '">Create PO</button></td></tr>';
    }).join("");
    $("#roTbl").innerHTML = head + "<tbody>" + (body || '<tr><td colspan="16" class="empty">Nothing is below Min. Well stocked.</td></tr>') + "</tbody>" +
      (rows.length > CAP ? '<tfoot><tr><td class="l" colspan="16">Showing the first ' + CAP + " of " + n0(rows.length) + ". Pick a branch or search to narrow down.</td></tr></tfoot>" : "");
    roCount();
  }

  /* ================================================================ WnD POs (tracker) */
  var po = { filter: null, q: "", open: null, highlight: [] };
  var STEPS = ["Requested", "Approved", "In transit", "Received"];
  function dayDiff(a, b) { return Math.max(0, Math.round((new Date(b) - new Date(a)) / 864e5)); }
  function fmtDate(iso) { return new Date(iso).toLocaleDateString("en-GB", { day: "2-digit", month: "short" }); }
  function poUnits(p) { var t = 0; p.lines.forEach(function (l) { t += l.q; }); return t; }
  function poRefs(p) { var r = {}; p.lines.forEach(function (l) { if (l.ref) r[l.ref] = 1; }); return Object.keys(r); }
  function overdue(p) { return (p.status === "Approved" || p.status === "In transit") && dayDiff(p.created, new Date()) > C.leadDays(p.from, p.to) + 3; }
  function progress(p) {
    var cur = STEPS.indexOf(p.status);
    if (cur < 0) return '<span class="ps ps-' + p.status.toLowerCase().replace(/\s/g, "") + '">' + esc(p.status) + "</span>";
    return '<span class="prog" title="' + esc(p.status) + '">' + STEPS.map(function (s, i) { return '<i class="' + (i <= cur ? "on" : "") + '"></i>'; }).join("") + '</span><span class="ps ps-' + p.status.toLowerCase().replace(/\s/g, "") + '">' + esc(p.status) + "</span>";
  }
  function actionsFor(p) {
    var out = [], L = { approve: ["Approve", "btn"], dispatch: ["Dispatch", "btn"], receive: ["Receive", "btn"], reject: ["Reject", "btn-sec"], cancel: ["Cancel PO", "btn-ghost"] };
    ["approve", "dispatch", "receive", "reject", "cancel"].forEach(function (a) { if (C.canAct(p, a)) out.push('<button class="' + L[a][1] + ' sm" data-act="' + a + '" data-id="' + esc(p.id) + '">' + L[a][0] + "</button>"); });
    return out;
  }
  function poRender() {
    var el = root("pos");
    if (!el.dataset.built) {
      el.dataset.built = "1";
      el.innerHTML = '<section class="kpis" id="poKpis"></section><section class="card"><div class="card-h"><div><h2>WnD POs</h2><p id="poSub"></p></div><div class="btn-row"><button class="btn-sec" id="poCsv" type="button">CSV</button></div></div>' +
        '<div class="view-bar"><div class="chips" id="poChips"></div><label class="fld grow"><span>Search PO no., SKU, branch or reference</span><input id="poQ" class="txt" placeholder="e.g. WND-2611-0001 or Kolkata" autocomplete="off"></label></div>' +
        '<div class="tbl-wrap tall"><table class="tbl" id="poTbl"></table></div><p class="po-note" id="poNote"></p></section>';
      $("#poQ").addEventListener("input", function () { po.q = this.value; poDraw(); });
      $("#poChips").addEventListener("click", function (e) { var b = e.target.closest("[data-f]"); if (b) { po.filter = b.dataset.f; poDraw(); } });
      $("#poTbl").addEventListener("click", function (e) {
        var b = e.target.closest("button[data-act]");
        if (b) {
          var a = b.dataset.act, note = "";
          if (a === "reject" || a === "cancel") { note = window.prompt(a === "reject" ? "Reason for rejecting (optional)" : "Reason for cancelling (optional)", ""); if (note === null) return; }
          C.doAct(b.dataset.id, a, note); return;
        }
        var tr = e.target.closest("tr[data-id]"); if (tr) { po.open = po.open === tr.dataset.id ? null : tr.dataset.id; poDraw(); }
      });
      $("#poCsv").addEventListener("click", function () {
        var lines = [["PO no.", "Type", "From", "To", "SKU", "Quantity", "Customer PO / reference", "Status", "Raised on", "Raised by", "Odoo ref"].join(",")];
        poRows().forEach(function (p) { p.lines.forEach(function (l) { lines.push([p.id, C.TYPE_LABEL[p.type], C.nname(p.from), C.nname(p.to), M.skus[l.s][0], l.q, l.ref || "", p.status, p.created.slice(0, 10), p.createdBy, p.odooRef || ""].map(C.csvQ).join(",")); }); });
        C.download("WnD-POs_" + new Date().toISOString().slice(0, 10) + ".csv", lines.join("\n")); C.toast("Downloaded");
      });
    }
    poDraw();
  }
  function poRows() { return Store.all().filter(C.visiblePO).sort(function (a, b) { return a.created < b.created ? 1 : -1; }); }
  function poDraw() {
    var all = poRows(), open = all.filter(Store.isOpen), me = all.filter(C.awaiting);
    if (po.filter == null) po.filter = me.length ? "me" : "open";
    var transit = 0; all.forEach(function (p) { if (p.status === "In transit") transit += poUnits(p); });
    var recvd = all.filter(function (p) { return p.status === "Received"; }), tt = 0;
    recvd.forEach(function (p) { var h = p.history[p.history.length - 1]; tt += dayDiff(p.created, h.at); });
    var late = open.filter(overdue).length;
    var kp = function (l, v, s, cls) { return '<div class="kpi ' + (cls || "") + '"><div class="kpi-h">' + l + '</div><div class="kpi-big">' + v + '</div><div class="kpi-note">' + s + "</div></div>"; };
    $("#poKpis").innerHTML = kp("Open WnD POs", n0(open.length), "requested, approved or in transit") + kp("Units in transit", n0(transit), "on the road now") +
      kp("Awaiting you", n0(me.length), me.length ? "approve, dispatch or receive" : "nothing pending", me.length ? "hot" : "") + kp("Received", n0(recvd.length), recvd.length ? "avg " + d1(tt / recvd.length) + " days from request" : "none yet") + kp("Overdue", n0(late), "open longer than lead time + 3 days", late ? "hot" : "");
    $("#poChips").innerHTML = chips([["me", "Awaiting me", me.length], ["open", "Open", open.length], ["closed", "Closed", all.length - open.length], ["all", "All", all.length]], po.filter, "f");
    var q = po.q.toLowerCase().split(/\s+/).filter(Boolean);
    var rows = all.filter(function (p) {
      if (po.filter === "me" && C.awaiting(p) !== true) return false; if (po.filter === "open" && !Store.isOpen(p)) return false; if (po.filter === "closed" && Store.isOpen(p)) return false;
      var t = (p.id + " " + C.nname(p.from) + " " + C.nname(p.to) + " " + p.lines.map(function (l) { return M.skus[l.s][0] + " " + (l.ref || ""); }).join(" ") + " " + (p.odooRef || "")).toLowerCase();
      return q.every(function (w) { return t.indexOf(w) >= 0; });
    });
    $("#poSub").textContent = all.length ? n0(rows.length) + " shown. Click a row for the lines and history." : "No WnD PO yet. Raise one from the SKU Finder, Move List or Reorder List.";
    var head = '<thead><tr class="only"><th class="l">PO no.</th><th class="l">Type</th><th class="l">From → To</th><th>Units</th><th class="l">Reference</th><th class="l">Raised</th><th class="l">Status</th><th class="l">Odoo ref</th><th></th></tr></thead>';
    var body = rows.slice(0, CAP).map(function (p) {
      var acts = actionsFor(p), first = acts.slice(0, p.status === "Requested" ? 2 : 1).join(" "), refs = poRefs(p);
      var tr = '<tr data-id="' + esc(p.id) + '" class="po-row' + (po.open === p.id ? " sel" : "") + (po.highlight.indexOf(p.id) >= 0 ? " new" : "") + '"><td class="l bold">' + esc(p.id) + "</td>" +
        '<td class="l"><span class="ty ty-' + p.type + '">' + C.TYPE_LABEL[p.type] + '</span></td><td class="l">' + esc(C.nname(p.from)) + ' <span class="zt">' + esc(C.nzone(p.from).replace("Zone-", "Z")) + "</span> → <b>" + esc(C.nname(p.to)) + '</b> <span class="zt">' + esc(C.nzone(p.to).replace("Zone-", "Z")) + "</span></td>" +
        "<td>" + n0(poUnits(p)) + '<span class="ghost-note">' + plural(p.lines.length, "line", "lines") + "</span></td>" +
        '<td class="l">' + (refs.length ? esc(refs.join(", ")) : DASH) + '</td><td class="l">' + fmtDate(p.created) + '<span class="ghost-note">' + esc(p.createdBy) + "</span></td>" +
        '<td class="l">' + progress(p) + (overdue(p) ? ' <span class="late">Overdue</span>' : "") + '</td><td class="l odoo">' + (p.odooRef ? esc(p.odooRef) : '<span class="muted">' + (C.CFG.apiBase ? "Syncing…" : "Demo: not sent to Odoo") + "</span>") + '</td><td class="act">' + first + "</td></tr>";
      if (po.open === p.id) {
        tr += '<tr class="po-detail"><td colspan="9"><div class="po-d"><div><h4>Lines</h4><table class="dc-t"><tbody>' + p.lines.map(function (l) { return "<tr><td>" + esc(M.skus[l.s][0]) + '</td><td class="q"><b>' + n0(l.q) + "</b></td><td>" + (l.ref ? esc(l.ref) : "") + (l.ov ? ' <span class="cross2">' + n0(l.ov) + " needed donor OK</span>" : "") + "</td></tr>"; }).join("") + "</tbody></table></div>" +
          '<div><h4>History</h4><ol class="hist">' + p.history.map(function (h) { return "<li><b>" + esc(h.st) + "</b> · " + fmtDate(h.at) + " · " + esc(h.by) + (h.note ? " · “" + esc(h.note) + "”" : "") + "</li>"; }).join("") + "</ol>" +
          '<div class="btn-row left">' + (actionsFor(p).join(" ") || '<span class="muted">No action for you on this PO.</span>') + "</div></div></div></td></tr>";
      }
      return tr;
    }).join("");
    $("#poTbl").innerHTML = head + "<tbody>" + (body || '<tr><td colspan="9" class="empty">Nothing here.</td></tr>') + "</tbody>";
    $("#poNote").textContent = C.CFG.apiBase ? "POs are created in Odoo by the OneView server; the Odoo reference appears once synced." : "Demo mode: POs are stored in this browser and shared by every preview user. Set apiBase in js/config.js to send them to OneView / Odoo.";
  }

  C.register("branch", { render: bvRender });
  C.register("moves", { render: mlRender });
  C.register("reorder", { render: roRender });
  C.register("pos", { render: poRender, get filter() { return po.filter; }, set filter(v) { po.filter = v; }, get highlight() { return po.highlight; }, set highlight(v) { po.highlight = v; po.filter = "open"; po.open = v[0]; } });
})();
