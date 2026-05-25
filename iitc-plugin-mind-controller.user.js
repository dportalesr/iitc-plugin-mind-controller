// ==UserScript==
// @id             iitc-plugin-mind-controller@dportalesr
// @name           IITC plugin: Mind Controller
// @category       Draw
// @version        0.1.0
// @namespace      https://github.com/dportalesr/iitc-plugin-mind-controller
// @description    Plan fields with portal-snapped links, anchor-to-many drawing, crosslink detection (drawn vs drawn and drawn vs real), and under-field link-length validation (2 km cap). Stores into iitc-plugin-draw-tools so links persist and export with the rest. Requires: iitc-plugin-draw-tools. Soft-uses: iitc-plugin-crosslinks.
// @include        https://intel.ingress.com/*
// @match          https://intel.ingress.com/*
// @grant          none
// ==/UserScript==

function wrapper(plugin_info) {
  if (typeof window.plugin !== 'function') window.plugin = function () {};

  // PLUGIN START //

  window.plugin.mindController = {};
  var self = window.plugin.mindController;

  // ====================================================================
  // CONFIG — tweak anything below to your taste. All visual / behavior
  // knobs live here so they're easy to find later.
  // ====================================================================
  self.OPTIONS = {
    // --- Snap behavior ---
    snapPx:           25,    // max layer-point distance for a click to count as "on a portal"
    linkableZoom:     15,    // below this zoom, field-state detection is treated as "unknown"

    // --- Length rule ---
    maxUnderFieldM:   2000,  // Niantic under-field max link length (meters) — 2 km since Jan 2024

    // --- Hook debounce ---
    recheckDebounceMs: 500,

    // --- F1: missed-click flash (clicked off-portal) ---
    miss: { color: '#ff66cc', radius: 14, weight: 3, durationMs: 450 },

    // --- F1/F3: anchor / origin halo ---
    originHalo: { color: '#00bfff', radius: 10, weight: 3 }, // shown after first single-link click
    anchorHalo: { color: '#00bfff', radius: 14, weight: 3 }, // shown around multi-link anchor

    // --- F2: crosslink styling ---
    crosslink: {
      lineColor:     '#ff00ff',
      lineWeight:    4,
      lineOpacity:   1,
      dashArray:     '5,5',
      markerColor:   '#ff00ff',
      markerFill:    '#ffffff',
      markerRadius:  4,
      markerWeight:  2
    },

    // --- F4: length × field state colors ---
    length: {
      validColor:        '#00ff00', // <= maxUnderFieldM
      invalidColor:      '#ff0000', // > maxUnderFieldM
      invalidDashArray:  '5,5',
      lineWeight:        4,
      opacityUnderField: 1.0,       // applied when field state == 'under'
      opacityUnknown:    0.6        // applied when field state == 'unknown' (faded)
      // when state == 'not_under', the link inherits draw-tools' default style (see fallbackLine)
    },

    // --- Fallback style if draw-tools.lineOptions isn't present ---
    fallbackLine: { color: '#a24ac3', weight: 4, opacity: 1 },

    // --- Toolbox active-mode button style ---
    activeBtnCss: '.mindController-active{background:#a24ac3 !important;color:#fff !important;font-weight:bold;}'
  };
  // ====================================================================

  // ---- Runtime state ----
  self.mode              = null;  // 'single' | 'multi' | null
  self.pendingOrigin     = null;  // {guid, latlng}
  self.anchorGuid        = null;
  self.anchorHalo        = null;  // L.circleMarker (shared between single-pending and multi-anchor)
  self.crossMarkersLayer = null;  // L.LayerGroup
  self.crossingLinkIds   = null;  // Set<leaflet_id>
  self.recheckRunning    = false;
  self.buttons           = {};

  // ====================================================================
  // Helpers
  // ====================================================================

  self.debounce = function (fn, ms) {
    var t = null;
    return function () {
      var ctx = this, args = arguments;
      if (t) clearTimeout(t);
      t = setTimeout(function () { fn.apply(ctx, args); }, ms);
    };
  };

  self.nearestPortalToLatLng = function (latlng) {
    var map = window.map;
    if (!map) return null;
    var clickPt = map.latLngToLayerPoint(latlng);
    var bounds  = map.getBounds();
    var best = null;
    for (var guid in window.portals) {
      var p   = window.portals[guid];
      var pll = p.getLatLng();
      if (!bounds.contains(pll)) continue;
      var d = clickPt.distanceTo(map.latLngToLayerPoint(pll));
      if (!best || d < best.pxDist) best = { guid: guid, portal: p, latlng: pll, pxDist: d };
    }
    return best;
  };

  self.flashMiss = function (latlng) {
    var o = self.OPTIONS.miss;
    var m = L.circleMarker(latlng, { radius: o.radius, color: o.color, weight: o.weight, fill: false, interactive: false }).addTo(window.map);
    setTimeout(function () { window.map.removeLayer(m); }, o.durationMs);
  };

  self.forEachDrawnLink = function (cb) {
    var dt = window.plugin.drawTools;
    if (!dt || !dt.drawnItems) return;
    dt.drawnItems.eachLayer(function (layer) {
      if (!(layer instanceof L.Polyline) || layer instanceof L.Polygon) return;
      if (layer.getLatLngs().length === 2) cb(layer);
    });
  };

  self.addDrawnLink = function (a, b) {
    var dt = window.plugin.drawTools;
    var base = (dt && dt.lineOptions) || self.OPTIONS.fallbackLine;
    var line = L.geodesicPolyline
      ? L.geodesicPolyline([a, b], L.extend({}, base))
      : L.polyline([a, b], L.extend({}, base));
    dt.drawnItems.addLayer(line);
    self.recheckLink(line);
    self.suppressNextHook = true;
    window.runHooks('pluginDrawTools', { event: 'layerCreated', layer: line });
    if (typeof dt.save === 'function') dt.save();
    return line;
  };

  // ====================================================================
  // F2 — Great-circle arc math (embedded fallback; returns intersection LatLng or null)
  // ====================================================================

  function toCartesian(ll) {
    var lat = ll.lat * Math.PI / 180;
    var lon = ll.lng * Math.PI / 180;
    var c = Math.cos(lat);
    return [c * Math.cos(lon), c * Math.sin(lon), Math.sin(lat)];
  }
  function fromCartesian(v) {
    var lat = Math.atan2(v[2], Math.sqrt(v[0] * v[0] + v[1] * v[1])) * 180 / Math.PI;
    var lon = Math.atan2(v[1], v[0]) * 180 / Math.PI;
    return L.latLng(lat, lon);
  }
  function vCross(a, b) {
    return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  }
  function vDot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
  function vNorm(v) {
    var n = Math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]);
    return n === 0 ? v : [v[0] / n, v[1] / n, v[2] / n];
  }
  function sgn(x) { return x > 0 ? 1 : x < 0 ? -1 : 0; }

  self.greatCircleArcIntersect = function (a0, a1, b0, b1) {
    var ca0 = toCartesian(a0), ca1 = toCartesian(a1);
    var cb0 = toCartesian(b0), cb1 = toCartesian(b1);
    var p = vCross(ca0, ca1);
    var q = vCross(cb0, cb1);
    var t = vNorm(vCross(p, q));
    if (t[0] === 0 && t[1] === 0 && t[2] === 0) return null;

    function within(c0, c1, plane, point) {
      var s0 = vDot(vCross(c0, plane), point);
      var s1 = vDot(vCross(c1, plane), point);
      return sgn(s0) === -sgn(s1) && sgn(s0) !== 0;
    }
    if (within(ca0, ca1, p, t)  && within(cb0, cb1, q, t))  return fromCartesian(t);
    var nt = [-t[0], -t[1], -t[2]];
    if (within(ca0, ca1, p, nt) && within(cb0, cb1, q, nt)) return fromCartesian(nt);
    return null;
  };

  // ====================================================================
  // F2 — Crosslink detection
  // ====================================================================

  self.linkCrossings = function (layer) {
    var lls = layer.getLatLngs();
    var a0 = lls[0], a1 = lls[1];
    var out = [];

    self.forEachDrawnLink(function (other) {
      if (other._leaflet_id === layer._leaflet_id) return;
      var olls = other.getLatLngs();
      var pt = self.greatCircleArcIntersect(a0, a1, olls[0], olls[1]);
      if (pt) out.push({ kind: 'drawn', latlng: pt });
    });

    if (window.links) {
      for (var guid in window.links) {
        var lk = window.links[guid];
        var llls = lk.getLatLngs();
        if (!llls || llls.length !== 2) continue;
        var pt2 = self.greatCircleArcIntersect(a0, a1, llls[0], llls[1]);
        if (pt2) out.push({ kind: 'real', latlng: pt2 });
      }
    }
    return out;
  };

  self.applyCrosslinkStyle = function (layer, crossing) {
    if (crossing) {
      self.crossingLinkIds.add(layer._leaflet_id);
      var c = self.OPTIONS.crosslink;
      layer.setStyle({ color: c.lineColor, dashArray: c.dashArray, weight: c.lineWeight, opacity: c.lineOpacity });
    } else {
      self.crossingLinkIds.delete(layer._leaflet_id);
    }
  };

  self.dropCrossMarker = function (latlng) {
    var c = self.OPTIONS.crosslink;
    L.circleMarker(latlng, {
      radius: c.markerRadius, color: c.markerColor, weight: c.markerWeight,
      fillColor: c.markerFill, fillOpacity: 1, interactive: false
    }).addTo(self.crossMarkersLayer);
  };

  self.recheckAllCrossings = function () {
    if (!self.crossMarkersLayer) return;
    self.crossMarkersLayer.clearLayers();
    self.crossingLinkIds.clear();
    self.forEachDrawnLink(function (layer) {
      var hits = self.linkCrossings(layer);
      self.applyCrosslinkStyle(layer, hits.length > 0);
      hits.forEach(function (h) { self.dropCrossMarker(h.latlng); });
    });
  };

  // ====================================================================
  // F4 — Length × field validation
  // ====================================================================

  self.linkLengthMeters = function (layer) {
    var lls = layer.getLatLngs();
    return lls[0].distanceTo(lls[1]);
  };

  self.isPointInSphericalTriangle = function (p, v0, v1, v2) {
    var cp = toCartesian(p);
    var c0 = toCartesian(v0), c1 = toCartesian(v1), c2 = toCartesian(v2);
    var s1 = sgn(vDot(vCross(c0, c1), cp));
    var s2 = sgn(vDot(vCross(c1, c2), cp));
    var s3 = sgn(vDot(vCross(c2, c0), cp));
    return (s1 !== 0 && s1 === s2 && s2 === s3);
  };

  self.arcCrossesTriangle = function (a, b, tri) {
    return !!(
      self.greatCircleArcIntersect(a, b, tri[0], tri[1]) ||
      self.greatCircleArcIntersect(a, b, tri[1], tri[2]) ||
      self.greatCircleArcIntersect(a, b, tri[2], tri[0])
    );
  };

  self.linkFieldState = function (layer) {
    if (!window.map || window.map.getZoom() < self.OPTIONS.linkableZoom) return 'unknown';
    if (!window.fields) return 'unknown';
    var hasFields = false;
    for (var k in window.fields) { hasFields = true; break; }
    if (!hasFields) return 'unknown';

    var lls = layer.getLatLngs();
    var a = lls[0], b = lls[1];

    for (var fid in window.fields) {
      var tri = window.fields[fid].getLatLngs();
      // L.Polygon may return nested array [[ll,ll,ll]] — normalize:
      if (tri.length === 1 && Array.isArray(tri[0])) tri = tri[0];
      if (tri.length < 3) continue;
      if (self.isPointInSphericalTriangle(a, tri[0], tri[1], tri[2])
       || self.isPointInSphericalTriangle(b, tri[0], tri[1], tri[2])
       || self.arcCrossesTriangle(a, b, tri)) return 'under';
    }
    return 'not_under';
  };

  self.recolorLink = function (layer) {
    if (self.crossingLinkIds.has(layer._leaflet_id)) return; // F2 wins
    var L_ = self.OPTIONS.length;
    var state = self.linkFieldState(layer);
    var over  = self.linkLengthMeters(layer) > self.OPTIONS.maxUnderFieldM;

    if (state === 'not_under') {
      var def = (window.plugin.drawTools && window.plugin.drawTools.lineOptions) || self.OPTIONS.fallbackLine;
      layer.setStyle({ color: def.color, opacity: def.opacity || 1, dashArray: null, weight: def.weight || L_.lineWeight });
      return;
    }

    layer.setStyle({
      color:     over ? L_.invalidColor : L_.validColor,
      opacity:   state === 'unknown' ? L_.opacityUnknown : L_.opacityUnderField,
      dashArray: over ? L_.invalidDashArray : null,
      weight:    L_.lineWeight
    });
  };

  self.recheckLink = function (layer) {
    var hits = self.linkCrossings(layer);
    self.applyCrosslinkStyle(layer, hits.length > 0);
    hits.forEach(function (h) { self.dropCrossMarker(h.latlng); });
    self.recolorLink(layer);
  };

  self.recheckAll = function () {
    if (self.recheckRunning) return;
    self.recheckRunning = true;
    try {
      self.recheckAllCrossings();
      self.forEachDrawnLink(function (layer) { self.recolorLink(layer); });
    } finally {
      self.recheckRunning = false;
    }
  };

  // ====================================================================
  // F1 — Single-link snapped drawing (snap mandatory, no free-form)
  // ====================================================================

  self.onMapClickSnap = function (e) {
    if (self.mode !== 'single') return;
    var hit = self.nearestPortalToLatLng(e.latlng);
    if (!hit || hit.pxDist > self.OPTIONS.snapPx) { self.flashMiss(e.latlng); return; }
    L.DomEvent.stopPropagation(e);

    if (!self.pendingOrigin) {
      self.pendingOrigin = { guid: hit.guid, latlng: hit.latlng };
      var o = self.OPTIONS.originHalo;
      self.anchorHalo = L.circleMarker(hit.latlng, { radius: o.radius, color: o.color, weight: o.weight, fill: false, interactive: false }).addTo(window.map);
      return;
    }
    if (hit.guid === self.pendingOrigin.guid) { self.flashMiss(e.latlng); return; }
    self.addDrawnLink(self.pendingOrigin.latlng, hit.latlng);
    if (self.anchorHalo) { window.map.removeLayer(self.anchorHalo); self.anchorHalo = null; }
    self.pendingOrigin = null;
  };

  // ====================================================================
  // F3 — Multi-target (one anchor → many)
  // ====================================================================

  self.drawAnchorHalo = function (latlng) {
    var o = self.OPTIONS.anchorHalo;
    self.anchorHalo = L.circleMarker(latlng, { radius: o.radius, color: o.color, weight: o.weight, fill: false, interactive: false }).addTo(window.map);
  };

  self.clearAnchor = function () {
    if (self.anchorHalo) { window.map.removeLayer(self.anchorHalo); self.anchorHalo = null; }
    self.anchorGuid = null;
  };

  self.onPortalSelectedMulti = function (data) {
    if (self.mode !== 'multi') return;
    var guid = data.selectedPortalGuid || data.guid;
    if (!guid || !window.portals[guid]) return;
    var ll = window.portals[guid].getLatLng();
    if (!self.anchorGuid) { self.anchorGuid = guid; self.drawAnchorHalo(ll); return; }
    if (guid === self.anchorGuid) return;
    var anchorLL = window.portals[self.anchorGuid] && window.portals[self.anchorGuid].getLatLng();
    if (!anchorLL) return;
    self.addDrawnLink(anchorLL, ll);
  };

  // ====================================================================
  // Mode + UI
  // ====================================================================

  self.setMode = function (name) {
    var next = self.mode === name ? null : name;
    if (self.mode === 'single' && next !== 'single' && self.anchorHalo) {
      window.map.removeLayer(self.anchorHalo); self.anchorHalo = null; self.pendingOrigin = null;
    }
    if (self.mode === 'multi' && next !== 'multi') self.clearAnchor();
    self.mode = next;

    ['single', 'multi'].forEach(function (k) {
      var btn = self.buttons[k];
      if (!btn) return;
      if (self.mode === k) btn.classList.add('mindController-active');
      else                 btn.classList.remove('mindController-active');
    });

    document.body.style.cursor = self.mode ? 'crosshair' : '';
  };

  self.injectStyle = function () {
    var s = document.createElement('style');
    s.textContent = self.OPTIONS.activeBtnCss;
    document.head.appendChild(s);
  };

  self.buildUI = function () {
    function add(label, onClick) {
      var a = document.createElement('a');
      a.textContent = label;
      a.href = '#';
      a.title = label;
      a.onclick = function (e) { e.preventDefault(); onClick(); return false; };
      $('#toolbox').append(a);
      return a;
    }
    self.buttons.single  = add('MC: Single Link', function () { self.setMode('single'); });
    self.buttons.multi   = add('MC: Multi Link',  function () { self.setMode('multi'); });
    self.buttons.recheck = add('MC: Recheck',     function () { self.recheckAll(); });
  };

  // ====================================================================
  // Boot
  // ====================================================================

  var setup = function () {
    if (!window.plugin || !window.plugin.drawTools) {
      alert('mindController requires iitc-plugin-draw-tools — install it first.');
      return;
    }

    self.crossingLinkIds   = new Set();
    self.crossMarkersLayer = L.layerGroup().addTo(window.map);

    self.injectStyle();
    self.buildUI();

    var debouncedRecheck = self.debounce(self.recheckAll, self.OPTIONS.recheckDebounceMs);

    window.map.on('click', self.onMapClickSnap);
    window.addHook('portalSelected',    self.onPortalSelectedMulti);
    window.addHook('linkAdded',         debouncedRecheck);
    window.addHook('linkRemoved',       debouncedRecheck);
    window.addHook('mapDataRefreshEnd', debouncedRecheck);
    window.addHook('pluginDrawTools',   function () {
      if (self.suppressNextHook) { self.suppressNextHook = false; return; }
      debouncedRecheck();
    });

    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && self.mode) self.setMode(null);
    });

    setTimeout(self.recheckAll, 800);
  };

  // PLUGIN END //

  setup.info = plugin_info;
  if (!window.bootPlugins) window.bootPlugins = [];
  window.bootPlugins.push(setup);
  if (window.iitcLoaded && typeof setup === 'function') setup();
}

var script = document.createElement('script');
var info = {};
if (typeof GM_info !== 'undefined' && GM_info && GM_info.script) {
  info.script = {
    version:     GM_info.script.version,
    name:        GM_info.script.name,
    description: GM_info.script.description
  };
}
script.appendChild(document.createTextNode('(' + wrapper + ')(' + JSON.stringify(info) + ');'));
(document.body || document.head || document.documentElement).appendChild(script);
