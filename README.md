# IITC plugin: Mind Controller

A planning aid for [IITC](https://iitc.app/) (Ingress Intel Total Conversion). Named after the **Mind Controller** medal because it exists to help you plan **Control Fields** — by drawing precise, portal-snapped planning links and immediately telling you when those links are illegal.

It adds five things on top of `iitc-plugin-draw-tools`:

1. **Portal-snapped link drawing.** Every click is forced to the centre of the nearest portal. No more arbitrary midair vertices.
2. **Crosslink detection.** Every drawn link is continuously checked against (a) every other drawn link and (b) every real in-game link visible on the map. Crossings are highlighted.
3. **Multi-target mode.** Pick an anchor portal once; click many destinations to fan links out from the same origin.
4. **Length × field validation.** Drawn links are coloured by the 2 km under-field rule (Niantic, [Jan 2024](https://ingress.com/en/news/2024-matryoshkalink2km)) — yellow when valid, red when illegal (crossing a real link or breaking the 2 km rule under a known field), orange when only the drawn plan is in conflict or the field state can't be determined.
5. **Link direction.** Dashes the first stretch of every link from its origin so you can read which portal is the source at a glance. Applies to **in-game links** and **drawn links** alike — a drop-in replacement for the *Direction of links on map* community plugin (its default "Static near origin" mode).

Drawn links live inside `window.plugin.drawTools.drawnItems`, so they persist, export, and import alongside everything else you draw.

---

## Requirements

| Plugin                       | Why                                                                 |
| ---------------------------- | ------------------------------------------------------------------- |
| `iitc-plugin-draw-tools`     | **Required.** Storage, persistence, export/import.                  |
| `iitc-plugin-crosslinks`     | Optional. If present its `greatCircleArcIntersect` is used; otherwise an embedded copy is used. |

## Installation

1. Install [IITC](https://iitc.app/) in Tampermonkey or Violentmonkey.
2. Install `iitc-plugin-draw-tools`.
3. Install this userscript: open `iitc-plugin-mind-controller.user.js` in your browser → your userscript manager will prompt to install.
4. Reload [intel.ingress.com](https://intel.ingress.com).

You should see four new entries in the IITC toolbox: **MC: Single Link [L]**, **MC: Multi Link [M]**, **MC: Recheck [R]**, **MC: Link Direction [D]**.

---

## How to use it

### Single Link mode

| Step              |                                                                                                       |
| ----------------- | ----------------------------------------------------------------------------------------------------- |
| **1**             | Press **L** (or click *MC: Single Link*). A purple banner appears.                                                          |
| **2**             | Click the **origin portal** — skipped if a portal was already selected before step 1, in which case that becomes the origin. A cyan halo marks it. |
| **3**             | Click the **target portal**. The link is drawn; the origin clears, the mode stays on.                                       |
| **4**             | Click another origin → another target → another link. Repeat as many times as you want.                                     |
| **5**             | Press **L** again or **Esc** to exit. Until then, every map click is treated as a portal pick for a new link.               |

Clicks that don't land near a portal flash pink and are ignored. The snap radius is 25 pixels (configurable).

### Multi Link mode (one anchor, many targets)

| Step              |                                                                                                       |
| ----------------- | ----------------------------------------------------------------------------------------------------- |
| **1**             | Press **M** (or click *MC: Multi Link*). A purple banner appears.                                                                  |
| **2**             | Click the **anchor portal** — skipped if a portal was already selected before step 1, in which case that becomes the anchor. A larger cyan halo marks it. |
| **3**             | Click **each target portal** in turn. A link is drawn from the anchor each time.                                                  |
| **4**             | Press **M** again or **Esc** to exit. The anchor is cleared.                                                                      |

The anchor stays the same before exiting the mode — multi mode is sticky.

### Recheck

Press **R** (or click *MC: Recheck*) to re-run crosslink and length validation against the current map state. Useful after fields appear/disappear or in-game links change.

### Link direction

Press **D** (or click *MC: Link Direction*) to toggle origin-dashing. When on, the first stretch of every link — both in-game links and your drawn links — renders as short dashes from the **origin** portal, then solid for the rest, so the dashed end marks the source. It's **on by default**; the toolbox button highlights purple while active. This replaces the *Direction of links on map* community plugin — don't run both. Scope and pattern are configurable via `OPTIONS.linkDirection` (`applyToReal`, `applyToDrawn`, `dashArray`).

### Deleting drawn links

Mirrors native intel's link-removal UX. Hide the button entirely by setting `OPTIONS.deleteMarker.enabled = false`. To wipe everything at once, use **DrawTools → Clear all**.

---

## Colour codes

Every drawn link is recoloured automatically into one of three states.

| Colour                | When                                                                                                                                                                                              |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Yellow** `#ffd700`  | Valid. The link is **not under any field**, or it **is** under one and its length is **≤ 2 km**. The classic draw-tools yellow — also the default for any link as soon as it's drawn.            |
| **Red** `#ff0000`     | Invalid: the link **crosses a real in-game link** *or* sits under a field with length **> 2 km** — it cannot be created in-game. The crossed real link is also overlaid in solid red so both sides of the conflict are visible, and a red-on-white dot drops at every intersection point. |
| **Orange** `#ff8c00`  | Warning: the link **crosses another drawn link**, *or* it's longer than 2 km but the field state can't be determined (zoom < 15 or fields aren't loaded). Either way, you can resolve it without an external constraint — adjust your plan, or zoom in and press **R** to re-check. |

The plugin uses **colour only** to convey conflict type. Origin-dashing (see *Link direction*) is orthogonal: a crossing link is still recoloured red/orange and gets an intersection dot, and the dashing just marks its source end — the two cues don't collide. When a drawn link triggers both red and orange (crosses both a real link and a drawn one), red wins.

**Other on-map markers:**

| Marker                  | Colour                       | What it is                                                                                                              |
| ----------------------- | ---------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Anchor / origin halo    | Cyan ring `#00bfff`          | First-clicked portal in Single or Multi mode.                                                                           |
| Off-portal "miss" flash | Pink ring                    | A click that didn't land near any portal — that click is ignored.                                                       |
| Crossing point          | Red-on-white dot             | Drops at the exact intersection between a drawn link and any other link.                                                |
| Origin dashes           | The link's own colour        | First stretch of every link (in-game and drawn) dashed from the origin, the rest solid — the dashed end is the source. Toggle with **D**; see *Link direction*. |
| Direction chevron       | Brown glyph on chip          | Each drawn link's midpoint chip shows a ▶ rotated to its bearing (origin → destination) by default; hover the chip to swap it for the × delete button. |

---

## Keyboard shortcuts

| Key     | Action                                                                          |
| ------- | ------------------------------------------------------------------------------- |
| **L**   | Toggle Single Link mode (sticky — origin clears after each link, mode stays on) |
| **M**   | Toggle Multi Link mode (sticky — anchor stays across many targets)              |
| **R**   | Recheck all drawn links                                                         |
| **D**   | Toggle link direction dashing on in-game + drawn links (on by default)          |
| **Esc** | Exit any active mode                                                            |

Shortcuts are ignored while you're typing in an `<input>`, `<textarea>`, or contenteditable field. Change or disable them via the `shortcuts:` block in the config (see below).

The defaults (`L`, `M`, `R`, `D`) are not bound by IITC core, draw-tools, or the popular community plugins surveyed. If you install something that takes one of them, switch to `Alt+l` / `Alt+m` / `Alt+r` / `Alt+d` in the config.

---

## Customisation

Open `iitc-plugin-mind-controller.user.js` and scroll to the `self.OPTIONS = { … }` block at the top of the file. Every colour, radius, weight, opacity, threshold, and shortcut lives there. A few common tweaks:

| You want to…                                           | Edit                                                                            |
| ------------------------------------------------------ | ------------------------------------------------------------------------------- |
| Change the 2 km cap (e.g. if Niantic changes the rule) | `maxUnderFieldM`                                                                |
| Make snapping looser/tighter                           | `snapPx`                                                                        |
| Change crosslink colour                                | `crosslink.lineColor`, `crosslink.markerColor`                                  |
| Change the yellow / red / orange link palette          | `length.validColor`, `length.invalidColor`, `length.potentiallyInvalidColor`    |
| Change the default link colour (yellow)                | `defaultLine.color`                                                             |
| Hide / restyle the × delete buttons                    | `deleteMarker.enabled` / `bg` / `border` / `size` …                             |
| Toggle link direction / change its scope or pattern    | `linkDirection.enabledByDefault` / `applyToReal` / `applyToDrawn` / `dashArray` |
| Change the direction chevron glyph / colour            | `directionMarker.glyph` / `color` / `enabled`                                   |
| Use modifier-based shortcuts                           | `shortcuts.single = 'Alt+l'` etc.                                               |
| Disable a shortcut                                     | Set it to `null`                                                                |
| Move/restyle the status banner                         | `banner.bg`, `banner.color`, `banner.top` …                                     |

Save the file and reload [intel.ingress.com](https://intel.ingress.com).

---

## Development

Editing the plugin and re-installing it on every save gets old fast. The cleanest loop is to serve the userscript over localhost and let **IITC Button**'s custom-channel auto-update re-fetch it on every page load.

### One-time setup

1. Start the dev server (keeps running in its own terminal tab):

   ```sh
   bin/dev-serve.sh           # default: http://localhost:8765
   bin/dev-serve.sh 9000      # custom port
   ```

2. In Firefox, click the **IITC Button** toolbar icon → **Options**.
3. Open **Custom plugins** (or **Channels**, depending on extension version) → **Add channel** and paste:

   ```
   http://localhost:8765/iitc-plugin-mind-controller.user.js
   ```

4. Set the channel's **update interval** to **5 seconds** (or "On every page load").
5. Enable the plugin in the channel's plugin list.

### Per-edit loop

1. Edit `iitc-plugin-mind-controller.user.js` in your editor.
2. Save.
3. `Cmd+R` the [intel.ingress.com](https://intel.ingress.com) tab — IITC Button re-fetches localhost and runs the latest code.

No re-install, no extension restart. If you change the userscript metadata header (`@version`, `@grant`, etc.), IITC Button may want a fresh install — re-add the channel.

### Verifying changes loaded

Open Firefox devtools → Console → run:

```js
window.plugin.mindController.OPTIONS.maxUnderFieldM
```

You should see your current value. Bump it, save, refresh, run again — the new number proves the reload happened.

---

## Limitations & known gotchas

- **Field-state detection** uses `window.fields`. If you're zoomed out below 15, or if no fields are loaded for the visible area, any link longer than 2 km is coloured **orange** ("potentially invalid") rather than yellow or red. Zoom in and press **R** to resolve.
- **Self-links are blocked** in Single mode — clicking the same portal twice triggers the "missed click" flash.
- **Drawn links are stored as plain `L.geodesicPolyline` / `L.polyline`** to stay compatible with draw-tools' export format. Length is computed with `LatLng.distanceTo()` (haversine).
- **The plugin does not enforce 8 km / 1 280 km link caps**, link-amp boosts, or portal-level link distance — only the 2 km under-field rule.
- **Re-checks are debounced** to 500 ms to absorb hook storms from `mapDataRefreshEnd`.

---

## License

MIT.
