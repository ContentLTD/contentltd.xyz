
(function () {
  'use strict';

  if (window.__contrastEngineLoaded) return;
  window.__contrastEngineLoaded = true;

  // ── Tunables ─────────────────────────────────────────────────────────────
  var AA_NORMAL      = 4.5;
  var AA_LARGE       = 3.0;
  var HYSTERESIS     = 0.15;  // skip patch when within this band of target
  var SAMPLE_SIZE    = 64;    // offscreen sky canvas edge in px
  var SAMPLE_RADIUS  = 2;     // neighbourhood radius averaged when sampling
  var IDLE_INTERVAL  = 2000;  // steady-state rescan (ms)
  var TRANSITION_MS  = 4200;  // sky-gradient CSS transition duration + buffer

  // Selectors whose subtrees are excluded from contrast monitoring.
  var SKIP_SELECTORS = ['.gh-section'];

  // Tags that never render visible text — skip immediately.
  var SKIP_TAGS = {
    SCRIPT:1, STYLE:1, META:1, LINK:1, NOSCRIPT:1, HEAD:1, HTML:1,
    SVG:1, PATH:1, G:1, DEFS:1, CIRCLE:1, RECT:1, ELLIPSE:1, LINE:1,
    POLYGON:1, POLYLINE:1, USE:1, SYMBOL:1, CLIPPATH:1, MASK:1,
    FILTER:1, LINEARGRADIENT:1, RADIALGRADIENT:1, STOP:1, ANIMATE:1,
    BR:1, HR:1, IMG:1, CANVAS:1, VIDEO:1, AUDIO:1,
    SOURCE:1, TRACK:1, IFRAME:1, OBJECT:1, EMBED:1
  };

  // ── Preferred-colour hints ────────────────────────────────────────────────
  // When an element matches one of these selectors AND the preferred colour
  // passes AA, it is used instead of the computed lightness-shift fix.
  // This prevents "drift to muddy grey" on an already-grey (rainy) sky.
  var PREFERRED = [
    { sel: '.exp-filter',        color: '#000000' },
    { sel: '.exp-filter.active', color: '#000000' }
  ];

  // ── Colour math ───────────────────────────────────────────────────────────
  function hexToRgb(hex) {
    hex = hex.trim().replace('#', '');
    if (hex.length === 3) hex = hex.split('').map(function (c) { return c + c; }).join('');
    var n = parseInt(hex, 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255, 1];
  }

  function parseColor(str) {
    str = (str || '').trim();
    if (!str || str === 'transparent' || str === 'rgba(0, 0, 0, 0)') return null;
    if (str.charAt(0) === '#') return hexToRgb(str);
    var m = str.match(/rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)(?:[,\s\/]+([\d.]+))?/);
    if (m) return [+m[1], +m[2], +m[3], m[4] !== undefined ? +m[4] : 1];
    return null;
  }

  function rgbToHex(rgb) {
    return '#' + [rgb[0], rgb[1], rgb[2]].map(function (v) {
      return Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0');
    }).join('');
  }

  // Alpha-composite `top` (with its alpha) over opaque `bottom`.
  function composite(top, bottom) {
    var a = top[3];
    if (a >= 1) return [top[0], top[1], top[2], 1];
    if (a <= 0) return bottom;
    return [
      Math.round(top[0] * a + bottom[0] * (1 - a)),
      Math.round(top[1] * a + bottom[1] * (1 - a)),
      Math.round(top[2] * a + bottom[2] * (1 - a)),
      1
    ];
  }

  function linearize(c) {
    c /= 255;
    return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  }
  function luminance(rgb) {
    return 0.2126 * linearize(rgb[0]) + 0.7152 * linearize(rgb[1]) + 0.0722 * linearize(rgb[2]);
  }
  function contrastRatio(fg, bg) {
    var l1 = luminance(fg), l2 = luminance(bg);
    return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
  }

  // Nudge `fg` toward white/black until it clears `target` against `bg`.
  function fixColor(fg, bg, target) {
    var step = luminance(bg) > 0.18 ? -5 : 5;
    var r = fg[0], g = fg[1], b = fg[2];
    for (var i = 0; i < 80; i++) {
      if (contrastRatio([r, g, b], bg) >= target) break;
      r = Math.max(0, Math.min(255, r + step));
      g = Math.max(0, Math.min(255, g + step));
      b = Math.max(0, Math.min(255, b + step));
      // Hit the rail without clearing target — try the other direction.
      if (i === 40 && contrastRatio([r, g, b], bg) < target) {
        step = -step; r = fg[0]; g = fg[1]; b = fg[2];
      }
    }
    return [r, g, b];
  }

  function isLargeText(cs) {
    var sz = parseFloat(cs.fontSize) || 16;
    var wt = parseInt(cs.fontWeight, 10) || 400;
    return sz >= 24 || (sz >= 18.66 && wt >= 700);
  }

  // Resolve a CSS colour value that may contain var() references by
  // briefly applying it to a detached element.
  function resolveCssColor(value, cssPropName) {
    if (!value) return null;
    if (value.indexOf('var(') === -1) return parseColor(value);
    var tmp = document.createElement('span');
    tmp.style.cssText = 'position:absolute;left:-9999px;visibility:hidden;pointer-events:none;' +
                        cssPropName + ':' + value;
    document.body.appendChild(tmp);
    var jsPropName = cssPropName === 'background-color' ? 'backgroundColor' : 'color';
    var col = parseColor(getComputedStyle(tmp)[jsPropName]);
    document.body.removeChild(tmp);
    return col;
  }

  // ── Sky sampler ───────────────────────────────────────────────────────────
  // Renders gradient + cloud veil approximation + vignette into a small
  // offscreen canvas.  Individual pixels are then sampled per-element so
  // every contrast check is against the actual perceived sky colour at that
  // viewport position, not a guess from the gradient stop list.
  var sampler = (function () {
    var canvas = document.createElement('canvas');
    canvas.width = canvas.height = SAMPLE_SIZE;
    var ctx  = canvas.getContext('2d', { willReadFrequently: true });
    var pix  = null;
    var vpW  = 0, vpH = 0;

    function parseStops(bgImage) {
      if (!bgImage || bgImage === 'none') return null;
      var stops = [], re = /(#[0-9a-f]{3,8}|rgba?\([^)]+\))\s*(\d+(?:\.\d+)?)?%?/gi, m;
      while ((m = re.exec(bgImage)) !== null) {
        var c = parseColor(m[1]);
        if (!c) continue;
        stops.push([c, m[2] !== undefined ? parseFloat(m[2]) / 100 : null]);
      }
      if (stops.length < 2) return null;
      if (stops[0][1] === null) stops[0][1] = 0;
      if (stops[stops.length - 1][1] === null) stops[stops.length - 1][1] = 1;
      for (var i = 1; i < stops.length - 1; i++) {
        if (stops[i][1] === null) stops[i][1] = i / (stops.length - 1);
      }
      return stops;
    }

    function snapshot() {
      vpW = window.innerWidth  || document.documentElement.clientWidth;
      vpH = window.innerHeight || document.documentElement.clientHeight;
      var skyGrad = document.getElementById('sky-gradient');
      var bgSrc = (skyGrad && (skyGrad.style.backgroundImage || skyGrad.style.background)) ||
                  (skyGrad && getComputedStyle(skyGrad).backgroundImage) || '';
      var stops = parseStops(bgSrc);

      ctx.clearRect(0, 0, SAMPLE_SIZE, SAMPLE_SIZE);

      // ── Gradient base
      if (stops) {
        var grd = ctx.createLinearGradient(0, 0, 0, SAMPLE_SIZE);
        stops.forEach(function (s) {
          var c = s[0];
          grd.addColorStop(Math.max(0, Math.min(1, s[1])),
            'rgba(' + c[0] + ',' + c[1] + ',' + c[2] + ',' + (c[3] != null ? c[3] : 1) + ')');
        });
        ctx.fillStyle = grd;
      } else {
        var base = parseColor(getComputedStyle(document.documentElement).getPropertyValue('--base')) || [13,11,10,1];
        ctx.fillStyle = 'rgb(' + base[0] + ',' + base[1] + ',' + base[2] + ')';
      }
      ctx.fillRect(0, 0, SAMPLE_SIZE, SAMPLE_SIZE);

      // ── Cloud/weather veil (approximated from body class signals)
      var bc = document.body.classList;
      var cA = 0, cC = [154, 162, 173];
      if      (bc.contains('wx-storm'))                                   { cA = 0.60; cC = [60,  66,  76 ]; }
      else if (bc.contains('wx-rain') || bc.contains('wx-snow') || bc.contains('wx-fog')) {
        cA = 0.45; cC = bc.contains('is-night') ? [85, 92, 104] : [158, 166, 176];
      }
      else if (bc.contains('is-night'))                                   { cA = 0.18; cC = [68,  72,  82 ]; }
      else if (bc.contains('is-day'))                                     { cA = 0.22; cC = [192, 198, 208]; }

      if (cA > 0) {
        ctx.fillStyle = 'rgba(' + cC[0] + ',' + cC[1] + ',' + cC[2] + ',' + cA + ')';
        ctx.fillRect(0, SAMPLE_SIZE * 0.15, SAMPLE_SIZE, SAMPLE_SIZE * 0.70);
        ctx.fillStyle = 'rgba(' + cC[0] + ',' + cC[1] + ',' + cC[2] + ',' + (cA * 0.35) + ')';
        ctx.fillRect(0, 0,                  SAMPLE_SIZE, SAMPLE_SIZE * 0.15);
        ctx.fillRect(0, SAMPLE_SIZE * 0.85, SAMPLE_SIZE, SAMPLE_SIZE * 0.15);
      }

      // ── Vignette
      var vg = ctx.createRadialGradient(
        SAMPLE_SIZE / 2, SAMPLE_SIZE / 2, SAMPLE_SIZE * 0.20,
        SAMPLE_SIZE / 2, SAMPLE_SIZE / 2, SAMPLE_SIZE * 0.75);
      vg.addColorStop(0, 'rgba(13,11,10,0)');
      vg.addColorStop(1, 'rgba(13,11,10,0.55)');
      ctx.fillStyle = vg;
      ctx.fillRect(0, 0, SAMPLE_SIZE, SAMPLE_SIZE);

      var lin = ctx.createLinearGradient(0, SAMPLE_SIZE * 0.60, 0, SAMPLE_SIZE);
      lin.addColorStop(0, 'rgba(13,11,10,0)');
      lin.addColorStop(1, 'rgba(13,11,10,0.85)');
      ctx.fillStyle = lin;
      ctx.fillRect(0, SAMPLE_SIZE * 0.60, SAMPLE_SIZE, SAMPLE_SIZE * 0.40);

      try { pix = ctx.getImageData(0, 0, SAMPLE_SIZE, SAMPLE_SIZE).data; }
      catch (e) { pix = null; }
    }

    function sampleAt(vx, vy) {
      if (!pix || !vpW || !vpH) return null;
      var px = Math.max(0, Math.min(SAMPLE_SIZE - 1, Math.round(vx / vpW * SAMPLE_SIZE)));
      var py = Math.max(0, Math.min(SAMPLE_SIZE - 1, Math.round(vy / vpH * SAMPLE_SIZE)));
      var r = 0, g = 0, b = 0, n = 0;
      for (var dy = -SAMPLE_RADIUS; dy <= SAMPLE_RADIUS; dy++) {
        for (var dx = -SAMPLE_RADIUS; dx <= SAMPLE_RADIUS; dx++) {
          var sx = px + dx, sy = py + dy;
          if (sx < 0 || sx >= SAMPLE_SIZE || sy < 0 || sy >= SAMPLE_SIZE) continue;
          var i4 = (sy * SAMPLE_SIZE + sx) * 4;
          r += pix[i4]; g += pix[i4 + 1]; b += pix[i4 + 2]; n++;
        }
      }
      return n ? [Math.round(r / n), Math.round(g / n), Math.round(b / n), 1] : null;
    }

    return { snapshot: snapshot, sampleAt: sampleAt };
  })();

  // ── Dynamic stylesheet ────────────────────────────────────────────────────
  // Pseudo-element and interaction-state overrides live here; inline styles
  // can't reach pseudo-elements.
  var dynStyle = document.createElement('style');
  dynStyle.id = 'contrast-engine-overrides';
  (document.head || document.documentElement).appendChild(dynStyle);
  var dynRules = {};
  var dynDirty = false;

  function dynSet(key, text) {
    if (dynRules[key] === text) return;
    dynRules[key] = text;
    dynDirty = true;
  }
  function dynDel(key) {
    if (!dynRules[key]) return;
    delete dynRules[key];
    dynDirty = true;
  }
  function dynClear() { dynRules = {}; dynDirty = true; }
  function dynCommit() {
    if (!dynDirty) return;
    dynStyle.textContent = Object.keys(dynRules).map(function (k) { return dynRules[k]; }).join('\n');
    dynDirty = false;
  }

  // Unique attribute to build pinpoint CSS selectors for pseudo-element rules.
  var CE_ATTR = 'data-ce';
  var ceCounter = 0;
  function getCeId(el) {
    var id = el.getAttribute(CE_ATTR);
    if (!id) { id = String(++ceCounter); el.setAttribute(CE_ATTR, id); }
    return id;
  }

  // ── Effective-background walker ───────────────────────────────────────────
  // Collects translucent ancestor backgrounds and composites them over the
  // sky pixel at the element's centre.
  function getEffectiveBg(el) {
    var layers = [], node = el, hitOpaque = false;
    while (node && node !== document.documentElement) {
      var ncs = getComputedStyle(node);
      var bg  = parseColor(ncs.backgroundColor);
      if (bg && bg[3] > 0) {
        layers.push(bg);
        if (bg[3] >= 1) { hitOpaque = true; break; }
      }
      if (node === document.body) break;
      node = node.parentElement;
    }
    var base;
    if (hitOpaque) {
      base = layers.pop();
    } else {
      var rect = el.getBoundingClientRect();
      base = sampler.sampleAt(rect.left + rect.width / 2, rect.top + rect.height / 2) ||
             parseColor(getComputedStyle(document.documentElement).getPropertyValue('--base')) ||
             [13, 11, 10, 1];
    }
    var result = base;
    for (var i = layers.length - 1; i >= 0; i--) result = composite(layers[i], result);
    return result;
  }

  // ── Baseline colour cache ─────────────────────────────────────────────────
  // Strip any previous inline patch, read the CSS-computed value, cache it.
  var ORIGINAL = new WeakMap();
  function originalColor(el) {
    var cached = ORIGINAL.get(el);
    if (cached) return cached.slice();
    var saved = el.style.getPropertyValue('color');
    if (saved) el.style.removeProperty('color');
    var baseline = parseColor(getComputedStyle(el).color);
    if (saved) el.style.setProperty('color', saved, 'important');
    if (!baseline) return null;
    ORIGINAL.set(el, baseline);
    return baseline.slice();
  }

  // ── Preferred-colour lookup ───────────────────────────────────────────────
  function preferredFor(el) {
    for (var i = 0; i < PREFERRED.length; i++) {
      try { if (el.matches(PREFERRED[i].sel)) return parseColor(PREFERRED[i].color); }
      catch (e) {}
    }
    return null;
  }

  // ── Main element colour patch ─────────────────────────────────────────────
  function patchColor(el, bg) {
    var cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || parseFloat(cs.opacity) === 0) return;

    var fg = originalColor(el);
    if (!fg) return;

    var target = isLargeText(cs) ? AA_LARGE : AA_NORMAL;
    var ratio  = contrastRatio(fg, bg);

    if (ratio >= target - HYSTERESIS) {
      if (el.style.getPropertyValue('color')) el.style.removeProperty('color');
      return;
    }

    var pref  = preferredFor(el);
    var fixed = (pref && contrastRatio(pref, bg) >= target) ? pref : fixColor(fg, bg, target);
    var hex   = rgbToHex(fixed);
    if (el.style.getPropertyValue('color').toLowerCase() !== hex)
      el.style.setProperty('color', hex, 'important');
  }

  // ── Pseudo-element patch ──────────────────────────────────────────────────
  // Determines whether a pseudo-element's `content` value is visible text
  // (not empty, not decorative, not a URL/image).
  function hasPseudoText(content) {
    if (!content || content === 'none' || content === 'normal') return false;
    if (content.indexOf('url(') !== -1 || content.indexOf('gradient') !== -1) return false;
    var inner = content.replace(/^["']|["']$/g, '');  // strip CSS string quotes
    return inner.length > 0;
  }

  function patchPseudo(el, pseudo, bg) {
    var pcs;
    try { pcs = getComputedStyle(el, pseudo); } catch (e) { return; }
    if (!pcs || pcs.display === 'none') return;
    if (!hasPseudoText(pcs.content)) return;

    var fg     = parseColor(pcs.color);
    if (!fg) return;

    var target = isLargeText(pcs) ? AA_LARGE : AA_NORMAL;
    var ratio  = contrastRatio(fg, bg);
    var ruleKey = 'pseudo-' + getCeId(el) + pseudo;

    if (ratio >= target - HYSTERESIS) {
      dynDel(ruleKey);
      return;
    }

    var fixed = fixColor(fg, bg, target);
    dynSet(ruleKey,
      '[' + CE_ATTR + '="' + getCeId(el) + '"]' + pseudo +
      '{color:' + rgbToHex(fixed) + '!important}');
  }

  // ── Interaction-state patcher ─────────────────────────────────────────────
  // Harvests every :hover / :active / :focus / :focus-visible rule from all
  // loaded stylesheets once, then for each rule finds a representative
  // element, measures the sky-sampled background, and injects a corrective
  // override if the state colour fails AA.
  var _harvestedRules = null;

  function harvestRules() {
    if (_harvestedRules) return _harvestedRules;
    _harvestedRules = [];
    var RE = /:(?:hover|active|focus(?:-visible|-within)?)\b/i;
    Array.prototype.forEach.call(document.styleSheets, function (sheet) {
      if (sheet.disabled) return;
      var rules;
      try { rules = sheet.cssRules || sheet.rules; } catch (e) { return; }
      if (!rules) return;
      Array.prototype.forEach.call(rules, function (rule) {
        if (rule.type !== 1 || !rule.selectorText) return;
        rule.selectorText.split(',').forEach(function (rawSel) {
          rawSel = rawSel.trim();
          if (!RE.test(rawSel)) return;
          var cV  = rule.style.color;
          var bgV = rule.style.backgroundColor;
          if (!cV && !bgV) return;
          // Strip interaction pseudo-classes to get a querySelectorAll-safe selector.
          var baseSel = rawSel.replace(/:(?:hover|active|focus(?:-visible|-within)?)\b/gi, '').trim();
          if (!baseSel) return;
          if (cV)  _harvestedRules.push({ origSel: rawSel, baseSel: baseSel, cssProp: 'color',            value: cV  });
          if (bgV) _harvestedRules.push({ origSel: rawSel, baseSel: baseSel, cssProp: 'background-color', value: bgV });
        });
      });
    });
    return _harvestedRules;
  }

  function patchInteractionStates() {
    var rules = harvestRules();
    var seen  = {};
    rules.forEach(function (r) {
      var key = r.origSel + '|' + r.cssProp;
      if (seen[key]) return;

      var els;
      try { els = document.querySelectorAll(r.baseSel); } catch (e) { return; }
      // Find first visible element as background representative.
      var rep = null;
      for (var i = 0; i < els.length; i++) {
        var cs = getComputedStyle(els[i]);
        if (cs.display !== 'none' && cs.visibility !== 'hidden') { rep = els[i]; break; }
      }
      if (!rep) return;

      var stateColor = resolveCssColor(r.value, r.cssProp);
      if (!stateColor) return;

      var bg     = getEffectiveBg(rep);
      if (!bg) return;

      var target = isLargeText(getComputedStyle(rep)) ? AA_LARGE : AA_NORMAL;
      var ratio  = contrastRatio(stateColor, bg);
      var ruleKey = 'ix-' + key;
      seen[key] = true;

      if (ratio >= target - HYSTERESIS) {
        dynDel(ruleKey);
        return;
      }

      var pref  = preferredFor(rep);
      var fixed = (pref && contrastRatio(pref, bg) >= target) ? pref : fixColor(stateColor, bg, target);
      dynSet(ruleKey,
        r.origSel + '{' + r.cssProp + ':' + rgbToHex(fixed) + '!important}');
    });
  }

  // ── Static CSS token audit ────────────────────────────────────────────────
  function auditTokens() {
    var root = document.documentElement;
    var cs   = getComputedStyle(root);
    function v(n) { return cs.getPropertyValue(n).trim(); }

    var PAIRS = [
      ['--text',   '--base',      'normal', 'body text / base'],
      ['--text',   '--surface',   'normal', 'body text / surface'],
      ['--text',   '--surface-2', 'normal', 'body text / surface-2'],
      ['--text-2', '--base',      'normal', 'secondary / base'],
      ['--text-2', '--surface',   'normal', 'secondary / surface'],
      ['--text-2', '--surface-2', 'normal', 'secondary / surface-2'],
      ['--text-3', '--base',      'large',  'muted / base'],
      ['--text-3', '--surface',   'large',  'muted / surface'],
      ['--accent', '--base',      'normal', 'accent / base'],
      ['--accent', '--surface',   'normal', 'accent / surface'],
      ['--accent', '--surface-2', 'normal', 'accent / surface-2']
    ];

    var fixes = {}, pass = 0, fail = 0;
    PAIRS.forEach(function (p) {
      var fg = parseColor(v(p[0])), bg = parseColor(v(p[1]));
      if (!fg || !bg) return;
      var target = p[2] === 'large' ? AA_LARGE : AA_NORMAL;
      var ratio  = contrastRatio(fg, bg);
      if (ratio >= target) { pass++; return; }
      fail++;
      var fixed = fixColor(fg, bg, target);
      fixes[p[0]] = rgbToHex(fixed);
      console.info('[contrast] token ' + p[0] + ' → ' + fixes[p[0]] +
                   ' (' + ratio.toFixed(2) + ' → ' + contrastRatio(fixed, bg).toFixed(2) + ':1) [' + p[3] + ']');
    });
    Object.keys(fixes).forEach(function (k) { root.style.setProperty(k, fixes[k], 'important'); });
    console.info('[contrast] token audit: ' + pass + ' pass, ' + fail + ' patched');
  }

  // ── Unified scan ─────────────────────────────────────────────────────────
  // Single querySelectorAll('*') pass.  For each eligible element:
  //   • If it has a direct text node  → patch its colour (inline style).
  //   • If ::before or ::after has text content → patch via dynamic sheet.
  // Then patches all interaction states via the harvested stylesheet rules.
  function scan() {
    sampler.snapshot();

    // Clear dynamic overrides BEFORE reading pseudo-element computed styles so
    // we see the original CSS-declared colours, not our previous patches.
    // The browser won't repaint until the JS task completes — no visual flash.
    dynClear();

    var all = document.querySelectorAll('*');
    for (var i = 0; i < all.length; i++) {
      var el = all[i];
      if (SKIP_TAGS[el.tagName]) continue;
      var skipEl = false;
      for (var si = 0; si < SKIP_SELECTORS.length; si++) {
        try { if (el.closest(SKIP_SELECTORS[si])) { skipEl = true; break; } } catch (e) {}
      }
      if (skipEl) continue;

      var cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden') continue;

      // Fast check: does this element have at least one non-whitespace text node?
      var hasTxt = false;
      for (var j = 0; j < el.childNodes.length; j++) {
        var nd = el.childNodes[j];
        if (nd.nodeType === 3 && /\S/.test(nd.nodeValue)) { hasTxt = true; break; }
      }

      // Quick pre-check: does either pseudo have non-empty content?
      var bContent = '', aContent = '';
      try { bContent = getComputedStyle(el, '::before').content || ''; } catch (e) {}
      try { aContent = getComputedStyle(el, '::after').content  || ''; } catch (e) {}
      var hasBefore = hasPseudoText(bContent);
      var hasAfter  = hasPseudoText(aContent);

      if (!hasTxt && !hasBefore && !hasAfter) continue;

      // Compute effective background once; shared by colour + both pseudos.
      var bg = getEffectiveBg(el);

      if (hasTxt)   patchColor(el, bg);
      if (hasBefore) patchPseudo(el, '::before', bg);
      if (hasAfter)  patchPseudo(el, '::after',  bg);
    }

    // Patch :hover / :active / :focus / :focus-visible state colours.
    patchInteractionStates();

    dynCommit();
  }

  // ── rAF burst ─────────────────────────────────────────────────────────────
  var burstUntil = 0;
  function burst(ms) {
    burstUntil = Math.max(burstUntil, performance.now() + (ms || TRANSITION_MS));
    if (burst._raf) return;
    function tick() {
      scan();
      burst._raf = performance.now() < burstUntil ? requestAnimationFrame(tick) : null;
    }
    burst._raf = requestAnimationFrame(tick);
  }

  // ── Wire-up ───────────────────────────────────────────────────────────────
  function start() {
    auditTokens();
    scan();

    setInterval(scan, IDLE_INTERVAL);

    var skyGrad = document.getElementById('sky-gradient');
    if (skyGrad) {
      new MutationObserver(function () { burst(TRANSITION_MS); })
        .observe(skyGrad, { attributes: true, attributeFilter: ['style'] });
    }
    new MutationObserver(function () { burst(800); })
      .observe(document.body, { attributes: true, attributeFilter: ['class'] });

    var resizeTimer;
    window.addEventListener('resize', function () {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(scan, 120);
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start, { once: true });
  } else {
    start();
  }

  // ── Public API ────────────────────────────────────────────────────────────
  window.contrastEngine = {
    rescan:  scan,
    burst:   burst,
    verbose: function (on) { window.__contrastVerbose = !!on; },
    // Call after dynamically injecting new <style>/<link> elements to force
    // the interaction-state rule cache to be rebuilt on the next scan.
    invalidateRules: function () { _harvestedRules = null; scan(); }
  };
})();
