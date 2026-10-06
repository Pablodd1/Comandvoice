/*!
 * VoiceLayer — Phase 0 demo  (v0.1.0)
 * ---------------------------------------------------------------------------
 * A drop-in voice assistant widget. ONE script tag, no dependencies, no build.
 *
 *   <script src="voicelayer.js" defer></script>
 *
 * What it does
 *   • Floats an orb over the page; tap it to talk (mic NEVER starts on its own).
 *   • Scans the page (headings, nav, buttons, prices, products) into a "site map".
 *   • Understands a small set of voice/typed commands (go / click / find / read / about / stop / close).
 *   • Speaks answers with speechSynthesis; listens with SpeechRecognition (Chrome/Edge/Safari).
 *   • Highlights what it is about to touch, then dispatches REAL DOM events so the site's own
 *     handlers and analytics fire.
 *   • Reports an outcome as "verified" ONLY when it re-reads the page afterwards (read-back);
 *     otherwise it says plainly that it could not confirm the result.
 *
 * Phase 0 = demo. It is rule-based (no LLM, no backend), so page text can never be
 * used to "instruct" the assistant. See README.md for limits.
 *
 * File layout (search for the ===== banners):
 *   1 CONFIG   2 UTILS   3 SITE SCANNER   4 WAVEFORM   5 VOICE I/O   6 UI   7 COMMANDS   8 CONTROLLER   9 PUBLIC API
 */
(function () {
  'use strict';
  if (window.VoiceLayer && window.VoiceLayer.__loaded) return; // already installed

  /* =========================================================================
   * 1. CONFIG  — edit these values; no coding needed.
   *    You can also override anything from the host page BEFORE the script tag:
   *      <script>window.VoiceLayerConfig = { language: 'en-GB', debug: true };</script>
   *    or with data attributes: <script src="voicelayer.js" data-language="en-GB" data-debug="true">
   * ========================================================================= */
  const CONFIG = {
    enabled: true,                       // false = widget does nothing (kill switch)
    language: 'en-US',                   // speech recognition + speech synthesis language (BCP-47)
    greeting: 'Hi! Tap the mic and ask me about this page. Try “what is this site?”, “click add to cart” or “find headphones”.',
    speakGreeting: false,                // speak the greeting aloud on first open? (captions always show it)
    orbPosition: { corner: 'bottom-right', offsetX: 24, offsetY: 24 }, // corner: bottom-right | bottom-left | top-right | top-left
    rememberPosition: true,              // remember where the visitor dragged the orb (localStorage)
    listenOnOpen: true,                  // tapping the orb opens the panel AND starts the mic (that tap is the consent gesture). false = open only
    resumeAfterNavigation: true,         // after the assistant navigates, re-open the panel (mic stays OFF)

    speak: true,                         // speak replies out loud (visitor can also mute in the panel)
    speechRate: 1,                       // 0.5 – 2
    speechPitch: 1,                      // 0 – 2
    voiceName: '',                       // exact name of a preferred voice, or '' for automatic

    scrollOffset: 84,                    // px kept free at the top when scrolling to a section (sticky headers)
    highlightMs: 7000,                   // how long highlight rings stay visible
    preClickDelayMs: 1000,               // ring is shown this long BEFORE a click so the visitor can see/cancel it
    thinkingMs: 450,                     // minimum time the "thinking" state is shown
    listenIdleTimeoutMs: 90000,          // auto-stop the mic after this long without speech (privacy)
    maxReadChars: 1600,                  // "Read this" speaks at most this much text
    micVisualizer: true,                 // use the real mic level for the listening waveform (Web Audio)

    // Add-to-cart read-back: where the page shows the cart count (first match is used)
    cartCountSelector: '[data-cart-count], #cart-count, .cart-count',
    // Clicking a control whose label matches this needs a spoken/typed "yes" first
    confirmBeforeClick: 'buy|checkout|check out|pay|payment|order|purchase|submit|delete|remove|subscribe|sign ?up|confirm|place order|donate',

    debug: false,                        // true = shows buttons to force each visual state (no mic needed) + logs

    cssUrl: '',                          // override stylesheet URL ('' = voicelayer.css next to this script)

    // User-facing text (change for other languages; the command grammar itself is English — see README)
    text: {
      title: 'VoiceLayer',
      placeholder: 'Type a command…',
      send: 'Send',
      stop: 'STOP',
      micIdle: 'Tap to talk',
      micActive: 'Listening… tap to stop',
      openLabel: 'Open voice assistant',
      closeLabel: 'Close assistant',
      states: { idle: 'Idle', listening: 'Listening', thinking: 'Thinking', speaking: 'Speaking' },
      privacy: 'The microphone turns on only when you tap it and stops when you press STOP or close this panel. ' +
               'Speech recognition is done by your browser’s speech service (in Chrome, Google’s). Nothing is sent to this website.'
    }
  };

  // --- apply host overrides (window.VoiceLayerConfig, then data-* attributes on the script tag) ---------------------
  const SCRIPT = document.currentScript || (function () {
    const all = document.getElementsByTagName('script');
    for (let i = all.length - 1; i >= 0; i--) if (/voicelayer(\.min)?\.js/i.test(all[i].src || '')) return all[i];
    return null;
  })();
  (function applyOverrides() {
    const o = window.VoiceLayerConfig || {};
    Object.keys(o).forEach(function (k) {
      if (o[k] && typeof o[k] === 'object' && !Array.isArray(o[k]) && CONFIG[k] && typeof CONFIG[k] === 'object') {
        Object.assign(CONFIG[k], o[k]);
      } else { CONFIG[k] = o[k]; }
    });
    if (SCRIPT && SCRIPT.dataset) {
      const d = SCRIPT.dataset;
      if (d.language) CONFIG.language = d.language;
      if (d.debug) CONFIG.debug = d.debug === 'true';
      if (d.css) CONFIG.cssUrl = d.css;
      if (d.corner) CONFIG.orbPosition.corner = d.corner;
      if (d.greeting) CONFIG.greeting = d.greeting;
    }
  })();
  if (!CONFIG.enabled) return;

  const VERSION = '0.1.0-phase0';
  const STATES = ['idle', 'listening', 'thinking', 'speaking'];
  const log = function () { if (CONFIG.debug) console.log.apply(console, ['[VoiceLayer]'].concat([].slice.call(arguments))); };

  /* =========================================================================
   * 2. UTILS
   * ========================================================================= */
  const sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
  const clamp = function (v, lo, hi) { return Math.max(lo, Math.min(hi, v)); };
  const qsa = function (sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); };

  /** lowercase, strip accents/punctuation (keeps $ € £ . % inside values), collapse spaces */
  function norm(s) {
    return String(s == null ? '' : s).toLowerCase()
      .normalize('NFKD').replace(/\p{M}+/gu, '').replace(/['\u2019]/g, '')
      .replace(/[.,!?;:]+(?=\s|$)/g, ' ')
      .replace(/[^\p{L}\p{N}$€£.%\s]/gu, ' ')
      .replace(/\s+/g, ' ').trim();
  }
  function clean(s) { return String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); }
  function short(s, n) { s = clean(s); return s.length > n ? s.slice(0, n - 1) + '…' : s; }

  /** Levenshtein distance (small strings only) */
  function lev(a, b) {
    if (a === b) return 0;
    const m = a.length, n = b.length;
    if (!m) return n; if (!n) return m;
    let prev = new Array(n + 1), cur = new Array(n + 1), i, j;
    for (j = 0; j <= n; j++) prev[j] = j;
    for (i = 1; i <= m; i++) {
      cur[0] = i;
      for (j = 1; j <= n; j++) {
        cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1));
      }
      const t = prev; prev = cur; cur = t;
    }
    return prev[n];
  }

  const STOPWORDS = new Set('the a an to of on in for please button link section page that this my me and tab menu item option'.split(' '));
  /** token similarity — tolerant of speech-to-text slips ("car" ~ "cart", "headphone" ~ "headphones") */
  function tokSim(a, b) {
    if (a === b) return 1;
    const m = Math.max(a.length, b.length);
    if (m >= 4 && (a.startsWith(b) || b.startsWith(a)) && Math.min(a.length, b.length) >= 3) return 0.85;
    if (m >= 4) { const d = lev(a, b); if (d <= Math.floor(m / 4)) return 1 - d / m; }
    return 0;
  }
  /** 0..1 — how well does `label` answer the spoken `query`? */
  function score(query, label) {
    const q = norm(query), l = norm(label);
    if (!q || !l) return 0;
    if (q === l) return 1;
    if ((' ' + l + ' ').indexOf(' ' + q + ' ') >= 0) return 0.9 + 0.1 * Math.min(1, q.length / l.length); // whole phrase inside label
    let qt = q.split(' ').filter(function (t) { return !STOPWORDS.has(t); });
    if (!qt.length) qt = q.split(' ');
    const lt = l.split(' ');
    let hit = 0, used = 0;
    qt.forEach(function (t) {
      let best = 0; lt.forEach(function (x) { best = Math.max(best, tokSim(t, x)); });
      hit += best; if (best > 0) used++;
    });
    const coverage = hit / qt.length;
    return coverage * (0.75 + 0.25 * Math.min(1, used / lt.length));
  }
  /** rank items by label; returns [{item, score}] best-first, only those ≥ min */
  function rank(items, query, min, labelOf) {
    const out = [];
    items.forEach(function (it) {
      const s = score(query, labelOf ? labelOf(it) : it.label);
      if (s >= (min == null ? 0.6 : min)) out.push({ item: it, score: s + (it.bonus || 0) });
    });
    out.sort(function (a, b) { return b.score - a.score; });
    return out;
  }

  function isVisible(el) {
    if (!el || !el.isConnected) return false;
    if (typeof el.checkVisibility === 'function') {
      if (!el.checkVisibility({ checkVisibilityCSS: true, visibilityProperty: true })) return false;
    } else {
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden') return false;
    }
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }
  function isDisabled(el) {
    return !!(el.disabled || el.getAttribute('aria-disabled') === 'true' || (el.closest && el.closest('fieldset:disabled')));
  }
  function inViewport(el) {
    const r = el.getBoundingClientRect();
    return r.bottom > 0 && r.top < (window.innerHeight || document.documentElement.clientHeight) && r.right > 0 && r.left < window.innerWidth;
  }
  function labelOfEl(el) {
    let t = el.getAttribute('aria-label') || '';
    if (!t) t = (el.tagName === 'INPUT') ? (el.value || el.getAttribute('title') || '') : (el.innerText || el.textContent || '');
    if (!t) { const img = el.querySelector && el.querySelector('img[alt]'); t = img ? img.alt : (el.getAttribute('title') || ''); }
    return short(t, 90);
  }
  const SKIP_SEL = '[data-vl-ignore], #voicelayer-root, script, style, noscript, template';
  const PRICE_RE = /(?:[$€£¥]\s?\d[\d,]*(?:\.\d{1,2})?|\d[\d,]*(?:\.\d{1,2})?\s?(?:USD|EUR|GBP|€|£))/;

  /* =========================================================================
   * 3. SITE SCANNER — builds the "site map" the assistant reasons over.
   *    Keeps live element references internally; getSiteMap() returns a plain JSON copy for the "agent".
   * ========================================================================= */
  const Scanner = {
    map: null,
    _timer: null,
    _obs: null,

    scan: function () {
      const t0 = performance.now();
      const skip = function (el) { return !!el.closest(SKIP_SEL); };
      const m = {
        url: location.href,
        title: document.title || '',
        description: (document.querySelector('meta[name="description"]') || {}).content || '',
        lang: document.documentElement.lang || '',
        headings: [], nav: [], links: [], buttons: [], prices: [], products: [], anchors: [],
        scannedAt: Date.now()
      };

      qsa('h1,h2,h3,h4,[role="heading"]').forEach(function (el) {
        if (skip(el)) return;
        const text = clean(el.textContent); if (!text) return;
        const lvl = el.tagName.length === 2 && /H\d/.test(el.tagName) ? +el.tagName[1] : +(el.getAttribute('aria-level') || 2);
        m.headings.push({ text: short(text, 120), level: lvl, id: el.id || '', el: el });
      });

      qsa('a[href]').forEach(function (el) {
        if (skip(el)) return;
        const text = labelOfEl(el); if (!text) return;
        const href = el.getAttribute('href') || '';
        if (/^(javascript:|mailto:|tel:)/i.test(href)) return;
        const isNav = !!el.closest('nav, header, [role="navigation"]');
        const rec = { text: text, href: el.href, rawHref: href, nav: isNav, el: el };
        m.links.push(rec); if (isNav) m.nav.push(rec);
      });

      qsa('button, [role="button"], input[type="button"], input[type="submit"], input[type="reset"], summary').forEach(function (el) {
        if (skip(el)) return;
        const text = labelOfEl(el); if (!text) return;
        m.buttons.push({ text: text, el: el, disabled: isDisabled(el) });
      });

      // prices: text nodes that look like a price
      const walker = document.createTreeWalker(document.body || document.documentElement, NodeFilter.SHOW_TEXT, {
        acceptNode: function (n) {
          const p = n.parentElement;
          if (!p || n.nodeValue.length > 60 || !PRICE_RE.test(n.nodeValue)) return NodeFilter.FILTER_REJECT;
          return p.closest(SKIP_SEL) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT;
        }
      });
      let n;
      while ((n = walker.nextNode()) && m.prices.length < 300) {
        const mm = n.nodeValue.match(PRICE_RE);
        m.prices.push({ text: clean(mm[0]), value: parseFloat(mm[0].replace(/[^0-9.]/g, '')) || 0, el: n.parentElement });
      }

      // products: for each price, walk up to the smallest ancestor that holds exactly ONE heading.
      // That ancestor is the product card; its first price is the current price (a second, struck-through
      // "was" price in the same card is ignored). Stops if the ancestor would hold several headings.
      const seen = new Set();
      m.prices.forEach(function (p) {
        let a = p.el, depth = 0;
        while (a && a !== document.body && depth < 7) {
          const hs = qsa('h2,h3,h4,h5,[data-product-name]', a).filter(function (h) { return !h.closest(SKIP_SEL); });
          if (hs.length > 1) break;                                       // grew past a single product
          if (hs.length === 1) {
            const actionable = !!a.querySelector('button, a[href], input[type="submit"], input[type="button"], [role="button"], [itemtype*="Product"]') || /product|item|card/i.test(a.className + ' ' + (a.getAttribute('itemtype') || ''));
            if (actionable && !seen.has(a) && !m.products.some(function (q) { return q.el.contains(a) || a.contains(q.el); })) {
              seen.add(a);
              const first = m.prices.find(function (x) { return a.contains(x.el); }) || p;
              m.products.push({ name: short(clean(hs[0].textContent), 80), price: first.text, value: first.value, el: a });
            }
            break;
          }
          a = a.parentElement; depth++;
        }
      });

      // anchors: elements with an id that look like sections (lets "go to pricing" work for <section id="pricing">)
      qsa('section[id], main[id], article[id], [data-section][id], div[id]').forEach(function (el) {
        if (skip(el) || !el.id || el.id.length > 40) return;
        if (!el.querySelector('h1,h2,h3,h4') && el.tagName !== 'SECTION') return;
        m.anchors.push({ text: el.getAttribute('aria-label') || el.id.replace(/[-_]+/g, ' '), id: el.id, el: el });
      });

      m.ms = Math.round((performance.now() - t0) * 10) / 10;
      this.map = m;
      try { window.dispatchEvent(new CustomEvent('voicelayer:sitemap', { detail: this.json() })); } catch (e) { /* old browsers */ }
      log('site scanned in', m.ms, 'ms', { headings: m.headings.length, links: m.links.length, buttons: m.buttons.length, products: m.products.length });
      return m;
    },

    /** plain-JSON site map (no DOM references) — this is what an "agent" gets to see */
    json: function () {
      const m = this.map || this.scan();
      const strip = function (arr, keys) {
        return arr.map(function (o) { const r = {}; keys.forEach(function (k) { r[k] = o[k]; }); return r; });
      };
      return {
        url: m.url, title: m.title, description: m.description, lang: m.lang, scannedAt: m.scannedAt,
        headings: strip(m.headings, ['text', 'level', 'id']),
        nav: strip(m.nav, ['text', 'href']),
        buttons: m.buttons.map(function (b) { return { text: b.text, context: contextOf(b.el), disabled: b.disabled }; }),
        prices: strip(m.prices, ['text', 'value']),
        products: strip(m.products, ['name', 'price', 'value'])
      };
    },

    watch: function () {
      const self = this;
      if (this._obs || !window.MutationObserver) return;
      this._obs = new MutationObserver(function (muts) {
        if (!muts.some(function (x) { return !(x.target.closest && x.target.closest(SKIP_SEL)); })) return;
        clearTimeout(self._timer);
        self._timer = setTimeout(function () { self.scan(); }, 600); // debounce: re-scan after the page settles
      });
      this._obs.observe(document.body || document.documentElement, { childList: true, subtree: true, characterData: true });
    }
  };

  /** best human context for a control: its product name, else the nearest heading above/around it */
  function contextOf(el) {
    const m = Scanner.map;
    if (m) for (let i = 0; i < m.products.length; i++) if (m.products[i].el.contains(el)) return m.products[i].name;
    let a = el.parentElement, d = 0;
    while (a && a !== document.body && d < 5) {
      const h = a.querySelector('h1,h2,h3,h4');
      if (h && !h.contains(el)) return short(clean(h.textContent), 60);
      a = a.parentElement; d++;
    }
    return '';
  }

  /* =========================================================================
   * 4. WAVEFORM RENDERER — canvas, 40 round-capped bars, 60fps.
   *    setState('idle'|'listening'|'thinking'|'speaking')   setAnalyser(AnalyserNode|null)
   *    idle      faint shimmer on a flat line
   *    listening live mic frequency bars (or simulated when no analyser)
   *    thinking  radar sweep from the centre outward, dim
   *    speaking  smooth, symmetrical, flowing (clearly unlike listening)
   *    NOTE: browsers do not expose speechSynthesis audio to Web Audio, so SPEAKING is always the
   *    pre-programmed voice-like wave, tied to real utterance boundary events when available.
   * ========================================================================= */
  function WaveformRenderer(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.state = 'idle';
    this.analyser = null;
    this.bars = 40;
    this.cur = new Float32Array(this.bars);   // displayed amplitude 0..1 (smoothed)
    this.freq = null;
    this.t0 = performance.now();
    this.stateT = this.t0;
    this.pulse = 0;                           // speech "word" energy kick (from utterance boundary events)
    this.running = false;
    this.dpr = 1; this.w = 0; this.h = 0;
    this.reduced = !!(window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches);
    this._loop = this._loop.bind(this);
    this.lastLevel = 0;                       // 0..1, readable by tests / debug
    this.resize();
  }
  WaveformRenderer.prototype.setState = function (s) {
    if (STATES.indexOf(s) < 0 || s === this.state) return;
    this.state = s; this.stateT = performance.now();
  };
  WaveformRenderer.prototype.setAnalyser = function (a) {
    this.analyser = a || null;
    this.freq = a ? new Uint8Array(a.frequencyBinCount) : null;
  };
  WaveformRenderer.prototype.kick = function (v) { this.pulse = Math.max(this.pulse, v == null ? 1 : v); };
  WaveformRenderer.prototype.resize = function () {
    const r = this.canvas.getBoundingClientRect();
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.w = Math.max(1, Math.round(r.width || 340));
    this.h = Math.max(1, Math.round(r.height || 72));
    this.canvas.width = this.w * this.dpr; this.canvas.height = this.h * this.dpr;
  };
  WaveformRenderer.prototype.start = function () {
    if (this.running) return; this.running = true; requestAnimationFrame(this._loop);
  };
  WaveformRenderer.prototype.stop = function () { this.running = false; };

  /** target amplitude (0..1) for bar i at time t for the current state */
  WaveformRenderer.prototype._target = function (i, t) {
    const n = this.bars, c = (n - 1) / 2, d = Math.abs(i - c) / c;   // d: 0 centre → 1 edge
    const k = this.reduced ? 0.4 : 1;
    switch (this.state) {
      case 'listening': {
        if (this.analyser && this.freq) {
          // map bars onto the speech band (~85Hz–4kHz): use lower 60% of bins, mirrored around centre
          const bins = this.freq.length, usable = Math.floor(bins * 0.6);
          const idx = Math.min(usable - 1, Math.floor(d * usable));
          return Math.pow(this.freq[idx] / 255, 1.15) * (1.05 - 0.35 * d);
        }
        // simulated (no mic): jittery voice-like activity
        const env = 0.5 + 0.5 * Math.sin(t * 1.7) * Math.sin(t * 0.63 + 1.3);
        const jit = 0.5 + 0.5 * Math.sin(t * 9 + i * 1.9) * Math.sin(t * 5.3 + i * 0.7);
        return (0.12 + 0.75 * env * jit) * (1 - 0.45 * d) * k;
      }
      case 'thinking': {
        // radar: a bright band travels from the centre outward, repeating
        const ph = (t * 0.85) % 1, dist = Math.abs(d - ph);
        return (0.10 + 0.50 * Math.exp(-dist * dist * 40)) * (1 - 0.25 * d) * k;
      }
      case 'speaking': {
        // smooth flowing, symmetrical (functions of d only) — gentle, rounder than listening
        const kick = 0.55 + 0.45 * this.pulse;
        const flow = 0.5 + 0.5 * Math.sin(t * 3.1 - d * 5.2);
        const flow2 = 0.5 + 0.5 * Math.sin(t * 1.9 - d * 2.6 + 1.1);
        return (0.14 + 0.70 * (0.6 * flow + 0.4 * flow2) * kick) * (1 - 0.55 * d * d) * k;
      }
      default: { // idle: flat line with a faint shimmer
        return 0.035 + 0.035 * (0.5 + 0.5 * Math.sin(t * 1.3 + i * 0.55)) * k;
      }
    }
  };

  WaveformRenderer.prototype._loop = function (now) {
    if (!this.running) return;
    requestAnimationFrame(this._loop);
    if (document.hidden) return;                       // no work in background tabs
    const t = (now - this.t0) / 1000;
    if (this.analyser && this.freq && this.state === 'listening') this.analyser.getByteFrequencyData(this.freq);
    this.pulse *= 0.94;

    const n = this.bars, ctx = this.ctx, W = this.w, H = this.h, dpr = this.dpr;
    const ease = this.state === 'speaking' ? 0.14 : this.state === 'listening' ? 0.38 : 0.2; // speaking = smoother
    let sum = 0;
    for (let i = 0; i < n; i++) {
      const target = clamp(this._target(i, t), 0, 1);
      this.cur[i] += (target - this.cur[i]) * ease;
      sum += this.cur[i];
    }
    this.lastLevel = sum / n;

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    const gap = 3, bw = Math.max(2, (W - gap * (n + 1)) / n), mid = H / 2, maxH = H - 10;
    // palette per state — blue family only
    let a = '#3b6fe6', b = '#7db4ff', glow = 'rgba(80,140,255,.8)';
    if (this.state === 'idle') { a = '#1e3a8a'; b = '#3a62c8'; glow = 'rgba(40,80,200,.45)'; }
    else if (this.state === 'thinking') { a = '#2a4590'; b = '#6d8fdc'; glow = 'rgba(100,140,220,.5)'; }
    else if (this.state === 'speaking') { a = '#3aa0e8'; b = '#a8efff'; glow = 'rgba(110,225,255,.85)'; }
    else { a = '#2563eb'; b = '#8ec5ff'; glow = 'rgba(70,150,255,.95)'; }

    ctx.lineCap = 'round';
    ctx.shadowColor = glow; ctx.shadowBlur = this.state === 'idle' ? 3 : 11;
    const g = ctx.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, b); g.addColorStop(0.5, a); g.addColorStop(1, b);
    ctx.strokeStyle = g; ctx.lineWidth = bw;
    for (let i = 0; i < n; i++) {
      const x = gap + bw / 2 + i * (bw + gap);
      const half = Math.max(1, (this.cur[i] * maxH) / 2);
      ctx.beginPath(); ctx.moveTo(x, mid - half); ctx.lineTo(x, mid + half); ctx.stroke();
    }
  };

  /* =========================================================================
   * 5. VOICE I/O — SpeechRecognition (input) + speechSynthesis (output)
   * ========================================================================= */
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  const TTS = ('speechSynthesis' in window) && typeof window.SpeechSynthesisUtterance === 'function';

  const Voice = {
    supportsRecognition: function () { return !!(window.__VL_MOCK_SR || SR); },
    supportsSpeech: function () { return TTS; },

    // ---- recognition ----
    _rec: null, _active: false, _gotAudio: false, _restartN: 0, _restartTimer: null, _idleTimer: null,
    _stream: null, _actx: null, _src: null, _analyser: null,
    onFinal: null, onInterim: null, onError: null, onEnd: null, onStart: null, onAudioLevelReady: null,

    isListening: function () { return this._active; },

    /** MUST be called from a user gesture (tap). Resolves true if the mic is live. */
    start: async function () {
      if (this._active) return true;
      const Ctor = window.__VL_MOCK_SR || SR;
      if (!Ctor) { this.onError && this.onError('unsupported'); return false; }
      this._active = true; this._restartN = 0;
      // 1) Optional audio-level tap (Web Audio) for the live waveform. A failure here is non-fatal.
      if (CONFIG.micVisualizer && navigator.mediaDevices && navigator.mediaDevices.getUserMedia ) {
        try {
          this._stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
          if (!this._active) { this._releaseStream(); return false; } // user hit STOP while the permission prompt was open
          const AC = window.AudioContext || window.webkitAudioContext;
          this._actx = new AC();
          if (this._actx.state === 'suspended') await this._actx.resume();
          this._src = this._actx.createMediaStreamSource(this._stream);
          this._analyser = this._actx.createAnalyser();
          this._analyser.fftSize = 256; this._analyser.smoothingTimeConstant = 0.75;
          this._src.connect(this._analyser);                      // NOT connected to destination → no feedback
          this.onAudioLevelReady && this.onAudioLevelReady(this._analyser);
        } catch (e) {
          log('mic visualizer unavailable', e && e.name);
          if (e && (e.name === 'NotAllowedError' || e.name === 'SecurityError' || e.name === 'PermissionDeniedError')) {
            this._active = false; this.onError && this.onError('not-allowed'); return false;
          }
          if (e && e.name === 'NotFoundError') { this._active = false; this.onError && this.onError('no-mic'); return false; }
          // other errors: continue without visualizer
        }
      }
      if (!this._active) return false;
      this._startRec();
      this._bumpIdle();
      return true;
    },

    _startRec: function () {
      const Ctor = window.__VL_MOCK_SR || SR; const self = this;
      let rec;
      try { rec = new Ctor(); } catch (e) { this._fail('unsupported'); return; }
      rec.lang = CONFIG.language; rec.continuous = true; rec.interimResults = true; rec.maxAlternatives = 1;
      this._gotAudio = false;
      rec.onstart = function () { self.onStart && self.onStart(); };
      rec.onresult = function (ev) {
        self._bumpIdle(); self._restartN = 0;
        let interim = '';
        for (let i = ev.resultIndex; i < ev.results.length; i++) {
          const r = ev.results[i], txt = r[0] && r[0].transcript || '';
          if (r.isFinal) { if (clean(txt)) self.onFinal && self.onFinal(clean(txt)); }
          else interim += txt;
        }
        self.onInterim && self.onInterim(clean(interim));
      };
      rec.onerror = function (ev) {
        const e = ev && ev.error;
        log('recognition error', e);
        if (e === 'not-allowed' || e === 'service-not-allowed') return self._fail('not-allowed');
        if (e === 'audio-capture') return self._fail('no-mic');
        if (e === 'language-not-supported') return self._fail('language');
        if (e === 'network') { self._netErr = (self._netErr || 0) + 1; if (self._netErr > 2) return self._fail('network'); }
        // 'no-speech' / 'aborted' → normal; onend will auto-restart
      };
      rec.onend = function () {
        // Chrome ends sessions on its own after ~60s or on silence. While the visitor is still "listening", restart.
        if (!self._active || self._rec !== rec) return;
        self._restartN++;
        if (self._restartN > 12) return self._fail('restart-loop');
        clearTimeout(self._restartTimer);
        self._restartTimer = setTimeout(function () { if (self._active) self._startRec(); }, Math.min(1500, 120 * self._restartN));
      };
      this._rec = rec;
      try { rec.start(); } catch (e) { log('rec.start threw', e && e.name); /* InvalidStateError if already started */ }
    },

    _fail: function (code) { this.stop(); this.onError && this.onError(code); },

    _bumpIdle: function () {
      const self = this; clearTimeout(this._idleTimer);
      this._idleTimer = setTimeout(function () { if (self._active) { self.stop(); self.onError && self.onError('idle-timeout'); } }, CONFIG.listenIdleTimeoutMs);
    },

    _releaseStream: function () {
      try { this._src && this._src.disconnect(); } catch (e) {}
      if (this._stream) this._stream.getTracks().forEach(function (t) { try { t.stop(); } catch (e) {} });
      try { this._actx && this._actx.state !== 'closed' && this._actx.close(); } catch (e) {}
      this._stream = this._actx = this._src = this._analyser = null;
    },

    /** stop listening and RELEASE the microphone */
    stop: function () {
      const was = this._active;
      this._active = false; this._netErr = 0;
      clearTimeout(this._restartTimer); clearTimeout(this._idleTimer);
      const rec = this._rec; this._rec = null;
      if (rec) { rec.onend = rec.onerror = rec.onresult = null; try { rec.abort ? rec.abort() : rec.stop(); } catch (e) {} }
      this._releaseStream();
      if (was) this.onEnd && this.onEnd();
    },

    // ---- synthesis ----
    _voice: null, _speaking: false, _genSpeak: 0, _keepAlive: null,
    onSpeakStart: null, onSpeakEnd: null, onBoundary: null,

    pickVoice: function () {
      if (!TTS) return null;
      const vs = speechSynthesis.getVoices(); if (!vs.length) return null;
      if (CONFIG.voiceName) { const v = vs.find(function (x) { return x.name === CONFIG.voiceName; }); if (v) return v; }
      const lang = CONFIG.language.toLowerCase(), base = lang.split('-')[0];
      const cands = vs.filter(function (v) { return v.lang && v.lang.toLowerCase().replace('_', '-').indexOf(base) === 0; });
      const exact = cands.filter(function (v) { return v.lang.toLowerCase().replace('_', '-') === lang; });
      const pool = exact.length ? exact : cands;
      return pool.find(function (v) { return /natural|neural|google|samantha|enhanced/i.test(v.name); }) || pool[0] || null;
    },

    /** split into sentence-sized chunks — long utterances silently die in Chrome (~15s bug) */
    _chunks: function (text) {
      const parts = clean(text).match(/[^.!?;:\n]+[.!?;:]*\s*/g) || [clean(text)];
      const out = []; let cur = '';
      parts.forEach(function (p) {
        if ((cur + p).length > 170 && cur) { out.push(cur.trim()); cur = p; } else cur += p;
      });
      if (cur.trim()) out.push(cur.trim());
      return out.filter(Boolean);
    },

    /** speak text; resolves when finished or cancelled. Never rejects.
     *  onSpeakStart fires when the first audio chunk actually starts (or after a 1.2s fallback). */
    speak: function (text) {
      const self = this;
      if (!TTS || !CONFIG.speak || !clean(text)) return Promise.resolve(false);
      const gen = ++this._genSpeak;
      try { speechSynthesis.cancel(); } catch (e) {}
      const chunks = this._chunks(text);
      this._speaking = true;
      return new Promise(function (resolve) {
        let i = 0, finished = false, started = false, guard = null;
        const fireStart = function () { if (!started && self._genSpeak === gen) { started = true; self.onSpeakStart && self.onSpeakStart(); } };
        const fallback = setTimeout(fireStart, 1200);
        const done = function (ok) {
          if (finished) return; finished = true;
          clearTimeout(fallback); clearTimeout(guard);
          clearInterval(self._keepAlive); self._keepAlive = null;
          if (self._genSpeak === gen) { self._speaking = false; self.onSpeakEnd && self.onSpeakEnd(); }
          resolve(ok);
        };
        const next = function () {
          clearTimeout(guard);
          if (self._genSpeak !== gen) return done(false);          // cancelled / superseded
          if (i >= chunks.length) return done(true);
          const u = new SpeechSynthesisUtterance(chunks[i++]);
          u.lang = CONFIG.language; u.rate = CONFIG.speechRate; u.pitch = CONFIG.speechPitch;
          const v = self._voice || (self._voice = self.pickVoice()); if (v) u.voice = v;
          u.onstart = function () { clearTimeout(guard); fireStart(); };
          u.onboundary = function () { self.onBoundary && self.onBoundary(); };
          u.onend = next;
          u.onerror = function (e) { if (e && (e.error === 'canceled' || e.error === 'interrupted')) return done(false); next(); };
          // watchdog: some engines (headless / no voices installed) never fire any event
          guard = setTimeout(function () { if (!started) { log('speech engine did not start; giving up on audio'); done(false); } }, 3000);
          try { speechSynthesis.speak(u); } catch (e) { done(false); }
        };
        // Chrome stalls long queues: nudge pause/resume while speaking
        self._keepAlive = setInterval(function () {
          if (speechSynthesis.speaking && !speechSynthesis.paused) { speechSynthesis.pause(); speechSynthesis.resume(); }
        }, 10000);
        next();
      });
    },

    cancelSpeech: function () {
      this._genSpeak++;
      clearInterval(this._keepAlive); this._keepAlive = null;
      try { TTS && speechSynthesis.cancel(); } catch (e) {}
      if (this._speaking) { this._speaking = false; this.onSpeakEnd && this.onSpeakEnd(); }
    },
    isSpeaking: function () { return this._speaking; }
  };
  if (TTS) { try { speechSynthesis.onvoiceschanged = function () { Voice._voice = null; }; } catch (e) {} }

  /* =========================================================================
   * 6. UI — everything lives in a Shadow DOM so host CSS can't break us and we can't break the host.
   *    The host page DOM is never modified (highlight rings are overlays inside our own shadow root).
   * ========================================================================= */
  const ICON = {
    mic: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/></svg>',
    close: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>',
    vol: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 9v6h4l5 4V5L8 9H4z"/><path d="M16.5 8.5a5 5 0 0 1 0 7M19 6a8.5 8.5 0 0 1 0 12"/></svg>',
    mute: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 9v6h4l5 4V5L8 9H4z"/><path d="M17 9l5 6M22 9l-5 6"/></svg>'
  };
  const MOBILE_MQ = '(max-width: 600px)';
  const POS_KEY = 'voicelayer.orb', SPEAK_KEY = 'voicelayer.speak', RESUME_KEY = 'voicelayer.resume';
  const store = {
    get: function (k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set: function (k, v) { try { localStorage.setItem(k, v); } catch (e) {} },
    sget: function (k) { try { return sessionStorage.getItem(k); } catch (e) { return null; } },
    sset: function (k, v) { try { v == null ? sessionStorage.removeItem(k) : sessionStorage.setItem(k, v); } catch (e) {} }
  };

  const UI = {
    h: {},                 // handlers set by controller: onOrb, onMic, onStop, onClose, onSubmit, onMute, onForce
    host: null, root: null, shadow: null,
    orb: null, panel: null, wave: null, canvas: null, captions: null, interim: null, stateChip: null,
    input: null, micBtn: null, muteBtn: null, layer: null,
    open: false, pos: { fx: 1, fy: 1 }, _suppressUntil: 0, rings: [], _ringRaf: 0, forced: null,

    isMobile: function () { return !!(window.matchMedia && matchMedia(MOBILE_MQ).matches); },
    vw: function () { return document.documentElement.clientWidth || window.innerWidth; },
    vh: function () { return window.innerHeight || document.documentElement.clientHeight; },

    build: function (h) {
      const self = this; this.h = h;
      const host = this.host = document.createElement('div');
      host.id = 'voicelayer-root';
      host.setAttribute('data-vl-ignore', '');
      host.style.cssText = 'all:initial;position:fixed;z-index:2147483646;left:0;top:0;width:0;height:0;';
      const sh = this.shadow = host.attachShadow({ mode: 'open' });
      const T = CONFIG.text;

      // stylesheet inside the shadow root (works from file:// too, unlike fetch())
      const link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = CONFIG.cssUrl || ((SCRIPT && SCRIPT.src) ? SCRIPT.src.replace(/[^\/?#]*(\?.*)?(#.*)?$/, '') + 'voicelayer.css' : 'voicelayer.css');
      sh.appendChild(link);

      const root = this.root = document.createElement('div');
      root.className = 'vl-root'; root.setAttribute('data-state', 'idle'); root.setAttribute('data-open', 'false');
      if (CONFIG.debug) root.setAttribute('data-debug', 'true');
      root.innerHTML =
        '<div class="vl-layer" id="vl-layer"></div>' +
        '<button class="vl-orb" type="button" id="vl-orb" aria-label="' + T.openLabel + '" aria-haspopup="dialog" aria-expanded="false">' + ICON.mic + '</button>' +
        '<section class="vl-panel" id="vl-panel" role="dialog" aria-label="' + T.title + '" tabindex="-1">' +
          '<header class="vl-head">' +
            '<span class="vl-title">' + T.title + '</span>' +
            '<span class="vl-state" id="vl-state" role="status" aria-live="polite">' + T.states.idle + '</span>' +
            '<span class="vl-spacer"></span>' +
            '<button class="vl-iconbtn" type="button" id="vl-mute" aria-label="Mute spoken replies" aria-pressed="false">' + ICON.vol + '</button>' +
            '<button class="vl-iconbtn" type="button" id="vl-close" aria-label="' + T.closeLabel + '">' + ICON.close + '</button>' +
          '</header>' +
          '<canvas class="vl-wave" id="vl-wave" aria-hidden="true"></canvas>' +
          '<div class="vl-captions" id="vl-captions" role="log" aria-live="polite" aria-label="Conversation"></div>' +
          '<div class="vl-interim" id="vl-interim" aria-hidden="true"></div>' +
          '<form class="vl-form" id="vl-form" autocomplete="off">' +
            '<input class="vl-input" id="vl-input" type="text" enterkeyhint="send" aria-label="Type a command" placeholder="' + T.placeholder + '" />' +
            '<button class="vl-send" type="submit">' + T.send + '</button>' +
          '</form>' +
          '<div class="vl-controls">' +
            '<button class="vl-mic" type="button" id="vl-mic" aria-pressed="false">' + ICON.mic + '<span id="vl-mictxt">' + T.micIdle + '</span></button>' +
            '<button class="vl-stop" type="button" id="vl-stop" aria-label="Stop everything">' + T.stop + '</button>' +
          '</div>' +
          '<p class="vl-note">' + T.privacy + '</p>' +
          '<div class="vl-debug" id="vl-debug"><span>force state:</span>' +
            STATES.map(function (s) { return '<button type="button" data-force="' + s + '" aria-pressed="false">' + s + '</button>'; }).join('') +
            '<button type="button" data-force="auto" aria-pressed="false">auto</button></div>' +
        '</section>';
      sh.appendChild(root);

      const $ = function (id) { return sh.getElementById ? sh.getElementById(id) : root.querySelector('#' + id); };
      this.orb = $('vl-orb'); this.panel = $('vl-panel'); this.canvas = $('vl-wave'); this.captions = $('vl-captions');
      this.interim = $('vl-interim'); this.stateChip = $('vl-state'); this.input = $('vl-input'); this.micBtn = $('vl-mic');
      this.muteBtn = $('vl-mute'); this.layer = $('vl-layer'); this.micTxt = $('vl-mictxt');

      const mount = function () {
        (document.body || document.documentElement).appendChild(host);
        self.wave = new WaveformRenderer(self.canvas); self.wave.start();
      };
      if (document.body) mount(); else document.addEventListener('DOMContentLoaded', mount);

      const ready = function () { root.classList.add('vl-ready'); self.placeOrb(); self.wave && self.wave.resize(); };
      link.addEventListener('load', ready);
      link.addEventListener('error', function () { console.warn('[VoiceLayer] could not load voicelayer.css from', link.href); ready(); });
      setTimeout(function () { if (!root.classList.contains('vl-ready')) ready(); }, 3000);

      // --- initial position (corner + offsets, or remembered position) ---
      const saved = CONFIG.rememberPosition && store.get(POS_KEY);
      if (saved) { try { const p = JSON.parse(saved); if (isFinite(p.fx) && isFinite(p.fy)) this.pos = { fx: clamp(p.fx, 0, 1), fy: clamp(p.fy, 0, 1) }; } catch (e) { this._cornerPos(); } }
      else this._cornerPos();
      this.placeOrb();

      // --- orb: drag vs. tap ---
      let drag = null;
      this.orb.addEventListener('pointerdown', function (e) {
        if (e.pointerType === 'mouse' && e.button !== 0) return;
        const r = self.orb.getBoundingClientRect();
        drag = { sx: e.clientX, sy: e.clientY, ox: r.left, oy: r.top, moved: false };
        try { self.orb.setPointerCapture(e.pointerId); } catch (x) {}
      });
      this.orb.addEventListener('pointermove', function (e) {
        if (!drag) return;
        const dx = e.clientX - drag.sx, dy = e.clientY - drag.sy;
        if (!drag.moved && Math.hypot(dx, dy) < 6) return;
        drag.moved = true;
        const maxX = self.vw() - 60, maxY = self.vh() - 60;
        const x = clamp(drag.ox + dx, 0, maxX), y = clamp(drag.oy + dy, 0, maxY);
        self.pos = { fx: maxX > 0 ? x / maxX : 0, fy: maxY > 0 ? y / maxY : 0 };
        self.placeOrb(); if (self.open) self.positionPanel();
      });
      const endDrag = function () {
        if (drag && drag.moved) {
          self._suppressUntil = performance.now() + 400;       // swallow the click that follows a drag
          if (CONFIG.rememberPosition) store.set(POS_KEY, JSON.stringify(self.pos));
        }
        drag = null;
      };
      this.orb.addEventListener('pointerup', endDrag);
      this.orb.addEventListener('pointercancel', endDrag);
      this.orb.addEventListener('click', function () {
        if (performance.now() < self._suppressUntil) return;
        self.h.onOrb && self.h.onOrb();
      });

      // --- panel controls ---
      $('vl-close').addEventListener('click', function () { self.h.onClose && self.h.onClose(); });
      $('vl-stop').addEventListener('click', function () { self.h.onStop && self.h.onStop(); });
      this.micBtn.addEventListener('click', function () { self.h.onMic && self.h.onMic(); });
      this.muteBtn.addEventListener('click', function () { self.h.onMute && self.h.onMute(); });
      $('vl-form').addEventListener('submit', function (e) {
        e.preventDefault(); const v = self.input.value; self.input.value = '';
        if (clean(v)) self.h.onSubmit && self.h.onSubmit(v);
      });
      this.panel.addEventListener('keydown', function (e) {
        if (e.key === 'Escape') { e.stopPropagation(); self.h.onClose && self.h.onClose(); }
      });
      qsa('[data-force]', root).forEach(function (b) {
        b.addEventListener('click', function () { self.h.onForce && self.h.onForce(b.getAttribute('data-force')); });
      });

      window.addEventListener('resize', function () { self.placeOrb(); if (self.open) self.positionPanel(); self.wave && self.wave.resize(); self._updateRings(); });
    },

    _cornerPos: function () {
      const o = CONFIG.orbPosition, c = String(o.corner || 'bottom-right');
      const maxX = Math.max(1, this.vw() - 60), maxY = Math.max(1, this.vh() - 60);
      const x = /left/.test(c) ? o.offsetX : maxX - o.offsetX, y = /top/.test(c) ? o.offsetY : maxY - o.offsetY;
      this.pos = { fx: clamp(x / maxX, 0, 1), fy: clamp(y / maxY, 0, 1) };
    },
    orbXY: function () {
      const maxX = Math.max(0, this.vw() - 60), maxY = Math.max(0, this.vh() - 60);
      return { x: Math.round(this.pos.fx * maxX), y: Math.round(this.pos.fy * maxY) };
    },
    placeOrb: function () {
      if (!this.orb) return; const p = this.orbXY();
      this.orb.style.left = p.x + 'px'; this.orb.style.top = p.y + 'px';
    },
    positionPanel: function () {
      if (!this.panel || this.isMobile()) { if (this.panel) { this.panel.style.left = this.panel.style.top = this.panel.style.width = ''; } return; }
      const vw = this.vw(), vh = this.vh(), p = this.orbXY();
      const pw = Math.min(380, vw - 16); this.panel.style.width = pw + 'px';
      const ph = this.panel.offsetHeight;
      let x = (p.x + 30) > vw / 2 ? p.x + 60 - pw : p.x; x = clamp(x, 8, Math.max(8, vw - pw - 8));
      let y = p.y - ph - 12, below = false;
      if (y < 8) { y = p.y + 72; below = true; }
      if (y + ph > vh - 8) y = Math.max(8, vh - ph - 8);
      this.panel.style.left = x + 'px'; this.panel.style.top = y + 'px';
      this.panel.style.transformOrigin = (below ? 'top ' : 'bottom ') + ((p.x + 30) > vw / 2 ? 'right' : 'left');
    },

    setOpen: function (on) {
      this.open = !!on;
      this.root.setAttribute('data-open', on ? 'true' : 'false');
      this.orb.setAttribute('aria-expanded', on ? 'true' : 'false');
      if (on) {
        this.positionPanel();
        this.wave && this.wave.resize();
        const self = this; setTimeout(function () { try { self.panel.focus({ preventScroll: true }); } catch (e) {} }, 30);
      } else { try { this.orb.focus({ preventScroll: true }); } catch (e) {} }
    },

    setState: function (s) {
      if (this.forced) s = this.forced;
      this.root.setAttribute('data-state', s);
      this.stateChip.textContent = CONFIG.text.states[s] || s;
      this.wave && this.wave.setState(s);
    },
    force: function (s) {
      this.forced = (s === 'auto' || !s) ? null : s;
      qsa('[data-force]', this.root).forEach(function (b) { b.setAttribute('aria-pressed', String(b.getAttribute('data-force') === (s || 'auto'))); });
    },

    setMicUI: function (listening, available, reason) {
      this.micBtn.setAttribute('aria-pressed', String(!!listening));
      this.micTxt.textContent = listening ? CONFIG.text.micActive : CONFIG.text.micIdle;
      this.micBtn.disabled = !available;
      this.micBtn.title = available ? '' : (reason || 'Voice input unavailable');
    },
    setMuteUI: function (muted) {
      this.muteBtn.innerHTML = muted ? ICON.mute : ICON.vol;
      this.muteBtn.setAttribute('aria-pressed', String(!!muted));
      this.muteBtn.setAttribute('aria-label', muted ? 'Unmute spoken replies' : 'Mute spoken replies');
    },

    /** kind: 'bot' | 'user' | 'sys' */
    addLine: function (kind, text, opts) {
      const d = document.createElement('div');
      d.className = 'vl-line ' + kind + (opts && opts.verified ? ' verified' : '');
      d.textContent = text;
      this.captions.appendChild(d);
      while (this.captions.children.length > 60) this.captions.removeChild(this.captions.firstChild);
      this.captions.scrollTop = this.captions.scrollHeight;
      if (this.open) this.positionPanel();
      return d;
    },
    setInterim: function (t) { this.interim.textContent = t || ''; },

    /* ---- highlight rings. items: [{getRect():DOMRect-like, n?:number}] ---- */
    showRings: function (items, ms) {
      this.clearRings();
      const self = this;
      items.forEach(function (it, i) {
        const ring = document.createElement('div'); ring.className = 'vl-ring vl-ring-in';
        if (items.length > 1 && it.n != null) { const b = document.createElement('span'); b.className = 'vl-badge'; b.textContent = it.n; ring.appendChild(b); }
        self.layer.appendChild(ring); self.rings.push({ it: it, el: ring });
      });
      this._updateRings();
      if (!this._ringBound) {
        this._ringBound = true;
        const kick = function () { if (self.rings.length && !self._ringRaf) self._ringRaf = requestAnimationFrame(function () { self._ringRaf = 0; self._updateRings(); }); };
        window.addEventListener('scroll', kick, true); window.addEventListener('resize', kick);
      }
      clearTimeout(this._ringTimer);
      this._ringTimer = setTimeout(function () { self.clearRings(); }, ms || CONFIG.highlightMs);
    },
    _updateRings: function () {
      this.rings.forEach(function (r) {
        const b = r.it.getRect(); const pad = 5;
        if (!b || (!b.width && !b.height)) { r.el.style.display = 'none'; return; }
        r.el.style.display = '';
        r.el.style.left = (b.left - pad) + 'px'; r.el.style.top = (b.top - pad) + 'px';
        r.el.style.width = (b.width + pad * 2) + 'px'; r.el.style.height = (b.height + pad * 2) + 'px';
      });
    },
    clearRings: function () {
      clearTimeout(this._ringTimer);
      this.rings.forEach(function (r) { r.el.remove(); }); this.rings = [];
    }
  };

  /* =========================================================================
   * 7. COMMANDS — a small English grammar. Rule-based on purpose (Phase 0):
   *    no LLM means page text can never "instruct" the assistant.
   * ========================================================================= */
  const ORD = { first: 1, one: 1, '1': 1, second: 2, two: 2, '2': 2, third: 3, three: 3, '3': 3, fourth: 4, four: 4, '4': 4, fifth: 5, five: 5, '5': 5, last: -1 };
  const YES_RE = /^(yes|yeah|yep|yup|sure|ok|okay|confirm|go ahead|do it|proceed|please do|affirmative|correct|right)( please)?$/;
  const NO_RE = /^(no|nope|nah|none|neither|cancel|never ?mind|nothing|forget it|dont|do not|dont do it|negative)( thanks| thank you)?$/;
  const GENERIC_READ = /^(this|that|it|this page|the page|page|aloud|out loud|to me|this page aloud|the main content|main content|content|the content|whats on screen|the screen|screen|what is on screen|this section|here)( aloud| out loud| to me)?$/;

  function parse(raw) {
    let t = norm(raw);
    t = t.replace(/^(hey |ok |okay |hi |hello )?(voice ?layer|assistant)\s+/, '');
    for (let i = 0; i < 3; i++) t = t.replace(/^(please|could you|can you|would you|will you|i want to|i would like to|i d like to|i need to|lets|let s|i wanna|go ahead and)\s+/, '');
    t = t.replace(/\s+(please|thanks|thank you)$/, '').trim();
    let m;
    if (!t) return { type: 'empty', raw: raw };
    if (/^(stop|cancel|quiet|silence|shut up|be quiet|enough|halt|stop (talking|listening|reading|speaking|it|that|everything))$/.test(t)) return { type: 'stop', raw: raw };
    if (/^(close|dismiss|hide|goodbye|bye|exit|go away|close (the |this )?(assistant|panel|widget|window|chat|this|voice ?layer|it))$/.test(t)) return { type: 'close', raw: raw };
    if (/^(help|commands|what can (you|i) (do|say)|what are the commands|how do (i|you) (use|work)|how does this work)$/.test(t)) return { type: 'help', raw: raw };
    if (/(what is|what s|whats|whats up with) (this|the) (site|website|page|store|shop|place)|tell me about (this|the) (site|website|page|store|shop)|about (this|the) (site|website|page)|(describe|summari[sz]e|explain|overview of) (this|the) (site|website|page|store)|what (can i do|do you sell|do they sell|do you have|do they have) here|where am i|^summary$|^summari[sz]e$/.test(t)) return { type: 'about', raw: raw };
    if ((m = t.match(/^read(?: out| aloud)?(?: (.+))?$/))) {
      const rest = (m[1] || '').trim();
      if (!rest || GENERIC_READ.test(rest)) return { type: 'read', raw: raw };
      return { type: 'read', arg: rest.replace(/^(the|out|aloud)\s+/, ''), raw: raw };
    }
    if (/^(next|next one|next match|next result|show next|again)$/.test(t)) return { type: 'step', dir: 1, raw: raw };
    if (/^(previous|previous one|previous match|previous result|back one|prior)$/.test(t)) return { type: 'step', dir: -1, raw: raw };
    if (/^(go back|back|navigate back|previous page)$/.test(t)) return { type: 'history', raw: raw };
    if ((m = t.match(/^(?:go|scroll|jump|take me|bring me|move)(?: back)?(?: to)?(?: the)? (top|bottom|very top|very bottom|start|end|beginning)(?: of (?:the |this )?page)?$/)) || (m = t.match(/^(top|bottom|page top|page bottom)$/)))
      return { type: 'scrollto', where: /bottom|end/.test(m[1]) ? 'bottom' : 'top', raw: raw };
    if ((m = t.match(/^(?:scroll|page|go|move) (down|up)(?: a (?:bit|little))?$/))) return { type: 'scrollby', dir: m[1], raw: raw };
    if ((m = t.match(/^add (.+?) to (?:my |the )?(?:cart|bag|basket)$/))) return { type: 'click', arg: 'add ' + m[1] + ' to cart', raw: raw };
    if ((m = t.match(/^(?:click|press|tap|hit|push|select|choose|activate|trigger)(?: on)?(?: the)? (.+)$/))) return { type: 'click', arg: m[1], raw: raw };
    if ((m = t.match(/^(?:find|search(?: for)?|look for|look up|highlight|where (?:is|are)|locate|spot)(?: me)?(?: the| any| a)? (.+)$/))) return { type: 'find', arg: m[1], raw: raw };
    if ((m = t.match(/^(go to|goto|go|take me to|navigate to|jump to|scroll to|bring me to|head to|visit|bring up)(?: the)? (.+)$/))) return { type: 'go', arg: m[2], raw: raw };
    if ((m = t.match(/^(open|show me|show)(?: the)? (.+)$/))) return { type: 'go', arg: m[2], soft: m[1], raw: raw };
    return { type: 'unknown', arg: t, raw: raw };
  }

  /* ---------- page helpers used by commands ---------- */
  function prefersReduced() { return !!(window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches); }
  function scrollParent(el) {
    let p = el.parentElement;
    while (p && p !== document.body && p !== document.documentElement) {
      const cs = getComputedStyle(p);
      if (/(auto|scroll)/.test(cs.overflowY) && p.scrollHeight > p.clientHeight + 4) return p;
      p = p.parentElement;
    }
    return null;
  }
  /** scroll el into view (mode 'top' keeps CONFIG.scrollOffset free above; 'center' centres it) and wait until the scroll settles */
  async function scrollToEl(el, mode, tok, alive) {
    const behavior = prefersReduced() ? 'auto' : 'smooth';
    if (scrollParent(el)) { try { el.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'auto' }); } catch (e) {} }
    const r = el.getBoundingClientRect(), vh = window.innerHeight;
    let top = window.scrollY + r.top - (mode === 'top' ? CONFIG.scrollOffset : (vh / 2 - Math.min(r.height, vh * 0.6) / 2));
    const maxTop = Math.max(0, document.documentElement.scrollHeight - vh);
    top = clamp(top, 0, maxTop);
    if (Math.abs(top - window.scrollY) > 2) { try { window.scrollTo({ top: top, behavior: behavior }); } catch (e) { window.scrollTo(0, top); } }
    // wait for the scroll to settle
    let last = -1, stable = 0; const t0 = performance.now();
    while (performance.now() - t0 < 1800) {
      await sleep(50);
      if (alive && !alive()) return false;
      const y = window.scrollY;
      if (Math.abs(y - last) < 1) { if (++stable >= 3) break; } else stable = 0;
      last = y;
    }
    return true;
  }
  function rectOf(el) { return function () { return el.getBoundingClientRect(); }; }

  /** main content element for "read this" / "about" */
  function mainEl() { return document.querySelector('main, [role="main"], article') || document.body; }
  function visibleBlocks(root) {
    const blocks = qsa('h1,h2,h3,h4,h5,p,li,blockquote,figcaption,dt,dd,td,th,summary', root)
      .filter(function (el) { return !el.closest(SKIP_SEL) && !el.closest('nav, header nav, footer, aside, [role="navigation"]') && isVisible(el) && (el.innerText || '').trim().length > 1; });
    // drop blocks that contain other kept blocks (avoid reading text twice)
    return blocks.filter(function (el) { return !blocks.some(function (o) { return o !== el && el.contains(o); }); });
  }
  function textMatches(q) {
    const nq = norm(q); if (!nq) return [];
    const out = [], seen = new Set();
    const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode: function (n) {
        const p = n.parentElement;
        if (!p || !n.nodeValue.trim() || p.closest(SKIP_SEL)) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      }
    });
    let n, guard = 0;
    while ((n = w.nextNode()) && guard++ < 20000 && out.length < 60) {
      if (norm(n.nodeValue).indexOf(nq) >= 0) {
        const p = n.parentElement;
        if (!seen.has(p) && isVisible(p)) { seen.add(p); out.push(p); }
      }
    }
    return out;
  }
  function orList(arr) { return arr.length < 2 ? arr.join('') : arr.slice(0, -1).join(', ') + ' or ' + arr[arr.length - 1]; }
  function andList(arr) { return arr.length < 2 ? arr.join('') : arr.slice(0, -1).join(', ') + ' and ' + arr[arr.length - 1]; }
  function uniq(arr) { const s = new Set(); return arr.filter(function (x) { const k = norm(x); if (s.has(k)) return false; s.add(k); return true; }); }

  /* ---- candidate builders ---- */
  function goCandidates() {
    const m = Scanner.map, cands = [];
    const byId = function (h) { try { return document.getElementById(decodeURIComponent(h.slice(1))); } catch (e) { return null; } };
    m.headings.forEach(function (h) { cands.push({ label: h.text, kind: 'section', el: h.el, key: h.el, bonus: 0 }); });
    m.anchors.forEach(function (a) { cands.push({ label: a.text, kind: 'section', el: a.el, key: a.el, bonus: -0.01 }); });
    m.links.forEach(function (l) {
      const hash = l.rawHref && l.rawHref.charAt(0) === '#' && l.rawHref.length > 1;
      const tgt = hash ? byId(l.rawHref) : null;
      if (hash && !tgt) return;                                     // dead hash link
      const sameDoc = !hash && l.el.href && l.el.href.split('#')[0] === location.href.split('#')[0] && !(l.el.hash);
      cands.push({
        label: l.text, kind: tgt ? 'section' : 'page', el: tgt || l.el, link: l.el, key: tgt || ('url:' + l.el.href.replace(/#.*$/, '')),
        bonus: (l.nav ? 0.03 : -0.02) + (sameDoc ? -0.05 : 0)
      });
    });
    return cands.filter(function (c) { return c.el && c.el.isConnected && (c.kind === 'page' ? true : isVisible(c.el) || isVisible(c.el.firstElementChild || c.el)); });
  }
  function clickCandidates() {
    const m = Scanner.map, out = [];
    const add = function (el, text, kind, extra) {
      if (!isVisible(el)) return;
      const ctx = contextOf(el);
      out.push({ el: el, text: text, ctx: ctx, kind: kind, disabled: isDisabled(el), href: el.href || '', _x: extra });
    };
    m.buttons.forEach(function (b) { add(b.el, b.text, 'button'); });
    m.links.forEach(function (l) { add(l.el, l.text, 'link'); });
    return out;
  }
  function describe(c) { return c.ctx && norm(c.ctx) !== norm(c.text) ? (c.text + ', ' + c.ctx) : c.text; }

  /* =========================================================================
   * 8. CONTROLLER — state machine, command execution, and honest receipts
   * ========================================================================= */
  const VL = {
    token: 0, busy: false, muted: false, speechStarted: false, pending: null, findState: null,
    introDone: false, receipts: [], lastSpeechEnd: 0, lastSpoken: '', state: 'idle', _interrupt: null,

    init: function () {
      const self = this;
      this.muted = store.get(SPEAK_KEY) === 'off';
      UI.build({
        onOrb: function () { self.onOrb(); },
        onMic: function () { self.toggleListening(); },
        onStop: function () { self.stop(true); },
        onClose: function () { self.close(); },
        onSubmit: function (v) { self.handleUtterance(v, 'text'); },
        onMute: function () { self.setMuted(!self.muted); },
        onForce: function (s) { UI.force(s); self.refresh(); }
      });
      UI.setMuteUI(this.muted);
      UI.setMicUI(false, Voice.supportsRecognition(), Voice.supportsRecognition() ? '' : 'Voice input is not supported in this browser');

      Voice.onStart = function () { self.refresh(); };
      Voice.onFinal = function (t) { self.handleUtterance(t, 'voice'); };
      Voice.onInterim = function (t) { UI.setInterim(Voice.isSpeaking() ? '' : t); };
      Voice.onEnd = function () { UI.setMicUI(false, Voice.supportsRecognition()); UI.setInterim(''); UI.wave && UI.wave.setAnalyser(null); self.refresh(); };
      Voice.onAudioLevelReady = function (an) { UI.wave && UI.wave.setAnalyser(an); };
      Voice.onError = function (code) { self.onVoiceError(code); };
      Voice.onSpeakStart = function () { self.speechStarted = true; self.refresh(); };
      Voice.onSpeakEnd = function () { self.speechStarted = false; self.lastSpeechEnd = performance.now(); self.refresh(); };
      Voice.onBoundary = function () { UI.wave && UI.wave.kick(1); };

      // global safety nets
      document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && (self.busy || Voice.isSpeaking() || self._acting)) self.stop(true); }, true);
      window.addEventListener('pagehide', function () { Voice.stop(); Voice.cancelSpeech(); });

      // scan once the DOM is ready, then keep the map fresh
      const boot = function () { Scanner.scan(); Scanner.watch(); };
      if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
      window.addEventListener('load', function () { Scanner.scan(); });

      // continue after an assistant-triggered navigation (panel re-opens; mic stays OFF)
      if (CONFIG.resumeAfterNavigation && store.sget(RESUME_KEY)) {
        store.sset(RESUME_KEY, null);
        const resume = function () {
          self.open(false);
          self.say('Here we are: ' + (document.title || 'the new page') + '. Tap the mic when you want to keep talking.', { silent: true });
        };
        if (document.readyState === 'complete') setTimeout(resume, 50); else window.addEventListener('load', function () { setTimeout(resume, 50); });
      }
      if (CONFIG.debug) log('debug mode on — use the force-state buttons in the panel');
    },

    /* ---------- open / close / listening ---------- */
    open: function (listen) {
      UI.setOpen(true);
      if (!this.introDone) {
        this.introDone = true;
        if (!Voice.supportsRecognition()) UI.addLine('sys', 'Voice input isn’t supported in this browser, so type below — I’ll still answer out loud.');
        if (!Voice.supportsSpeech()) UI.addLine('sys', 'This browser can’t speak, so I’ll answer in text.');
        if (CONFIG.greeting) this.say(CONFIG.greeting, { silent: !CONFIG.speakGreeting });
      }
      if (listen && CONFIG.listenOnOpen && Voice.supportsRecognition()) this.startListening();
      this.refresh();
    },
    close: function () {
      this.stop(false);
      UI.setOpen(false); UI.setInterim('');
      this.refresh();
    },
    onOrb: function () {
      if (!UI.open) return this.open(true);                       // tap = open + (consent gesture) start mic
      if (Voice.isSpeaking()) { Voice.cancelSpeech(); this.refresh(); return; }   // barge-in
      this.toggleListening();
    },
    toggleListening: function () { Voice.isListening() ? this.stopListening() : this.startListening(); },
    startListening: async function () {
      if (!Voice.supportsRecognition()) { this.say('Voice input isn’t available in this browser. Type your command below and I’ll answer out loud.'); return; }
      Voice.cancelSpeech();
      UI.setMicUI(true, true);
      const ok = await Voice.start();           // browser permission prompt happens here, inside the user's tap
      if (!ok) UI.setMicUI(false, true);
      this.refresh();
    },
    stopListening: function () { Voice.stop(); this.refresh(); },
    setMuted: function (m) {
      this.muted = !!m; store.set(SPEAK_KEY, m ? 'off' : 'on'); UI.setMuteUI(m);
      if (m) Voice.cancelSpeech();
      this.refresh();
    },
    onVoiceError: function (code) {
      const msg = {
        'not-allowed': 'Microphone access was blocked. You can allow it in your browser’s site settings — or just type below and I’ll still answer out loud.',
        'no-mic': 'I can’t find a microphone. You can type your command below instead.',
        'unsupported': 'Voice input isn’t supported in this browser. Type below — I’ll still answer out loud.',
        'network': 'The browser’s speech service isn’t reachable right now. You can type your commands instead.',
        'language': 'This browser doesn’t support speech recognition for “' + CONFIG.language + '”. Type your commands instead.',
        'idle-timeout': 'I turned the microphone off after a while without hearing anything. Tap the mic to talk again.',
        'restart-loop': 'Speech recognition keeps stopping on this browser. You can type your commands instead.'
      }[code] || 'Speech recognition stopped (' + code + '). You can type instead.';
      UI.setMicUI(false, code !== 'unsupported');
      this.say(msg, { silent: code !== 'idle-timeout' && code !== 'not-allowed' ? false : true });
      this.refresh();
    },
    stop: function (announce) {
      this.token++; this._acting = false;
      Voice.cancelSpeech(); Voice.stop();
      this.pending = null; this.busy = false; this.speechStarted = false;
      UI.clearRings(); UI.setInterim('');
      if (this._interrupt) this._interrupt();
      if (announce) UI.addLine('sys', 'Stopped — nothing is running and the microphone is off.');
      this.refresh();
    },

    /* ---------- state ---------- */
    refresh: function () {
      let s = 'idle';
      if (Voice.isSpeaking() && this.speechStarted) s = 'speaking';
      else if (this.busy) s = 'thinking';
      else if (Voice.isListening()) s = 'listening';
      UI.setState(s);
      UI.setMicUI(Voice.isListening(), Voice.supportsRecognition());
      if (s !== this.state) {
        this.state = s;
        try { window.dispatchEvent(new CustomEvent('voicelayer:state', { detail: { state: s } })); } catch (e) {}
      }
    },
    setBusy: function (b) { this.busy = b; this.refresh(); },

    /* ---------- output ---------- */
    canSpeak: function () { return CONFIG.speak && !this.muted && Voice.supportsSpeech() && UI.open; },
    /** show a caption and (unless silent/muted) speak it. Interrupts anything currently being spoken. */
    say: function (text, o) {
      o = o || {};
      UI.addLine(o.kind || 'bot', text, { verified: o.verified });
      if (o.silent || !this.canSpeak()) { this.refresh(); return Promise.resolve(false); }
      this.lastSpoken = text;
      return Voice.speak(text);
    },

    /* ---------- input ---------- */
    handleUtterance: function (text, source) {
      text = clean(text); if (!text) return;
      if (source === 'voice') {
        const t = norm(text);
        if (Voice.isSpeaking()) {
          // we are talking: the mic may be hearing our own voice. Only an explicit stop word gets through.
          if (/^(stop|quiet|cancel|be quiet|stop it|stop talking)$/.test(t)) return this.stop(true);
          return;
        }
        // just finished talking: drop it ONLY if it looks like an echo of what we said (never drop a real command)
        if (performance.now() - this.lastSpeechEnd < 2500 && this.lastSpoken && t.split(' ').length >= 4) {
          const said = norm(this.lastSpoken);
          const words = t.split(' '), hit = words.filter(function (w) { return said.indexOf(w) >= 0; }).length;
          if (said.indexOf(t) >= 0 || hit / words.length >= 0.85) { log('ignored echo of own speech:', t); return; }
        }
      }
      UI.addLine('user', text);
      const quick = parse(text).type;
      if (quick === 'stop') return this.stop(true);        // STOP must be instant — no thinking delay
      this.run(text);
    },
    /** run a command string (used by voice, typed input and tests) */
    run: async function (text) {
      const tok = ++this.token;
      const alive = function () { return tok === VL.token; };
      this.setBusy(true);
      try {
        let intent;
        const pend = this.pending, t = norm(text);
        if (pend && performance.now() < pend.until) {
          const r = this.resolvePending(pend, t);
          if (r) { this.pending = null; intent = r; }
        } else this.pending = null;
        intent = intent || parse(text);
        if (intent.type !== 'step') { /* keep findState for next/previous only */ }
        try { window.dispatchEvent(new CustomEvent('voicelayer:command', { detail: { text: text, intent: intent.type, arg: intent.arg || '' } })); } catch (e) {}
        log('intent', intent);
        await sleep(CONFIG.thinkingMs);
        if (!alive()) return;
        if (!Scanner.map || Date.now() - Scanner.map.scannedAt > 1500) Scanner.scan();
        await this.exec(intent, tok, alive);
      } catch (e) {
        console.error('[VoiceLayer]', e);
        if (alive()) await this.say('Sorry — something went wrong while doing that. Nothing was changed. You can try again or say help.');
      } finally {
        if (alive()) this.setBusy(false);
      }
    },

    resolvePending: function (pend, t) {
      if (pend.kind === 'confirm') {
        if (YES_RE.test(t)) return { type: '_confirmed', run: pend.run };
        if (NO_RE.test(t)) return { type: '_declined', what: pend.label };
        return null;                          // anything else = a new command; pending is dropped
      }
      if (pend.kind === 'choose') {
        if (NO_RE.test(t)) return { type: '_declined', what: 'that' };
        let m = t.match(/^(?:i mean |i meant |the |number |option |no\.? |# ?)*(first|second|third|fourth|fifth|last|1|2|3|4|5|one|two|three|four|five)(?: one| option| button| link)?$/);
        if (m) {
          let n = ORD[m[1]]; if (n === -1) n = pend.options.length;
          if (n >= 1 && n <= pend.options.length) return { type: '_chosen', option: pend.options[n - 1] };
          return { type: '_badchoice', max: pend.options.length };
        }
        const hits = rank(pend.options, t, 0.6, function (o) { return o.pick || o.label; });
        if (hits.length && (hits.length === 1 || hits[0].score - hits[1].score > 0.12)) return { type: '_chosen', option: hits[0].item };
        return null;
      }
      return null;
    },

    receipt: function (r) {
      r.verified = r.verification === 'read_back';       // contract: verified ⇔ independent read-back
      r.at = new Date().toISOString();
      this.receipts.push(r);
      try { window.dispatchEvent(new CustomEvent('voicelayer:receipt', { detail: r })); } catch (e) {}
      log('receipt', r);
      return r;
    },

    /** offer numbered choices: rings with badges + spoken list. */
    askChoose: function (intro, options, tok) {
      options.forEach(function (o, i) { o.n = i + 1; });
      this.pending = { kind: 'choose', options: options, until: performance.now() + 30000 };
      UI.showRings(options.map(function (o) { return { n: o.n, getRect: rectOf(o.el) }; }), 30000);
      const list = options.slice(0, 4).map(function (o) { return (o.n) + ', ' + o.label; });
      return this.say(intro + ' ' + list.join('. ') + '. Which one? Say a number or a name, or say cancel.');
    },

    /* ---------- command execution ---------- */
    exec: async function (it, tok, alive) {
      const self = this;
      switch (it.type) {
        case 'empty': return this.say('I didn’t catch anything. Try “help” to hear what I can do.');
        case 'stop': return this.stop(true);
        case 'close': return this.close();
        case '_declined': UI.clearRings(); return this.say('Okay, I won’t do ' + (it.what || 'that') + '.');
        case '_badchoice': return this.say('Please pick a number from 1 to ' + it.max + ', or say cancel.');
        case '_confirmed': return it.run(tok, alive);
        case '_chosen': UI.clearRings(); return it.option.run(tok, alive);
        case 'help':
          return this.say('You can say: “go to” a section, “click” a button, “find” a word, “read this”, or “what is this site”. ' +
            'Say “stop” any time, or press the red STOP button. You can also type.');
        case 'about': return this.cmdAbout();
        case 'read': return this.cmdRead(it, tok, alive);
        case 'find': return this.cmdFind(it, tok, alive);
        case 'step': return this.cmdStep(it, tok, alive);
        case 'go': return this.cmdGo(it, tok, alive);
        case 'click': return this.cmdClick(it, tok, alive);
        case 'scrollto': {
          await this.say(it.where === 'top' ? 'Going to the top.' : 'Going to the bottom.');
          const y = it.where === 'top' ? 0 : document.documentElement.scrollHeight;
          try { window.scrollTo({ top: y, behavior: prefersReduced() ? 'auto' : 'smooth' }); } catch (e) { window.scrollTo(0, y); }
          return;
        }
        case 'scrollby': {
          const d = (it.dir === 'down' ? 1 : -1) * Math.round(window.innerHeight * 0.8);
          try { window.scrollBy({ top: d, behavior: prefersReduced() ? 'auto' : 'smooth' }); } catch (e) { window.scrollBy(0, d); }
          return this.say('Scrolling ' + it.dir + '.');
        }
        case 'history': {
          if (history.length <= 1) return this.say('There’s no earlier page to go back to.');
          store.sset(RESUME_KEY, '1'); history.back(); return this.say('Going back.');
        }
        default: return this.cmdUnknown(it);
      }
    },

    cmdAbout: function () {
      const m = Scanner.scan();
      const h1 = m.headings.find(function (h) { return h.level === 1; });
      const parts = [];
      parts.push('This is ' + (m.title || (h1 && h1.text) || 'this page') + '.');
      if (m.description) parts.push(m.description.replace(/\s+/g, ' ').replace(/\.?$/, '.'));
      else if (h1 && m.title !== h1.text) parts.push('The main heading says: ' + h1.text + '.');
      const secs = uniq(m.headings.filter(function (h) { return h.level === 2; }).map(function (h) { return h.text; })).slice(0, 6);
      if (secs.length) parts.push('The page has ' + (secs.length === 1 ? 'one section' : secs.length + ' sections') + ': ' + andList(secs) + '.');
      if (m.products.length) {
        const vals = m.products.map(function (p) { return p.value; }).filter(Boolean).sort(function (a, b) { return a - b; });
        const cur = (m.products[0].price.match(/[$€£¥]/) || ['$'])[0];
        parts.push('I can see ' + m.products.length + ' product' + (m.products.length > 1 ? 's' : '') + (vals.length ? ', priced from ' + cur + vals[0] + ' to ' + cur + vals[vals.length - 1] : '') + '.');
      }
      const btn = uniq(m.buttons.filter(function (b) { return !b.disabled; }).map(function (b) { return b.text; })).slice(0, 4);
      if (btn.length) parts.push('Buttons include ' + andList(btn.map(function (b) { return '“' + b + '”'; })) + '.');
      return this.say(parts.join(' '));
    },

    cmdRead: async function (it, tok, alive) {
      let root = mainEl(), label = 'what’s on screen';
      let blocks;
      if (it.arg) {
        const cands = goCandidates().filter(function (c) { return c.kind === 'section'; });
        const hits = rank(cands, it.arg, 0.6);
        if (!hits.length) return this.say('I couldn’t find a section called “' + it.arg + '” to read. Say “read this” to read what’s on screen.');
        const el = hits[0].item.el; label = hits[0].item.label;
        await scrollToEl(el, 'top', tok, alive); if (!alive()) return;
        root = el.closest('section, article, div') || el;
        if (root.contains(mainEl()) || root === document.body) root = el.parentElement || el;
        blocks = visibleBlocks(root);
        if (!blocks.length) blocks = [el];
        UI.showRings([{ getRect: rectOf(el) }], 3500);
      } else {
        blocks = visibleBlocks(root).filter(inViewport);
      }
      if (!blocks.length) return this.say('I don’t see any readable text on screen right now. Try scrolling, or say “what is this site”.');
      let text = '';
      for (let i = 0; i < blocks.length && text.length < CONFIG.maxReadChars; i++) {
        let s = clean(blocks[i].innerText); if (!s) continue;
        if (!/[.!?:;]$/.test(s)) s += '.';
        text += s + ' ';
      }
      text = text.trim();
      if (text.length > CONFIG.maxReadChars) text = text.slice(0, CONFIG.maxReadChars).replace(/\s+\S*$/, '') + '…';
      UI.addLine('sys', 'Reading ' + label + '…');
      return this.say(text, { kind: 'bot' });
    },

    cmdFind: async function (it, tok, alive) {
      const q = it.arg;
      let els = textMatches(q);
      let fuzzy = false;
      if (!els.length) {
        const m = Scanner.map;
        const pool = [].concat(
          m.headings.map(function (h) { return { label: h.text, el: h.el }; }),
          m.buttons.map(function (b) { return { label: b.text, el: b.el }; }),
          m.links.map(function (l) { return { label: l.text, el: l.el }; }),
          m.products.map(function (p) { return { label: p.name, el: p.el }; }));
        const hits = rank(pool, q, 0.7).filter(function (h) { return isVisible(h.item.el); });
        const seen = new Set(); els = [];
        hits.forEach(function (h) { if (!seen.has(h.item.el)) { seen.add(h.item.el); els.push(h.item.el); } });
        fuzzy = els.length > 0;
      }
      if (!els.length) {
        const alt = uniq(Scanner.map.headings.map(function (h) { return h.text; })).slice(0, 4);
        this.findState = null;
        return this.say('I couldn’t find “' + q + '” on this page.' + (alt.length ? ' I can see sections like ' + orList(alt) + '. Want me to go to one of those?' : ''));
      }
      this.findState = { q: q, els: els, i: 0 };
      return this.showFind(tok, alive, true, fuzzy);
    },
    showFind: async function (tok, alive, first, fuzzy) {
      const f = this.findState, el = f.els[f.i];
      const shown = f.els.slice(0, 8);
      UI.showRings(shown.map(function (e, i) { return { n: i + 1, getRect: rectOf(e) }; }).filter(function (x, i) { return true; }), CONFIG.highlightMs);
      const ok = await scrollToEl(el, 'center', tok, alive); if (!ok || !alive()) return;
      const ctx = contextOf(el), n = f.els.length;
      const snippet = short(el.innerText || el.textContent, 80);
      let msg;
      if (first) msg = (n === 1 ? 'I found one match' : 'I found ' + n + ' matches') + (fuzzy ? ' that look close to “' + f.q + '”' : ' for “' + f.q + '”') + '. ' +
        'Showing the first' + (ctx ? ', in ' + ctx : '') + ': ' + snippet + (n > 1 ? '. Say “next” for the next one.' : '.');
      else msg = 'Match ' + (f.i + 1) + ' of ' + n + (ctx ? ', in ' + ctx : '') + ': ' + snippet + '.';
      return this.say(msg);
    },
    cmdStep: async function (it, tok, alive) {
      const f = this.findState;
      if (!f || !f.els.length) return this.say('There’s nothing to step through yet. Try “find” and a word first.');
      f.els = f.els.filter(function (e) { return e.isConnected; });
      if (!f.els.length) { this.findState = null; return this.say('Those matches are gone from the page. Try “find” again.'); }
      f.i = (f.i + it.dir + f.els.length) % f.els.length;
      return this.showFind(tok, alive, false, false);
    },

    cmdGo: async function (it, tok, alive) {
      const q = it.arg;
      const cands = goCandidates();
      let hits = rank(cands, q, 0.6);
      // collapse candidates that lead to the same place (nav link + section + heading all say "Pricing")
      const byKey = new Map();
      hits.forEach(function (h) {
        const prev = byKey.get(h.item.key);
        if (!prev || h.score > prev.score || (h.score === prev.score && h.item.kind === 'section' && prev.item.kind !== 'section')) byKey.set(h.item.key, h);
      });
      hits = Array.from(byKey.values()).sort(function (a, b) { return b.score - a.score; });
      // same label + one target contains the other (nav link → <section id>, and that section's own heading) = one place
      const kept = [];
      hits.forEach(function (h) {
        const dup = kept.some(function (k) {
          if (norm(k.item.label) !== norm(h.item.label) && !(k.item.kind === 'section' && h.item.kind === 'section')) return false;
          const a = k.item.el, b = h.item.el;
          return a && b && a.nodeType === 1 && b.nodeType === 1 && (a === b || a.contains(b) || b.contains(a)) && k.item.kind !== 'page' && h.item.kind !== 'page';
        });
        if (!dup) kept.push(h);
      });
      hits = kept;
      if (!hits.length) {
        if (it.soft) {                                   // "open X" / "show X": maybe they meant a button or plain text
          const cc = rank(clickCandidates(), q, 0.7, function (c) { return c.text; });
          if (it.soft === 'open' && cc.length) return this.cmdClick({ type: 'click', arg: q, raw: it.raw }, tok, alive);
          if (textMatches(q).length) return this.cmdFind({ type: 'find', arg: q, raw: it.raw }, tok, alive);
        }
        const alt = rank(cands, q, 0.35).map(function (h) { return h.item.label; });
        const near = uniq(alt).slice(0, 4);
        const fallback = uniq(Scanner.map.nav.map(function (n) { return n.text; }).concat(Scanner.map.headings.filter(function (h) { return h.level === 2; }).map(function (h) { return h.text; }))).slice(0, 5);
        const opts = near.length ? near : fallback;
        return this.say('I couldn’t find a section or page called “' + q + '”.' + (opts.length ? ' Did you mean ' + orList(opts) + '? You can say “go to” and the name.' : ' Try “what is this site” to hear what’s here.'));
      }
      const top = hits[0];
      const close = hits.filter(function (h) { return h.score >= top.score - 0.1; });
      const clear = close.length === 1 || (top.score >= 0.99 && close.filter(function (h) { return h.score >= 0.99; }).length === 1);
      if (!clear) {
        const opts = close.slice(0, 4).map(function (h) {
          return { label: h.item.label + (h.item.kind === 'page' ? ' (another page)' : ''), pick: h.item.label, el: h.item.el.isConnected ? h.item.el : h.item.link,
            run: function (t, a) { return VL.goTo(h.item, t, a); } };
        });
        return this.askChoose('I found ' + close.length + ' places that match “' + q + '”:', opts, tok);
      }
      return this.goTo(top.item, tok, alive);
    },
    goTo: async function (c, tok, alive) {
      if (c.kind === 'page') {
        const href = c.link ? c.link.href : '';
        this.say('Taking you to ' + c.label + '.');
        await sleep(CONFIG.preClickDelayMs * 0.6); if (!alive()) return;
        UI.showRings([{ getRect: rectOf(c.link) }], 1500);
        await sleep(400); if (!alive()) return;
        this.markNavigating();
        this.receipt({ action: 'navigate', label: c.label, status: 'succeeded', verification: 'none', detail: 'page change cannot be verified before unload' });
        this.fireClick(c.link);
        return;
      }
      const el = c.el;
      this.say('Going to ' + c.label + '.');
      const ok = await scrollToEl(el, 'top', tok, alive); if (!ok || !alive()) return;
      UI.showRings([{ getRect: rectOf(el.querySelector('h1,h2,h3,h4') || el) }], CONFIG.highlightMs);
      // read-back: is the target actually near the top of the viewport now?
      const r = el.getBoundingClientRect(), landed = r.top < window.innerHeight * 0.6 && r.bottom > 0;
      this.receipt({ action: 'scroll_to', label: c.label, status: landed ? 'succeeded' : 'unknown', verification: landed ? 'read_back' : 'none' });
      if (!landed) this.say('I scrolled towards “' + c.label + '”, but I can’t confirm it’s in view. You may need to scroll a little.');
    },
    markNavigating: function () {
      if (!CONFIG.resumeAfterNavigation) return;
      store.sset(RESUME_KEY, '1'); setTimeout(function () { store.sset(RESUME_KEY, null); }, 2500);  // cleared if no page change happened
    },

    cmdClick: async function (it, tok, alive) {
      const q = it.arg;
      const all = clickCandidates();
      const scoreOf = function (c) { return Math.max(score(q, c.text), c.ctx ? score(q, c.ctx + ' ' + c.text) : 0, c.ctx ? score(q, c.text + ' ' + c.ctx) : 0); };
      let hits = all.map(function (c) { return { item: c, score: scoreOf(c) }; }).filter(function (h) { return h.score >= 0.6; })
        .sort(function (a, b) { return b.score - a.score; });
      // collapse the same destination reached by several links
      if (!hits.length) {
        const alt = uniq(all.filter(function (c) { return !c.disabled; }).sort(function (a, b) { return scoreOf(b) - scoreOf(a); }).filter(function (c) { return scoreOf(c) >= 0.3; }).map(describe)).slice(0, 4);
        const fb = alt.length ? alt : uniq(all.filter(function (c) { return c.kind === 'button' && !c.disabled; }).map(function (c) { return c.text; })).slice(0, 5);
        return this.say('I couldn’t find a button or link called “' + q + '”.' + (fb.length ? ' What I can see: ' + andList(fb) + '. Which one do you want?' : ' I don’t see any buttons on screen.'));
      }
      const top = hits[0];
      const close = hits.filter(function (h) { return h.score >= top.score - 0.1; });
      if (close.length > 1) {
        const opts = close.slice(0, 5).map(function (h) {
          const c = h.item;
          return { label: describe(c), pick: c.ctx || c.text, el: c.el, run: function (t, a) { return VL.doClick(c, t, a, {}); } };
        });
        return this.askChoose('I found ' + close.length + ' matches for “' + q + '”:', opts, tok);
      }
      return this.doClick(top.item, tok, alive, {});
    },

    /** The full click pipeline: guards → confirm → ring → pause (cancellable) → real events → read-back receipt */
    doClick: async function (c, tok, alive, o) {
      const label = describe(c);
      if (!c.el.isConnected || !isVisible(c.el)) return this.say('“' + label + '” isn’t visible any more, so I didn’t click it.');
      if (isDisabled(c.el)) return this.say('The “' + label + '” button is disabled right now, so I can’t click it.');
      // never touch payment / password forms
      const form = c.el.form || c.el.closest('form');
      if (form && form.querySelector('input[type="password"], input[autocomplete^="cc-"], input[name*="card" i], input[name*="cvv" i]'))
        return this.say('That control belongs to a form with payment or password fields. I won’t touch those — please do it yourself.');
      // sensitive action → explicit yes
      const sensitive = new RegExp('\\b(' + CONFIG.confirmBeforeClick + ')\\b', 'i');
      if (!o.confirmed && sensitive.test(c.text)) {
        UI.showRings([{ getRect: rectOf(c.el) }], 20000);
        this.pending = {
          kind: 'confirm', label: 'clicking “' + c.text + '”', until: performance.now() + 20000,
          run: function (t, a) { return VL.doClick(c, t, a, { confirmed: true }); }
        };
        return this.say('“' + label + '” looks like a purchase or something hard to undo. Do you want me to click it? Say yes or no.');
      }
      // announce + highlight + scroll
      this._acting = true;
      try {
        this.say('Clicking ' + label + '.');
        const ok = await scrollToEl(c.el, 'center', tok, alive); if (!ok || !alive()) return;
        UI.showRings([{ getRect: rectOf(c.el) }], CONFIG.highlightMs);
        // cancellable pause: any real mouse/key input on the page means "the visitor wants control" → abort
        const proceed = await this.pause(CONFIG.preClickDelayMs, alive);
        if (!proceed || !alive()) { UI.clearRings(); this.say('Okay — I stopped before clicking.'); return; }
        if (!c.el.isConnected || !isVisible(c.el) || isDisabled(c.el)) { UI.clearRings(); return this.say('The page changed before I could click “' + label + '”, so I didn’t.'); }

        // ---- read-back baseline ----
        const cartEl = document.querySelector(CONFIG.cartCountSelector);
        const isCartAction = !!cartEl && /\b(cart|bag|basket)\b/i.test(c.text + ' ' + (c.el.getAttribute('aria-label') || ''));
        const readCart = function () { const e = document.querySelector(CONFIG.cartCountSelector); if (!e) return null; const n = parseInt((e.textContent || '').replace(/[^\d-]/g, ''), 10); return isNaN(n) ? null : n; };
        const before = isCartAction ? readCart() : null;
        let mutations = 0; const url0 = location.href;
        const mo = new MutationObserver(function (ms) { ms.forEach(function (m) { if (!(m.target.closest && m.target.closest(SKIP_SEL))) mutations++; }); });
        mo.observe(document.body, { childList: true, subtree: true, attributes: true, characterData: true });

        const href = c.el.tagName === 'A' ? c.el.href : '';
        if (href && !/^#/.test(c.el.getAttribute('href') || '')) this.markNavigating();
        this.fireClick(c.el);

        // ---- read-back: wait for the page to react (poll up to ~1.6s) ----
        let after = before, changed = false;
        const t0 = performance.now();
        while (performance.now() - t0 < 1600) {
          await sleep(100);
          if (isCartAction) { after = readCart(); if (after !== before) { changed = true; break; } }
          else if (mutations > 0 || location.href !== url0) { await sleep(150); break; }
        }
        mo.disconnect();
        UI.clearRings();
        if (!alive()) return;

        if (isCartAction && before != null && after != null) {
          if (after > before) {
            this.receipt({ action: 'click', label: label, status: 'succeeded', verification: 'read_back', before: before, after: after });
            return this.say('Done. I clicked ' + label + ', and the cart count went from ' + before + ' to ' + after + '.', { verified: true });
          }
          this.receipt({ action: 'click', label: label, status: 'unknown', verification: 'none', before: before, after: after });
          return this.say('I clicked ' + label + ', but the cart count didn’t change — still ' + after + ' — so I can’t confirm it was added. You may want to check the cart.');
        }
        if (location.href !== url0) {
          this.receipt({ action: 'click', label: label, status: 'succeeded', verification: 'none', detail: 'url changed' });
          return this.say('I clicked ' + label + ' and the page changed.');
        }
        this.receipt({ action: 'click', label: label, status: 'unknown', verification: 'none', detail: mutations ? 'page updated' : 'no observable change' });
        return this.say(mutations
          ? 'I clicked ' + label + ', and the page updated. I can’t independently confirm what changed.'
          : 'I clicked ' + label + ', but I didn’t see anything change on the page, so I can’t confirm it worked.');
      } finally { this._acting = false; }
    },

    /** wait `ms`, but resolve false immediately if the visitor touches the page (pointer/keyboard) or presses STOP */
    pause: function (ms, alive) {
      const self = this;
      return new Promise(function (resolve) {
        let done = false;
        const evs = ['pointerdown', 'keydown', 'touchstart'];
        const fin = function (v) {
          if (done) return; done = true; clearTimeout(timer); self._interrupt = null;
          evs.forEach(function (e) { document.removeEventListener(e, onInput, true); });
          resolve(v);
        };
        const onInput = function (e) {
          const path = e.composedPath ? e.composedPath() : [];
          if (path.indexOf(UI.host) >= 0 && e.type !== 'keydown') return;     // taps inside the widget are handled by its own buttons
          if (path.indexOf(UI.host) >= 0 && e.target === UI.host) return;
          if (e.type === 'keydown' && path.indexOf(UI.host) >= 0) return;       // typing in the widget's input ≠ interrupting
          fin(false);
        };
        const timer = setTimeout(function () { fin(alive()); }, ms);
        self._interrupt = function () { fin(false); };
        evs.forEach(function (e) { document.addEventListener(e, onInput, true); });
      });
    },

    /** dispatch a REAL event sequence so the site's own handlers / analytics fire */
    fireClick: function (el) {
      const r = el.getBoundingClientRect();
      const x = Math.round(r.left + r.width / 2), y = Math.round(r.top + r.height / 2);
      const base = { bubbles: true, cancelable: true, composed: true, view: window, clientX: x, clientY: y, screenX: x, screenY: y, button: 0 };
      try { el.focus({ preventScroll: true }); } catch (e) {}
      const fire = function (Ctor, type, extra) {
        try { el.dispatchEvent(new Ctor(type, Object.assign({}, base, extra || {}))); } catch (e) { try { el.dispatchEvent(new MouseEvent(type, base)); } catch (x) {} }
      };
      const P = window.PointerEvent || MouseEvent, pe = { pointerId: 1, pointerType: 'mouse', isPrimary: true };
      fire(P, 'pointerover', pe); fire(MouseEvent, 'mouseover');
      fire(P, 'pointerdown', Object.assign({ buttons: 1 }, pe)); fire(MouseEvent, 'mousedown', { buttons: 1 });
      fire(P, 'pointerup', pe); fire(MouseEvent, 'mouseup');
      fire(MouseEvent, 'click', { detail: 1 });
    },

    cmdUnknown: function (it) {
      // a near-miss on a nav label / button is still helpful: offer it instead of failing silently
      const gc = rank(goCandidates(), it.arg, 0.7);
      const cc = rank(clickCandidates(), it.arg, 0.8, function (c) { return c.text; });
      if (gc.length) return this.say('I didn’t catch a command, but I can see “' + gc[0].item.label + '”. Say “go to ' + gc[0].item.label + '” if that’s what you want.');
      if (cc.length) return this.say('I didn’t catch a command, but I can see a “' + cc[0].item.text + '” button. Say “click ' + cc[0].item.text + '” to press it.');
      return this.say('Sorry, I didn’t understand “' + short(it.raw, 60) + '”. I can go to a section, click a button, find a word, read what’s on screen, or tell you what this site is. Say “help” for more.');
    }
  };

  /* =========================================================================
   * 9. PUBLIC API — window.VoiceLayer
   * ========================================================================= */
  window.VoiceLayer = {
    __loaded: true,
    version: VERSION,
    config: CONFIG,
    open: function () { VL.open(false); },
    close: function () { VL.close(); },
    stop: function () { VL.stop(true); },
    say: function (t) { return VL.say(t); },
    /** run a command as if it had been typed: VoiceLayer.run('go to pricing') */
    run: function (t) { UI.addLine('user', t); return VL.run(t); },
    getSiteMap: function () { return Scanner.json(); },
    rescan: function () { Scanner.scan(); return Scanner.json(); },
    get receipts() { return VL.receipts.slice(); },
    get state() { return VL.state; },
    /** debug helpers (CONFIG.debug) — force any visual state without a mic */
    debug: {
      force: function (s) { UI.force(s); VL.refresh(); },
      level: function () { return UI.wave ? UI.wave.lastLevel : 0; },
      hasAnalyser: function () { return !!(UI.wave && UI.wave.analyser); },
      parse: parse
    }
  };

  VL.init();
})();
