/* Tiny dependency-free SVG line chart (works offline / from file://) */
window.OVCharts = (function () {
  "use strict";
  var NS = "http://www.w3.org/2000/svg";
  var fmt = new Intl.NumberFormat("en-IN", { maximumFractionDigits: 0 });

  function el(name, attrs, parent) {
    var n = document.createElementNS(NS, name);
    for (var k in attrs) n.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(n);
    return n;
  }

  function niceMax(v) {
    if (v <= 0) return 4;
    var p = Math.pow(10, Math.floor(Math.log10(v)));
    var f = v / p;
    var n = f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10;
    return n * p;
  }

  /**
   * lineChart(container, {labels:[], series:[{name,color,values:[num|null], hollowLast:bool}], tipTitle:fn(i)})
   */
  function lineChart(host, cfg) {
    host.innerHTML = "";
    var W = Math.max(host.clientWidth, 320), H = Math.max(host.clientHeight, 220);
    var n = cfg.labels.length;
    var max = 0;
    cfg.series.forEach(function (s) { s.values.forEach(function (v) { if (v != null && v > max) max = v; }); });
    var top = niceMax(max * 1.05), ticks = 4;
    var m = { l: Math.max(36, fmt.format(top).length * 7 + 16), r: 14, t: 12, b: 28 };
    var iw = W - m.l - m.r, ih = H - m.t - m.b;

    var svg = el("svg", { viewBox: "0 0 " + W + " " + H, role: "img", "aria-label": cfg.aria || "Line chart" }, host);
    var x = function (i) { return m.l + (n <= 1 ? iw / 2 : (iw * i) / (n - 1)); };
    var y = function (v) { return m.t + ih - (v / top) * ih; };

    for (var t = 0; t <= ticks; t++) {
      var val = (top / ticks) * t, yy = y(val);
      el("line", { x1: m.l, x2: W - m.r, y1: yy, y2: yy, class: "gl" }, svg);
      var tx = el("text", { x: m.l - 7, y: yy + 4, "text-anchor": "end", class: "ax" }, svg);
      tx.textContent = fmt.format(val);
    }
    var every = n > 16 ? Math.ceil(n / 11) : 1;
    cfg.labels.forEach(function (lb, i) {
      if (i % every !== 0 && i !== n - 1) return;
      var tx = el("text", { x: x(i), y: H - 8, "text-anchor": "middle", class: "ax" }, svg);
      tx.textContent = lb;
    });

    cfg.series.forEach(function (s) {
      var d = "", pen = false, last = -1;
      s.values.forEach(function (v, i) {
        if (v == null) { pen = false; return; }
        d += (pen ? "L" : "M") + x(i).toFixed(1) + " " + y(v).toFixed(1);
        pen = true; last = i;
      });
      el("path", { d: d, fill: "none", stroke: s.color, "stroke-width": 2.4, "stroke-linejoin": "round", "stroke-linecap": "round", opacity: s.faded ? 0.9 : 1 }, svg);
      s.values.forEach(function (v, i) {
        if (v == null) return;
        var hollow = s.hollowLast && i === last;
        if (n <= 14 || hollow) {
          el("circle", { cx: x(i), cy: y(v), r: hollow ? 4.2 : 3, fill: hollow ? "#fff" : s.color, stroke: s.color, "stroke-width": hollow ? 2 : 0 }, svg);
        }
      });
    });

    // hover
    var guide = el("line", { y1: m.t, y2: m.t + ih, stroke: "#8A96A8", "stroke-dasharray": "3 3", opacity: 0 }, svg);
    var tip = document.createElement("div");
    tip.className = "tip"; tip.style.display = "none"; host.appendChild(tip);
    var hit = el("rect", { x: m.l, y: m.t, width: iw, height: ih, fill: "transparent" }, svg);
    hit.addEventListener("mousemove", function (e) {
      var r = svg.getBoundingClientRect();
      var px = ((e.clientX - r.left) / r.width) * W;
      var i = Math.max(0, Math.min(n - 1, Math.round(((px - m.l) / iw) * (n - 1))));
      guide.setAttribute("x1", x(i)); guide.setAttribute("x2", x(i)); guide.setAttribute("opacity", 1);
      var html = "<b>" + (cfg.tipTitle ? cfg.tipTitle(i) : cfg.labels[i]) + "</b>";
      cfg.series.forEach(function (s) {
        var v = s.values[i];
        html += "<span><i style='background:" + s.color + "'></i>" + s.name + ": <b style='display:inline;margin:0'>" + (v == null ? "–" : fmt.format(v)) + "</b></span>";
      });
      tip.innerHTML = html; tip.style.display = "block";
      var tw = tip.offsetWidth, left = (x(i) / W) * r.width + 12;
      if (left + tw > r.width) left = (x(i) / W) * r.width - tw - 12;
      tip.style.left = Math.max(0, left) + "px"; tip.style.top = "8px";
    });
    hit.addEventListener("mouseleave", function () { guide.setAttribute("opacity", 0); tip.style.display = "none"; });
  }

  return { lineChart: lineChart };
})();
