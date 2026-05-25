// ==UserScript==
// @id             iitc-plugin-mind-controller@dportalesr
// @name           IITC plugin: Mind Controller
// @category       Draw
// @version        0.1.0
// @namespace      https://github.com/dportalesr/iitc-plugin-mind-controller
// @description    Plan fields with portal-snapped links, anchor-to-many drawing, crosslink detection (drawn vs drawn and drawn vs real), under-field link-length validation (2 km cap), and link-direction hinting (origin-dashing on in-game + drawn links; replaces "Direction of links on map"). Stores into iitc-plugin-draw-tools so links persist and export with the rest. Requires: iitc-plugin-draw-tools. Soft-uses: iitc-plugin-crosslinks.
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
    // Crossing links recolour to the same red as "length-invalid" links —
    // both mean "this is illegal". A red-on-white dot is placed at each
    // exact crossing point so you can still tell crossings from over-length.
    crosslink: {
      // Crossings are shown by colour + an intersection marker, not by dashing,
      // so they stay legible alongside the origin-dashing this plugin also
      // applies for direction (see linkDirection).
      //   drawn link that only crosses other drawn → drawnCrossDrawnColor (orange, softer)
      //   drawn link that crosses any real link    → drawnCrossRealColor  (red)
      //   real link that's crossed by a drawn      → red overlay drawn on top
      //   both kinds at once                       → red wins (real-link conflict is the harder constraint)
      drawnCrossDrawnColor: '#ff8c00',
      drawnCrossRealColor:  '#ff0000',
      realCrossedColor:     '#ff0000',
      lineWeight:           4,
      lineOpacity:          1,
      // Intersection markers
      markerColor:          '#ffffff',
      markerFill:           '#ff0000',
      markerRadius:         8,
      markerWeight:         3,
      markerFillOpacity:    1,
      // Real-link overlay (solid stroke on top of the in-game link)
      realLinkWeight:       5,
      realLinkOpacity:      0.85
    },

    // --- F4: length × field state palette ---
    // Three colours only:
    //   valid                  → yellow  (default, under-field ≤ 2 km, or not under any field)
    //   invalid                → red     (under-field & > 2 km)
    //   potentiallyInvalid     → orange  (> 2 km, but field state unknown — likely illegal once a field appears)
    length: {
      validColor:              '#ffd700',
      invalidColor:            '#ff0000',
      potentiallyInvalidColor: '#ff8c00',
      lineWeight:              4
    },

    // --- Default style for every link this plugin draws. Yellow, like the
    // original draw-tools polyline. Used both at draw time and when the F4
    // "not under any field" rule resets the link to its baseline look.
    // Set to null to inherit `window.plugin.drawTools.lineOptions` instead.
    defaultLine: { color: '#ffd700', weight: 4, opacity: 1 },

    // --- Delete-marker shown at the midpoint of each drawn link's visible
    // portion (mirrors native intel's yellow-circle "×" buttons). Click
    // removes the link. Hover lifts the brightness slightly instead of
    // swapping colours, so the button reads as the same affordance.
    deleteMarker: {
      enabled:         true,
      size:            20,                            // px (square)
      bg:              '#ffd700',                     // match the link colour
      border:          'transparent',
      color:           '#663300',                     // brown — reads on the gold chip (incl. the brightened hover state)
      font:            'bold 16px system-ui, sans-serif',
      xFontSize:       '24px',                         // × glyph only — bigger than the chevron, which keeps the base font size
      hoverBrightness: 1.25
    },

    // --- Link direction — replaces the "Direction of links on map"
    // (link-show-direction) community plugin. Dashes the FIRST stretch of
    // every link, measured from its origin, and leaves the rest a single solid
    // run, so each link reads "this end is the source".
    //
    // We style each link's OWN stroke (not an overlay), so the gaps are
    // transparent negative space and the dashes show in the link's own colour
    // (faction blue/green for in-game links, the length/crosslink palette for
    // drawn links). The pattern is pixel-based — a few small dashes then a
    // 100000px "solid tail" — so it needs no SVG pathLength trick and survives
    // zoom/redraw untouched, which the previous percentage-based attempt did
    // not (it collapsed to solid). This is the reference plugin's default
    // "Static near origin" mode.
    linkDirection: {
      enabledByDefault: true,
      applyToReal:      true,   // dash in-game links
      applyToDrawn:     true,   // dash our drawn planning links
      dashArray:        '10,5,5,5,5,5,5,5,100000'
    },

    // --- Direction marker on each drawn link's midpoint chip.
    // By default the chip shows a chevron/triangle rotated to the link's screen
    // bearing (origin → destination), so direction reads at a glance on every
    // link; hovering the chip swaps it for the × delete affordance. It's the
    // same single chip as the delete button — no extra chrome.
    directionMarker: {
      enabled: true,
      glyph:   '▶',
      color:   '#663300'   // brown — matches the × glyph; reads against the gold chip
    },

    // --- Toolbox active-mode button style ---
    activeBtnCss: '.mindController-active{background:#a24ac3 !important;color:#fff !important;font-weight:bold;}',

    // --- Keyboard shortcuts. Format: 'l' (bare) / 'Alt+s' / 'Ctrl+Shift+r'.
    // Case-insensitive on the letter. Set to null to disable a binding.
    // Shortcuts are ignored while typing in <input>/<textarea>/contenteditable.
    // Defaults (L / M / R) are not bound by IITC core, draw-tools, or popular plugins;
    // switch to Alt+ variants if you install something that takes them.
    shortcuts: {
      single:    'l',   // toggle Single Link mode (sticky: origin clears after each link; press again to exit)
      multi:     'm',   // toggle Multi Link mode (sticky: anchor stays across many targets)
      recheck:   'r',   // recheck all drawn links (crosslinks + length × field)
      direction: 'd'    // toggle link-direction dashing (in-game + drawn)
    },

    // --- Status banner shown while a mode is active ---
    banner: {
      bg:        'rgba(162, 74, 195, 0.92)',
      color:     '#fff',
      font:      '13px system-ui, sans-serif',
      padding:   '6px 12px',
      radius:    '4px',
      top:       '8px',          // distance from top of viewport
      zIndex:    3000
    }
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
  self.deleteMarkersLayer    = null;  // L.LayerGroup of midpoint × markers
  self.realCrossOverlayLayer = null;  // L.LayerGroup of red overlays on crossed in-game links
  self.directionOn           = false; // link-direction dashing toggle (seeded from OPTIONS at boot)

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

  self.parseShortcut = function (spec) {
    if (!spec) return null;
    var parts = spec.split('+').map(function (p) { return p.trim(); });
    var key = parts.pop().toLowerCase();
    var mods = parts.map(function (m) { return m.toLowerCase(); });
    return { key: key, alt: mods.indexOf('alt') !== -1, ctrl: mods.indexOf('ctrl') !== -1, shift: mods.indexOf('shift') !== -1, meta: mods.indexOf('meta') !== -1 };
  };

  self.matchesShortcut = function (e, spec) {
    var s = self.parseShortcut(spec);
    if (!s) return false;
    return e.key && e.key.toLowerCase() === s.key
        && !!e.altKey   === s.alt
        && !!e.ctrlKey  === s.ctrl
        && !!e.shiftKey === s.shift
        && !!e.metaKey  === s.meta;
  };

  self.buildBanner = function () {
    var b = self.OPTIONS.banner;
    var div = document.createElement('div');
    div.id = 'mindController-banner';
    div.style.cssText =
      'position:fixed;left:50%;transform:translateX(-50%);' +
      'top:' + b.top + ';background:' + b.bg + ';color:' + b.color + ';' +
      'font:' + b.font + ';padding:' + b.padding + ';border-radius:' + b.radius + ';' +
      'z-index:' + b.zIndex + ';pointer-events:none;display:none;box-shadow:0 2px 6px rgba(0,0,0,0.3);';
    document.body.appendChild(div);
    self.bannerEl = div;
  };

  self.updateBanner = function () {
    if (!self.bannerEl) return;
    var msg = null;
    var sExit = self.OPTIONS.shortcuts.single  ? ' / ' + self.OPTIONS.shortcuts.single  : '';
    var mExit = self.OPTIONS.shortcuts.multi   ? ' / ' + self.OPTIONS.shortcuts.multi   : '';

    if (self.mode === 'single') {
      msg = self.pendingOrigin
        ? 'Mind Controller — Single Link: click target portal (Esc' + sExit + ' to exit)'
        : 'Mind Controller — Single Link: click origin portal (Esc' + sExit + ' to exit)';
    } else if (self.mode === 'multi') {
      msg = self.anchorGuid
        ? 'Mind Controller — Multi Link: anchor set, click targets (Esc' + mExit + ' to exit)'
        : 'Mind Controller — Multi Link: click anchor portal (Esc' + mExit + ' to exit)';
    }

    if (msg) { self.bannerEl.textContent = msg; self.bannerEl.style.display = 'block'; }
    else     { self.bannerEl.style.display = 'none'; }
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
    var base = self.OPTIONS.defaultLine || (dt && dt.lineOptions) || { color: '#ffd700', weight: 4, opacity: 1 };
    var line = L.geodesicPolyline
      ? L.geodesicPolyline([a, b], L.extend({}, base))
      : L.polyline([a, b], L.extend({}, base));
    dt.drawnItems.addLayer(line);
    window.runHooks('pluginDrawTools', { event: 'layerCreated', layer: line });
    if (typeof dt.save === 'function') dt.save();
    self.recheckAll(); // full pass — new link may affect crossings of existing links too
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

  // Two arcs sharing a portal endpoint are NOT a crossing in Ingress —
  // and the great-circle intersector returns floating-point noise at the
  // shared point, so we short-circuit before calling it.
  function sharesEndpoint(a0, a1, b0, b1) {
    return a0.equals(b0) || a0.equals(b1) || a1.equals(b0) || a1.equals(b1);
  }

  // Canonical 2-point endpoints for an in-game link. IITC stores them as
  // `options.data.{o,d}{Lat,Lng}E6` integers; the rendered polyline's
  // `getLatLngs()` is densified by Leaflet.Geodesic and would give us a
  // multi-point arc, which fails our 2-point intersection check.
  function realLinkEndpoints(lk) {
    var d = lk && lk.options && lk.options.data;
    if (d && typeof d.oLatE6 === 'number' && typeof d.dLatE6 === 'number') {
      return [L.latLng(d.oLatE6 / 1e6, d.oLngE6 / 1e6),
              L.latLng(d.dLatE6 / 1e6, d.dLngE6 / 1e6)];
    }
    var lls = lk && lk.getLatLngs && lk.getLatLngs();
    if (lls && lls.length >= 2) return [lls[0], lls[lls.length - 1]];
    return null;
  }

  self.linkCrossings = function (layer) {
    var lls = layer.getLatLngs();
    var a0 = lls[0], a1 = lls[1];
    var out = [];

    self.forEachDrawnLink(function (other) {
      if (other._leaflet_id === layer._leaflet_id) return;
      var olls = other.getLatLngs();
      if (sharesEndpoint(a0, a1, olls[0], olls[1])) return;
      var pt = self.greatCircleArcIntersect(a0, a1, olls[0], olls[1]);
      if (pt) out.push({ kind: 'drawn', latlng: pt });
    });

    if (window.links) {
      for (var guid in window.links) {
        var ends = realLinkEndpoints(window.links[guid]);
        if (!ends) continue;
        if (sharesEndpoint(a0, a1, ends[0], ends[1])) continue;
        var pt2 = self.greatCircleArcIntersect(a0, a1, ends[0], ends[1]);
        if (pt2) out.push({ kind: 'real', latlng: pt2, realGuid: guid });
      }
    }
    return out;
  };

  self.applyCrosslinkStyle = function (layer, crossing, hasRealCross) {
    if (!crossing) {
      self.crossingLinkIds.delete(layer._leaflet_id);
      return;
    }
    self.crossingLinkIds.add(layer._leaflet_id);
    var c = self.OPTIONS.crosslink;
    layer.setStyle({
      color:     hasRealCross ? c.drawnCrossRealColor : c.drawnCrossDrawnColor,
      dashArray: self.drawnDashArray(),
      lineCap:   'butt',   // square dash ends — round caps fill the gaps at weight 4
      weight:    c.lineWeight,
      opacity:   c.lineOpacity
    });
  };

  // DOM-based dot (L.marker + divIcon), NOT a vector circleMarker. Many vector
  // markers sharing one renderer in a custom pane can fail to all paint — we saw
  // 7 dots in the layer but only 3 drawn. Independent DOM elements always render
  // (same mechanism as the delete chips, which never had this problem).
  self.dropCrossMarker = function (latlng) {
    var c = self.OPTIONS.crosslink;
    var size = c.markerRadius * 2;
    L.marker(latlng, {
      pane:        'mcCrossings',
      interactive: false,
      keyboard:    false,
      icon: L.divIcon({
        className:  'mc-cross-dot',
        iconSize:   [size, size],
        iconAnchor: [c.markerRadius, c.markerRadius]
      })
    }).addTo(self.crossMarkersLayer);
  };

  self.drawRealLinkOverlay = function (lk) {
    var ends = realLinkEndpoints(lk);
    if (!ends) return;
    var c = self.OPTIONS.crosslink;
    var opts = { color: c.realCrossedColor, weight: c.realLinkWeight, opacity: c.realLinkOpacity, dashArray: null, interactive: false };
    var ovl = L.geodesicPolyline
      ? L.geodesicPolyline([ends[0], ends[1]], opts)
      : L.polyline([ends[0], ends[1]], opts);
    ovl.addTo(self.realCrossOverlayLayer);
  };

  self.recheckAllCrossings = function () {
    if (!self.crossMarkersLayer) return;
    self.crossMarkersLayer.clearLayers();
    self.realCrossOverlayLayer.clearLayers();
    self.crossingLinkIds.clear();

    var crossedRealGuids = {};   // dedupe — one overlay per real link

    self.forEachDrawnLink(function (layer) {
      var hits = self.linkCrossings(layer);
      var hasReal = hits.some(function (h) { return h.kind === 'real'; });
      self.applyCrosslinkStyle(layer, hits.length > 0, hasReal);
      hits.forEach(function (h) {
        self.dropCrossMarker(h.latlng);
        if (h.kind === 'real' && h.realGuid) crossedRealGuids[h.realGuid] = true;
      });
    });

    Object.keys(crossedRealGuids).forEach(function (guid) {
      var lk = window.links && window.links[guid];
      if (lk) self.drawRealLinkOverlay(lk);
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
    if (self.crossingLinkIds.has(layer._leaflet_id)) return; // F2 already applied red
    var L_ = self.OPTIONS.length;
    var state = self.linkFieldState(layer);
    var over  = self.linkLengthMeters(layer) > self.OPTIONS.maxUnderFieldM;

    var color = L_.validColor;                              // yellow (default)
    if (state === 'under'   && over) color = L_.invalidColor;             // red
    else if (state === 'unknown' && over) color = L_.potentiallyInvalidColor; // orange

    layer.setStyle({ color: color, opacity: 1, dashArray: self.drawnDashArray(), lineCap: 'butt', weight: L_.lineWeight });
  };

  self.recheckAll = function () {
    if (self.recheckRunning) return;
    self.recheckRunning = true;
    try {
      self.recheckAllCrossings();
      self.forEachDrawnLink(function (layer) {
        self.recolorLink(layer); // recolor carries the direction dashArray (drawnDashArray)
      });
      self.rebuildDeleteMarkers();
    } finally {
      self.recheckRunning = false;
    }
  };

  // ====================================================================
  // Delete markers — native-intel-style × at the geodesic midpoint
  // ====================================================================

  self.geodesicMidpoint = function (a, b) {
    var ca = toCartesian(a), cb = toCartesian(b);
    return fromCartesian(vNorm([ca[0] + cb[0], ca[1] + cb[1], ca[2] + cb[2]]));
  };

  // Liang-Barsky 2D segment clip against an axis-aligned rectangle.
  // Returns {pa, pb} (clipped endpoints in the same coord system) or null.
  function clipSegment(p0, p1, xmin, ymin, xmax, ymax) {
    var dx = p1.x - p0.x, dy = p1.y - p0.y;
    var p = [-dx, dx, -dy, dy];
    var q = [p0.x - xmin, xmax - p0.x, p0.y - ymin, ymax - p0.y];
    var u1 = 0, u2 = 1;
    for (var i = 0; i < 4; i++) {
      if (p[i] === 0) {
        if (q[i] < 0) return null;
      } else {
        var t = q[i] / p[i];
        if (p[i] < 0) { if (t > u2) return null; if (t > u1) u1 = t; }
        else          { if (t < u1) return null; if (t < u2) u2 = t; }
      }
    }
    return { pa: L.point(p0.x + u1 * dx, p0.y + u1 * dy),
             pb: L.point(p0.x + u2 * dx, p0.y + u2 * dy) };
  }

  // Midpoint of the link's segment clipped to the current viewport.
  // null when the link doesn't intersect the visible area at all.
  self.visibleMidpointForLink = function (layer) {
    var lls = layer.getLatLngs();
    if (lls.length !== 2) return null;
    var p0   = window.map.latLngToContainerPoint(lls[0]);
    var p1   = window.map.latLngToContainerPoint(lls[1]);
    var size = window.map.getSize();
    var clipped = clipSegment(p0, p1, 0, 0, size.x, size.y);
    if (!clipped) return null;
    var mid = L.point((clipped.pa.x + clipped.pb.x) / 2, (clipped.pa.y + clipped.pb.y) / 2);
    return window.map.containerPointToLatLng(mid);
  };

  self.addDeleteMarker = function (layer) {
    var mid = self.visibleMidpointForLink(layer);
    if (!mid) return; // entirely off-screen — no button to show
    var size = self.OPTIONS.deleteMarker.size;

    var html = '<span class="x">×</span>';
    if (self.OPTIONS.directionMarker && self.OPTIONS.directionMarker.enabled) {
      var lls = layer.getLatLngs();
      var pa  = window.map.latLngToContainerPoint(lls[0]);
      var pb  = window.map.latLngToContainerPoint(lls[lls.length - 1]);
      var deg = Math.atan2(pb.y - pa.y, pb.x - pa.x) * 180 / Math.PI;
      html += '<span class="arr" style="transform:rotate(' + deg.toFixed(1) + 'deg);">' +
              self.OPTIONS.directionMarker.glyph + '</span>';
    }

    var marker = L.marker(mid, {
      icon: L.divIcon({
        className: 'mc-delete-icon',
        html: html,
        iconSize:  [size, size],
        iconAnchor:[size / 2, size / 2]
      }),
      interactive: true,
      keyboard:    false,
      zIndexOffset: 1000
    });
    marker.on('click', function (e) {
      L.DomEvent.stopPropagation(e);
      self.deleteDrawnLink(layer);
    });
    marker.addTo(self.deleteMarkersLayer);
  };

  self.deleteDrawnLink = function (layer) {
    var dt = window.plugin.drawTools;
    if (!dt || !dt.drawnItems) return;
    dt.drawnItems.removeLayer(layer);
    self.crossingLinkIds.delete(layer._leaflet_id);
    window.runHooks('pluginDrawTools', { event: 'layerDeleted', layer: layer });
    if (typeof dt.save === 'function') dt.save();
    self.recheckAll();
  };

  self.rebuildDeleteMarkers = function () {
    if (!self.deleteMarkersLayer) return;
    self.deleteMarkersLayer.clearLayers();
    if (!self.OPTIONS.deleteMarker.enabled) return;
    self.forEachDrawnLink(function (layer) { self.addDeleteMarker(layer); });
  };

  // ====================================================================
  // Link direction — replaces the "Direction of links on map"
  // (link-show-direction) community plugin. Dashes the first stretch of every
  // link from its origin (latlngs[0]) and leaves the rest a single solid run,
  // so the link reads "this end is the source". We style each link's OWN
  // stroke, so the gaps are transparent negative space and the dashes show in
  // the link's own colour — no overlay, no contrast hacks. The pattern is
  // pixel-based ('…,100000' = a few small dashes then a huge solid tail), so it
  // needs no SVG pathLength and survives zoom/redraw untouched.
  //
  // Drawn links pick the pattern up through recolorLink / applyCrosslinkStyle
  // (drawnDashArray); in-game links are styled via the linkAdded hook.
  // ====================================================================

  // dashArray for our drawn planning links (null = solid).
  self.drawnDashArray = function () {
    var ld = self.OPTIONS.linkDirection;
    return (self.directionOn && ld.applyToDrawn) ? ld.dashArray : null;
  };

  // dashArray for in-game links (null = solid).
  self.realDashArray = function () {
    var ld = self.OPTIONS.linkDirection;
    return (self.directionOn && ld.applyToReal) ? ld.dashArray : null;
  };

  self.applyDirectionToRealLink = function (lk) {
    if (!lk || typeof lk.setStyle !== 'function') return;
    lk.setStyle({ dashArray: self.realDashArray() });
  };

  self.applyDirectionToAllRealLinks = function () {
    if (!window.links) return;
    for (var guid in window.links) self.applyDirectionToRealLink(window.links[guid]);
  };

  // Toggle (or set, when `on` is a boolean) and re-apply to both link kinds.
  self.toggleLinkDirection = function (on) {
    self.directionOn = (typeof on === 'boolean') ? on : !self.directionOn;
    self.applyDirectionToAllRealLinks(); // in-game links
    self.recheckAll();                   // re-applies drawnDashArray to drawn links
    self.updateDirectionButton();
  };

  self.updateDirectionButton = function () {
    var btn = self.buttons.direction;
    if (!btn) return;
    btn.classList.toggle('mindController-active', !!self.directionOn);
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
      self.drawOriginHalo(hit.latlng);
      self.updateBanner();
      return;
    }
    if (hit.guid === self.pendingOrigin.guid) { self.flashMiss(e.latlng); return; }
    self.addDrawnLink(self.pendingOrigin.latlng, hit.latlng);
    if (self.anchorHalo) { window.map.removeLayer(self.anchorHalo); self.anchorHalo = null; }
    self.pendingOrigin = null;
    // Sticky: mode stays on; next click starts a new link as its origin.
    self.updateBanner();
  };

  // ====================================================================
  // F3 — Multi-target (one anchor → many)
  // ====================================================================

  self.drawAnchorHalo = function (latlng) {
    var o = self.OPTIONS.anchorHalo;
    self.anchorHalo = L.circleMarker(latlng, { radius: o.radius, color: o.color, weight: o.weight, fill: false, interactive: false }).addTo(window.map);
  };

  self.drawOriginHalo = function (latlng) {
    var o = self.OPTIONS.originHalo;
    self.anchorHalo = L.circleMarker(latlng, { radius: o.radius, color: o.color, weight: o.weight, fill: false, interactive: false }).addTo(window.map);
  };

  self.currentlySelectedPortal = function () {
    var guid = window.selectedPortal;
    if (!guid || !window.portals || !window.portals[guid]) return null;
    return { guid: guid, latlng: window.portals[guid].getLatLng() };
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
    if (!self.anchorGuid) { self.anchorGuid = guid; self.drawAnchorHalo(ll); self.updateBanner(); return; }
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

    // Seed origin/anchor from the currently selected portal if any —
    // skipping the otherwise-required first click.
    if (next === 'single' && !self.pendingOrigin) {
      var sp = self.currentlySelectedPortal();
      if (sp) {
        self.pendingOrigin = { guid: sp.guid, latlng: sp.latlng };
        self.drawOriginHalo(sp.latlng);
      }
    }
    if (next === 'multi' && !self.anchorGuid) {
      var sp2 = self.currentlySelectedPortal();
      if (sp2) {
        self.anchorGuid = sp2.guid;
        self.drawAnchorHalo(sp2.latlng);
      }
    }

    ['single', 'multi'].forEach(function (k) {
      var btn = self.buttons[k];
      if (!btn) return;
      if (self.mode === k) btn.classList.add('mindController-active');
      else                 btn.classList.remove('mindController-active');
    });

    document.body.style.cursor = self.mode ? 'crosshair' : '';
    self.updateBanner();
  };

  self.injectStyle = function () {
    var d = self.OPTIONS.deleteMarker;
    var dm = self.OPTIONS.directionMarker;
    var cl = self.OPTIONS.crosslink;
    var glyphColor = (dm && dm.color) || '#222';
    var css = self.OPTIONS.activeBtnCss + '\n' +
      '.mc-delete-icon{' +
        'background:' + d.bg + ';' +
        'border:1px solid ' + d.border + ';' +
        'color:' + d.color + ';' +
        'font:' + d.font + ';' +
        'text-align:center;line-height:' + d.size + 'px;' +
        'border-radius:50%;cursor:pointer;' +
        'box-shadow:0 1px 2px rgba(0,0,0,0.5);' +
        'user-select:none;' +
        'transition:filter 120ms ease-out;' +
      '}' +
      '.mc-delete-icon:hover{filter:brightness(' + d.hoverBrightness + ');}' +
      '.mc-delete-icon .x,.mc-delete-icon .arr{display:inline-block;line-height:' + d.size + 'px;transform-origin:center;}' +
      '.mc-delete-icon .arr{color:' + glyphColor + ';}' +
      '.mc-delete-icon .x{font-size:' + d.xFontSize + ';}' +
      '.mc-cross-dot{box-sizing:border-box;border-radius:50%;background:' + cl.markerFill + ';border:' + cl.markerWeight + 'px solid ' + cl.markerColor + ';}';

    // Direction-by-default: the chip shows the rotated chevron, and hovering it
    // reveals the × delete affordance. When directionMarker is disabled, no .arr
    // span is emitted and the × simply stays visible.
    if (dm && dm.enabled) {
      css +=
        '.mc-delete-icon .x{display:none;}' +
        '.mc-delete-icon:hover .arr{display:none;}' +
        '.mc-delete-icon:hover .x{display:inline-block;}';
    }

    var s = document.createElement('style');
    s.textContent = css;
    document.head.appendChild(s);
  };

  self.buildUI = function () {
    function fmtKey(spec) { return spec ? ' [' + spec.toUpperCase() + ']' : ''; }
    function add(label, onClick, title) {
      var a = document.createElement('a');
      a.textContent = label;
      a.href = '#';
      a.title = title || label;
      a.onclick = function (e) { e.preventDefault(); onClick(); return false; };
      $('#toolbox').append(a);
      return a;
    }
    var sc = self.OPTIONS.shortcuts;
    self.buttons.single  = add('MC: Single Link' + fmtKey(sc.single),
                               function () { self.setMode('single'); },
                               'Draw snapped links (sticky). Origin clears after each link; toggle off to stop.');
    self.buttons.multi   = add('MC: Multi Link' + fmtKey(sc.multi),
                               function () { self.setMode('multi'); },
                               'Pick an anchor portal, then click many targets. Esc/key exits.');
    self.buttons.recheck = add('MC: Recheck' + fmtKey(sc.recheck),
                               function () { self.recheckAll(); },
                               'Re-run crosslink + length validation against current map state.');
    self.buttons.direction = add('MC: Link Direction' + fmtKey(sc.direction),
                               function () { self.toggleLinkDirection(); },
                               'Toggle origin-dashing on in-game and drawn links (direction hint).');
  };

  // ====================================================================
  // Boot
  // ====================================================================

  var setup = function () {
    if (!window.plugin || !window.plugin.drawTools) {
      alert('mindController requires iitc-plugin-draw-tools — install it first.');
      return;
    }

    // Intersection dots are the most important on-map signal, so they get a
    // dedicated pane above everything else — otherwise the red link strokes /
    // real-link overlays (same overlayPane, z 400) paint over them by add order.
    if (!window.map.getPane('mcCrossings')) {
      window.map.createPane('mcCrossings');
      var crossPane = window.map.getPane('mcCrossings');
      crossPane.style.zIndex = 650;           // above overlayPane (400) and markerPane (600)
      crossPane.style.pointerEvents = 'none'; // dots are non-interactive
    }

    self.crossingLinkIds       = new Set();
    self.crossMarkersLayer     = L.layerGroup().addTo(window.map);
    self.realCrossOverlayLayer = L.layerGroup().addTo(window.map);
    self.deleteMarkersLayer    = L.layerGroup().addTo(window.map);

    self.injectStyle();
    self.buildBanner();
    self.buildUI();

    self.directionOn = !!self.OPTIONS.linkDirection.enabledByDefault;
    self.updateDirectionButton();

    var debouncedRecheck = self.debounce(self.recheckAll, self.OPTIONS.recheckDebounceMs);
    var debouncedRealDirection = self.debounce(self.applyDirectionToAllRealLinks, self.OPTIONS.recheckDebounceMs);

    window.map.on('click', self.onMapClickSnap);
    window.addHook('portalSelected',    self.onPortalSelectedMulti);
    window.addHook('linkAdded',         debouncedRecheck);
    window.addHook('linkRemoved',       debouncedRecheck);
    window.addHook('mapDataRefreshEnd', debouncedRecheck);
    window.addHook('pluginDrawTools',   debouncedRecheck);

    // Link direction on in-game links: style each link as it's added, and
    // re-apply across a data refresh (links are recreated). The drawn-link
    // dashing rides along inside recheckAll via drawnDashArray.
    window.addHook('linkAdded',         function (d) { if (d && d.link) self.applyDirectionToRealLink(d.link); });
    window.addHook('mapDataRefreshEnd', debouncedRealDirection);
    self.applyDirectionToAllRealLinks();

    // Reposition × buttons whenever the visible area changes. Link-direction
    // dashing is pixel-based on each link's own stroke, so Leaflet keeps it
    // across pan/zoom redraws — no rebuild needed here.
    var debouncedOverlayRebuild = self.debounce(function () {
      self.rebuildDeleteMarkers();
    }, 60);
    window.map.on('moveend', debouncedOverlayRebuild);
    window.map.on('resize',  debouncedOverlayRebuild);

    document.addEventListener('keydown', function (e) {
      var t = e.target;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;

      if (e.key === 'Escape' && self.mode) { self.setMode(null); return; }

      var sc = self.OPTIONS.shortcuts;
      if (self.matchesShortcut(e, sc.single))  { e.preventDefault(); self.setMode('single');  return; }
      if (self.matchesShortcut(e, sc.multi))   { e.preventDefault(); self.setMode('multi');   return; }
      if (self.matchesShortcut(e, sc.recheck)) { e.preventDefault(); self.recheckAll();       return; }
      if (self.matchesShortcut(e, sc.direction)) { e.preventDefault(); self.toggleLinkDirection(); return; }
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
