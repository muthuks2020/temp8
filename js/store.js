/* =====================================================================
   WnD PO store
   A WnD PO moves stock between two nodes (branch -> branch, branch -> Central
   warehouse / Production plant for returns, Central warehouse -> branch for
   replenishment). It is raised from OneView and follows a simple life-cycle:

     Requested -> Approved -> In transit -> Received
                \-> Rejected         \-> Cancelled (Requested / Approved only)

   Two back-ends, same interface:
     - local demo (default): POs are kept in this browser (localStorage), shared by
       every "Preview as" user so the full flow can be tried end to end.
     - REST (set OV_CONFIG.apiBase): OneView back-end, which also creates the
       document in Odoo and returns its reference. See API.md for the contract.

   PO shape
     { id, type: "transfer"|"return"|"replenish", from, to,      // branch index, or 100 Central warehouse / 101 Production plant
       lines: [{ s: skuIndex, q, ov, ref }], status, odooRef,
       created, createdBy, history: [{ st, at, by, note }] }
   ===================================================================== */
(function () {
  "use strict";
  var CFG = window.OV_CONFIG, KEY = "ov_wnd_pos_v1";
  var OPEN = { "Requested": 1, "Approved": 1, "In transit": 1 };
  var NEXT = {            // action -> [allowed from-statuses, new status]
    approve:  [["Requested"], "Approved"],
    reject:   [["Requested"], "Rejected"],
    dispatch: [["Approved"], "In transit"],
    receive:  [["In transit"], "Received"],
    cancel:   [["Requested", "Approved"], "Cancelled"]
  };
  var cache = [], listeners = [];

  function readLocal() { try { return JSON.parse(localStorage.getItem(KEY) || "[]"); } catch (e) { return []; } }
  function writeLocal() { try { localStorage.setItem(KEY, JSON.stringify(cache)); } catch (e) { /* storage blocked */ } }
  function emit() { listeners.forEach(function (f) { try { f(); } catch (e) { /* ignore */ } }); }
  function api(path, opt) {
    return fetch(CFG.apiBase.replace(/\/$/, "") + path, Object.assign({ credentials: "include", headers: { "Content-Type": "application/json" } }, opt || {}))
      .then(function (r) { if (!r.ok) throw new Error("Server said " + r.status); return r.json(); });
  }
  function nextId() {
    var d = new Date(), pre = "WND-" + String(d.getFullYear()).slice(2) + ("0" + (d.getMonth() + 1)).slice(-2) + "-", max = 0;
    cache.forEach(function (p) { if (p.id.indexOf(pre) === 0) max = Math.max(max, parseInt(p.id.slice(pre.length), 10) || 0); });
    return pre + ("000" + (max + 1)).slice(-4);
  }

  var Store = {
    OPEN: OPEN,
    isOpen: function (p) { return !!OPEN[p.status]; },
    all: function () { return cache; },
    onChange: function (f) { listeners.push(f); },
    refresh: function () {
      if (CFG.apiBase) return api("/wnd-pos").then(function (l) { cache = l; emit(); return cache; });
      cache = readLocal(); emit(); return Promise.resolve(cache);
    },
    create: function (po, by) {
      var now = new Date().toISOString();
      po.created = now; po.createdBy = by; po.status = "Requested"; po.odooRef = "";
      po.history = [{ st: "Requested", at: now, by: by }];
      if (CFG.apiBase) return api("/wnd-pos", { method: "POST", body: JSON.stringify(po) }).then(function (p) { cache.unshift(p); emit(); return p; });
      cache = readLocal(); po.id = nextId(); cache.unshift(po); writeLocal(); emit(); return Promise.resolve(po);
    },
    can: function (po, action) { var r = NEXT[action]; return !!r && r[0].indexOf(po.status) >= 0; },
    act: function (id, action, by, note) {
      var r = NEXT[action];
      if (CFG.apiBase) return api("/wnd-pos/" + encodeURIComponent(id) + "/" + action, { method: "POST", body: JSON.stringify({ note: note || "" }) })
        .then(function (p) { cache = cache.map(function (x) { return x.id === id ? p : x; }); emit(); return p; });
      cache = readLocal();
      var po = cache.filter(function (x) { return x.id === id; })[0];
      if (!po || !r || r[0].indexOf(po.status) < 0) return Promise.reject(new Error("This PO can no longer be changed"));
      po.status = r[1]; po.history.push({ st: r[1], at: new Date().toISOString(), by: by, note: note || "" });
      writeLocal(); emit(); return Promise.resolve(po);
    },
    clearDemo: function () { cache = []; writeLocal(); emit(); }
  };
  window.addEventListener("storage", function (e) { if (e.key === KEY && !CFG.apiBase) { cache = readLocal(); emit(); } });
  window.OVStore = Store;
})();
