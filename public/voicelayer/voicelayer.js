/*!
 * VoiceLayer  (v0.2.0)
 * ---------------------------------------------------------------------------
 * A drop-in voice assistant widget. ONE script tag, no dependencies, no build.
 *
 *   <script src="voicelayer.js" defer></script>
 *
 * What it does
 *   • Floats an orb over the page; tap it to talk (mic NEVER starts on its own).
 *   • Scans the page (headings, nav, buttons, prices, products) into a "site map".
 *   • Understands a small set of voice/typed commands in English and Spanish
 *     (go / click / find / read / about / stop / close).
 *   • Voice engines: the browser's own (Web Speech API, free) or Deepgram (Nova-3 listening +
 *     Aura-2 speaking) through YOUR server, so the API key never reaches the page. Automatic fallback.
 *   • Highlights what it is about to touch, then dispatches REAL DOM events so the site's own
 *     handlers and analytics fire.
 *   • Reports an outcome as "verified" ONLY when it re-reads the page afterwards (read-back);
 *     otherwise it says plainly that it could not confirm the result.
 *   • Visitor is in control: minimize to an edge tab, turn off completely (remembered), bring back
 *     with a link / shortcut / ?voicelayer=on. Owner has a kill switch (config flag or server flag).
 *
 * Rule-based (no LLM), so page text can never be used to "instruct" the assistant.
 * See README.md for limits.
 *
 * File layout (search for the ===== banners):
 *   1 CONFIG   2 UTILS   2b LANGUAGE PACKS   3 SITE SCANNER   4 WAVEFORM   5 VOICE I/O (browser + Deepgram)
 *   6 UI   7 COMMANDS   8 CONTROLLER   9 PUBLIC API
 */
(function () {
  'use strict';
  if (window.VoiceLayer && window.VoiceLayer.__loaded) return; // already installed

  /* =========================================================================
   * 1. CONFIG  — edit these values; no coding needed.
   *    Override from the host page BEFORE the script tag:
   *      <script>window.VoiceLayerConfig = { language: 'es', apiBase: '/api/voice' };</script>
   *    or with data attributes: <script src="voicelayer.js" data-language="es" data-api="/api/voice">
   * ========================================================================= */
  const CONFIG = {
    enabled: true,                       // false = widget does nothing (owner kill switch, static)
    language: 'auto',                    // 'auto' (visitor's saved choice > <html lang> > browser) | 'en' | 'es' | 'en-GB' | 'es-MX' …
    languages: ['en', 'es'],             // languages offered in the switcher ([] or one entry hides the switcher)
    showLangSwitch: true,
    greeting: '',                        // '' = built-in greeting per language; or a string; or { en: '…', es: '…' }
    speakGreeting: false,                // speak the greeting aloud on first open? (captions always show it)
    orbPosition: { corner: 'bottom-right', offsetX: 24, offsetY: 24 }, // corner: bottom-right | bottom-left | top-right | top-left
    rememberPosition: true,              // remember where the visitor dragged the orb (localStorage)
    listenOnOpen: true,                  // tapping the orb opens the panel AND starts the mic (that tap is the consent gesture). false = open only
    resumeAfterNavigation: true,         // after the assistant navigates, re-open the panel (mic stays OFF)

    // ---- GLASS MODE: full-page frosted pane + a glowing circle with radial waves; the assistant speaks first ---------
    mode: 'assistant',                   // 'assistant' (orb + panel, answers when asked) | 'glass' (full-page glass, speaks first after ONE tap)
    glass: {
      autoOpen: true,                    // show the glass (in its "tap to start" state) on load. It never listens or speaks before that tap.
      blur: 14,                          // px of backdrop blur (0 = clear glass)
      tint: 0.22,                        // 0..0.6 darkness of the glass
      hue: 215,                          // accent hue 0..360 (blue family by default)
      dock: 'full',                      // 'full' (cover the page) | 'top' (glass band pinned to the TOP of the page; the site below stays visible and usable)
      height: 0.42,                      // dock:'top' only — band height as a fraction of the viewport (clamped 0.25..0.6)
      lite: 'auto',                      // 'auto' | true | false  - cheaper rendering on weak devices
      visual: 'line',                    // 'line' (orb + travelling dash-wave under it) | 'radial' (bars around the orb) | 'both'
      flow: 'out',                       // line only: 'out' = voice travels from the centre to both ends | 'right' = travels left to right
      passThrough: true                  // clicks/scroll reach the page behind the glass (only the controls capture them)
    },
    // The Companion: what the assistant says first and what it notices. null = plain voice commander.
    // { preset: 'wellness'|'training'|'coaching'|'support'|'none', name: 'Boss', demo: true,
    //   signals: {…}|function|Promise, signalsUrl: '', rules: [], catalog: [], greeting: {en,es}, disclosure: {en,es},
    //   maxInsights: 3, maxAgeHours: 48, strings: {en:{…},es:{…}} }
    companion: null,

    // ---- HOST INTEGRATION (generic; site-specific logic lives in the HOST, not here) -----------------------------
    emit: { intents: true, transcripts: false }, // dispatch 'voicelayer:intent' CustomEvents on window for host analytics.
                                                 // NEVER emits transcripts unless the host opts in explicitly.
    aiAnswer: null,                      // async (question, ctx) => { text } — host-supplied brain for open questions the
                                         // rule-based companion can't answer. Guardrails still apply: the reply is linted
                                         // (no diagnose/treat wording), truncated, and attributed to the host AI.

    // ---- voice engine ------------------------------------------------------------------------------------------
    provider: 'auto',                    // 'auto' = Deepgram when apiBase answers and has a key, else browser | 'browser' | 'deepgram'
    apiBase: '',                         // your server's voice routes, e.g. '/api/voice' ('' = browser voice only)
    speak: true,                         // speak replies out loud (visitor can also mute in the panel)
    speechRate: 1,                       // 0.5 – 2   (browser voice only)
    speechPitch: 1,                      // 0 – 2     (browser voice only)
    voiceName: '',                       // exact name of a preferred browser voice, or '' for automatic
    voiceGender: 'female',               // 'female' | 'male' | 'any' - which browser voice to prefer when several exist (the Deepgram voice is chosen on the SERVER: see VOICELAYER_VOICE_EN / _ES)

    // ---- SKILLS (all OFF by default - the site owner opts in; each can be `true` or an options object) ----------------
    forms: false,                        // change a form field by voice: find field -> read back -> yes/no -> fill -> verify. Never password / payment fields, never submits.
    memory: false,                       // remember the visitor on THIS device, only after they say yes. { ttlDays: 180, maxPages: 8, maxFacts: 10 }
    knowledge: false,                    // answer questions from the site's own text, with the source. { pages: ['/faq'], autoNav: false, facts: [{ q, a, source }], minScore: .55 }

    // ---- visitor control / owner control -----------------------------------------------------------------------
    allowMinimize: true,                 // show the minimize button (orb folds into a small edge tab)
    allowTurnOff: true,                  // show "Turn off voice help" (remembered on this device)
    hotkey: 'Alt+Shift+V',               // keyboard shortcut that toggles the widget on/off ('' = none)
    remoteConfig: true,                  // ask apiBase + '/config' whether the owner switched the widget off (fail-open)

    // ---- proactive hint ------------------------------------------------------------------------------------------
    bubble: true,                        // one small, silent, dismissible hint per browser session
    bubbleDelayMs: 4000,
    bubbleMaxMs: 14000,

    // ---- behaviour -----------------------------------------------------------------------------------------------
    scrollOffset: 84,                    // px kept free at the top when scrolling to a section (sticky headers)
    highlightMs: 7000,                   // how long highlight rings stay visible
    preClickDelayMs: 1000,               // ring is shown this long BEFORE a click so the visitor can see/cancel it
    thinkingMs: 450,                     // minimum time the "thinking" state is shown
    listenIdleTimeoutMs: 90000,          // auto-stop the mic after this long without speech (privacy)
    maxReadChars: 1600,                  // "Read this" speaks at most this much text
    micVisualizer: true,                 // use the real mic level for the listening waveform (Web Audio)

    // Add-to-cart read-back: where the page shows the cart count (first match is used)
    cartCountSelector: '[data-cart-count], #cart-count, .cart-count',
    // EXTRA words (regex source, accents removed) that require a spoken/typed "yes" before clicking, on top of the built-in lists
    confirmBeforeClick: '',

    debug: false,                        // true = shows buttons to force each visual state (no mic needed) + logs
    cssUrl: '',                          // override stylesheet URL ('' = voicelayer.css next to this script)

    // Text overrides per language, e.g. { es: { title: 'Asistente', placeholder: '…' } }  (keys: see PACKS.en.ui)
    text: {}
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
      if (d.api) CONFIG.apiBase = d.api;
      if (d.provider) CONFIG.provider = d.provider;
      if (d.bubble) CONFIG.bubble = d.bubble !== 'false';
      if (d.mode) CONFIG.mode = d.mode;
      if (d.preset || d.name || d.demo) CONFIG.companion = Object.assign({}, CONFIG.companion || {}, d.preset ? { preset: d.preset } : {}, d.name ? { name: d.name } : {}, d.demo ? { demo: d.demo !== 'false' } : {});
    }
  })();
  if (!CONFIG.enabled) return;
  CONFIG.apiBase = String(CONFIG.apiBase || '').replace(/\/+$/, '');
  // opened from disk (file://) a relative API path can't work: use browser voice, make no network calls
  if (location.protocol === 'file:' && !/^https?:/i.test(CONFIG.apiBase)) CONFIG.apiBase = '';

  const VERSION = '0.4.0';
  const STATES = ['idle', 'listening', 'thinking', 'speaking'];
  const log = function () { if (CONFIG.debug) console.log.apply(console, ['[VoiceLayer]'].concat([].slice.call(arguments))); };

  /* =========================================================================
   * 2. UTILS
   * ========================================================================= */
  const sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
  const clamp = function (v, lo, hi) { return Math.max(lo, Math.min(hi, v)); };
  const qsa = function (sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); };
  const store = {
    get: function (k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set: function (k, v) { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch (e) {} },
    sget: function (k) { try { return sessionStorage.getItem(k); } catch (e) { return null; } },
    sset: function (k, v) { try { v == null ? sessionStorage.removeItem(k) : sessionStorage.setItem(k, v); } catch (e) {} }
  };
  const KEYS = { pos: 'voicelayer.orb', speak: 'voicelayer.speak', resume: 'voicelayer.resume', lang: 'voicelayer.lang',
    off: 'voicelayer.off', min: 'voicelayer.min', bubble: 'voicelayer.bubble', gdismiss: 'voicelayer.gdismiss', cdismissed: 'voicelayer.cdismissed', cdone: 'voicelayer.cdone', mem: 'voicelayer.memory', memVisit: 'voicelayer.memvisit' };


  /** (rest of utils) */
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
  /** "1,299.00" → 1299 · "129,00" → 129 · "1.299,00" → 1299 · "$5" → 5  (decimal mark = the last separator, if followed by 1–2 digits) */
  function parseMoney(txt) {
    let t = String(txt).replace(/[^\d.,]/g, '');
    if (!t) return 0;
    const lc = t.lastIndexOf(','), ld = t.lastIndexOf('.'), last = Math.max(lc, ld);
    if (last >= 0 && t.length - last - 1 <= 2 && t.length - last - 1 >= 1) t = t.slice(0, last).replace(/[.,]/g, '') + '.' + t.slice(last + 1);
    else t = t.replace(/[.,]/g, '');
    return parseFloat(t) || 0;
  }
  const SKIP_SEL = '[data-vl-ignore], #voicelayer-root, script, style, noscript, template';
  const PRICE_RE = /(?:[$€£¥]\s?\d[\d,]*(?:\.\d{1,2})?|\d[\d,]*(?:\.\d{1,2})?\s?(?:USD|EUR|GBP|€|£))/;

  /* =========================================================================
   * 2b. LANGUAGE PACKS — every word the assistant says, hears or shows lives here.
   *     Add a language = add one pack (ui strings + messages + grammar). English and Spanish ship built in.
   *     Grammar functions work on norm()-ed text (lowercase, accents and punctuation stripped), so write
   *     Spanish patterns WITHOUT accents: "pagina", "anadir", "envio".
   * ========================================================================= */
  const PACKS = {};

  PACKS.en = {
    code: 'en', name: 'English', short: 'EN', speech: 'en-US', dg: 'en',
    or: 'or', and: 'and',
    stop: new Set('the a an to of on in for please button link section page that this my me and tab menu item option'.split(' ')),
    yes: /^(yes|yeah|yep|yup|sure|ok|okay|confirm|go ahead|do it|proceed|please do|affirmative|correct|right)( please)?$/,
    no: /^(no|nope|nah|none|neither|cancel|never ?mind|nothing|forget it|dont|do not|dont do it|negative)( thanks| thank you)?$/,
    ord: { first: 1, one: 1, '1': 1, second: 2, two: 2, '2': 2, third: 3, three: 3, '3': 3, fourth: 4, four: 4, '4': 4, fifth: 5, five: 5, '5': 5, last: -1 },
    choose: /^(?:i mean |i meant |the |number |option |no\.? |# ?)*(first|second|third|fourth|fifth|last|1|2|3|4|5|one|two|three|four|five)(?: one| option| button| link)?$/,
    stopNow: /^(stop|quiet|cancel|be quiet|stop it|stop talking)$/,
    confirmWords: 'buy|checkout|check out|pay|payment|order|purchase|submit|delete|remove|subscribe|sign ?up|confirm|place order|donate',
    ui: {
      title: 'VoiceLayer', placeholder: 'Type a command…', send: 'Send', stop: 'STOP',
      micIdle: 'Tap to talk', micActive: 'Listening… tap to stop',
      openLabel: 'Open voice assistant', closeLabel: 'Close assistant',
      states: { idle: 'Idle', listening: 'Listening', thinking: 'Thinking', speaking: 'Speaking' },
      mute: 'Mute spoken replies', unmute: 'Unmute spoken replies', stopAll: 'Stop everything',
      minimize: 'Minimize', turnOff: 'Turn off', verified: 'verified by read-back', typeLabel: 'Type a command', convo: 'Conversation',
      lang: 'Language', restoreTab: 'Show voice assistant', micUnavailable: 'Voice input is not supported in this browser',
      micUnavailableShort: 'Voice input unavailable', askMe: 'Ask me', dismiss: 'Dismiss',
      privacyBrowser: 'The microphone turns on only when you tap it and stops when you press STOP or close this panel. ' +
        'Speech recognition is done by your browser’s speech service (in Chrome, Google’s). Nothing is sent to this website.',
      privacyDeepgram: 'The microphone turns on only when you tap it and stops when you press STOP or close this panel. ' +
        'While it is on, your voice is streamed to Deepgram for transcription, and spoken replies are generated by Deepgram. This widget stores no audio.'
    },
    greeting: 'Hi! Tap the mic and ask me about this page. Try “what is this site?”, “click add to cart” or “find headphones”.',
    m: {
      noRec: 'Voice input isn’t supported in this browser, so type below — I’ll still answer out loud.',
      noTTS: 'This browser can’t speak, so I’ll answer in text.',
      noRecSay: 'Voice input isn’t available in this browser. Type your command below and I’ll answer out loud.',
      err: function (code, lang) {
        return ({
          'not-allowed': 'Microphone access was blocked. You can allow it in your browser’s site settings — or just type below and I’ll still answer out loud.',
          'no-mic': 'I can’t find a microphone. You can type your command below instead.',
          'unsupported': 'Voice input isn’t supported in this browser. Type below — I’ll still answer out loud.',
          'network': 'The speech service isn’t reachable right now. You can type your commands instead.',
          'language': 'This browser doesn’t support speech recognition for “' + lang + '”. Type your commands instead.',
          'idle-timeout': 'I turned the microphone off after a while without hearing anything. Tap the mic to talk again.',
          'restart-loop': 'Speech recognition keeps stopping on this browser. You can type your commands instead.'
        })[code] || 'Speech recognition stopped (' + code + '). You can type instead.';
      },
      dgFallback: 'The enhanced voice service isn’t available, so I’m using your browser’s voice instead.',
      stopped: 'Stopped — nothing is running and the microphone is off.',
      empty: 'I didn’t catch anything. Try “help” to hear what I can do.',
      that: 'that',
      declined: function (what) { return 'Okay, I won’t do ' + (what || 'that') + '.'; },
      badChoice: function (max) { return 'Please pick a number from 1 to ' + max + ', or say cancel.'; },
      help: 'You can say: “go to” a section, “click” a button, “find” a word, “read this”, or “what is this site”. ' +
        'Say “stop” any time, or press the red STOP button. You can also type.',
      toTop: 'Going to the top.', toBottom: 'Going to the bottom.',
      scrolling: function (dir) { return 'Scrolling ' + dir + '.'; },
      noHistory: 'There’s no earlier page to go back to.', goingBack: 'Going back.',
      resume: function (title) { return 'Here we are: ' + (title || 'the new page') + '. Tap the mic when you want to keep talking.'; },
      aboutThis: function (t) { return 'This is ' + t + '.'; },
      aboutPage: 'this page',
      aboutHeading: function (h) { return 'The main heading says: ' + h + '.'; },
      aboutSections: function (n, list) { return 'The page has ' + (n === 1 ? 'one section' : n + ' sections') + ': ' + list + '.'; },
      aboutProducts: function (n, from, to) { return 'I can see ' + n + ' product' + (n > 1 ? 's' : '') + (from ? ', priced from ' + from + ' to ' + to : '') + '.'; },
      aboutButtons: function (list) { return 'Buttons include ' + list + '.'; },
      readNoSection: function (a) { return 'I couldn’t find a section called “' + a + '” to read. Say “read this” to read what’s on screen.'; },
      onScreen: 'what’s on screen',
      reading: function (label) { return 'Reading ' + label + '…'; },
      readNothing: 'I don’t see any readable text on screen right now. Try scrolling, or say “what is this site”.',
      findNone: function (q, alt) { return 'I couldn’t find “' + q + '” on this page.' + (alt ? ' I can see sections like ' + alt + '. Want me to go to one of those?' : ''); },
      findFirst: function (n, fuzzy, q, ctx, snip) {
        return (n === 1 ? 'I found one match' : 'I found ' + n + ' matches') + (fuzzy ? ' that look close to “' + q + '”' : ' for “' + q + '”') + '. ' +
          'Showing the first' + (ctx ? ', in ' + ctx : '') + ': ' + snip + (n > 1 ? '. Say “next” for the next one.' : '.');
      },
      findNext: function (i, n, ctx, snip) { return 'Match ' + i + ' of ' + n + (ctx ? ', in ' + ctx : '') + ': ' + snip + '.'; },
      stepNothing: 'There’s nothing to step through yet. Try “find” and a word first.',
      stepGone: 'Those matches are gone from the page. Try “find” again.',
      goNoMatch: function (q, opts) { return 'I couldn’t find a section or page called “' + q + '”.' + (opts ? ' Did you mean ' + opts + '? You can say “go to” and the name.' : ' Try “what is this site” to hear what’s here.'); },
      goChoose: function (n, q) { return 'I found ' + n + ' places that match “' + q + '”:'; },
      anotherPage: ' (another page)',
      taking: function (l) { return 'Taking you to ' + l + '.'; },
      going: function (l) { return 'Going to ' + l + '.'; },
      notInView: function (l) { return 'I scrolled towards “' + l + '”, but I can’t confirm it’s in view. You may need to scroll a little.'; },
      clickNone: function (q, fb) { return 'I couldn’t find a button or link called “' + q + '”.' + (fb ? ' What I can see: ' + fb + '. Which one do you want?' : ' I don’t see any buttons on screen.'); },
      clickChoose: function (n, q) { return 'I found ' + n + ' matches for “' + q + '”:'; },
      chooseList: function (intro, items) { return intro + ' ' + items.join('. ') + '. Which one? Say a number or a name, or say cancel.'; },
      notVisible: function (l) { return '“' + l + '” isn’t visible any more, so I didn’t click it.'; },
      disabled: function (l) { return 'The “' + l + '” button is disabled right now, so I can’t click it.'; },
      paymentForm: 'That control belongs to a form with payment or password fields. I won’t touch those — please do it yourself.',
      clickWhat: function (t) { return 'clicking “' + t + '”'; },
      confirmAsk: function (l) { return '“' + l + '” looks like a purchase or something hard to undo. Do you want me to click it? Say yes or no.'; },
      clicking: function (l) { return 'Clicking ' + l + '.'; },
      stoppedBefore: 'Okay — I stopped before clicking.',
      pageChanged: function (l) { return 'The page changed before I could click “' + l + '”, so I didn’t.'; },
      doneCart: function (l, b, a) { return 'Done. I clicked ' + l + ', and the cart count went from ' + b + ' to ' + a + '.'; },
      cartSame: function (l, a) { return 'I clicked ' + l + ', but the cart count didn’t change — still ' + a + ' — so I can’t confirm it was added. You may want to check the cart.'; },
      urlChanged: function (l) { return 'I clicked ' + l + ' and the page changed.'; },
      updated: function (l) { return 'I clicked ' + l + ', and the page updated. I can’t independently confirm what changed.'; },
      noChange: function (l) { return 'I clicked ' + l + ', but I didn’t see anything change on the page, so I can’t confirm it worked.'; },
      unkGo: function (l) { return 'I didn’t catch a command, but I can see “' + l + '”. Say “go to ' + l + '” if that’s what you want.'; },
      unkClick: function (t) { return 'I didn’t catch a command, but I can see a “' + t + '” button. Say “click ' + t + '” to press it.'; },
      unknown: function (raw) { return 'Sorry, I didn’t understand “' + raw + '”. I can go to a section, click a button, find a word, read what’s on screen, or tell you what this site is. Say “help” for more.'; },
      error: 'Sorry — something went wrong while doing that. Nothing was changed. You can try again or say help.',
      langChanged: 'Language: English.',
      minimizedNote: 'Minimized — tap the little tab to bring me back.',
      offNote: function (hot, hasLink) { return 'Voice help is off. To bring it back press ' + hot + (hasLink ? ' or use the “Voice help” link on the page.' : '.'); },
      bubble: function (c) {
        if (c.product && c.nav) return 'Need a hand? Try “find ' + c.product + '” or “go to ' + c.nav + '”.';
        if (c.nav) return 'Need a hand? Try “go to ' + c.nav + '” or “what is this site?”.';
        return 'Need a hand? Ask me about this page — I can find things and read them out.';
      },
      dir: { down: 'down', up: 'up' },
      showWord: 'show'
    }
  };

  PACKS.es = {
    code: 'es', name: 'Español', short: 'ES', speech: 'es-ES', dg: 'es',
    or: 'o', and: 'y',
    stop: new Set('el la los las un una unos unas de del al a en por para con boton enlace seccion pagina ese esa esto mi me y o menu opcion que lo'.split(' ')),
    yes: /^(si|claro|vale|ok|okay|de acuerdo|adelante|confirmo|confirmar|hazlo|procede|correcto|por supuesto|dale|sip|afirmativo)( por favor)?$/,
    no: /^(no|nope|ninguno|ninguna|cancela|cancelar|olvidalo|dejalo|deja|mejor no|nada|negativo|no lo hagas)( gracias)?$/,
    ord: { primero: 1, primera: 1, uno: 1, una: 1, '1': 1, segundo: 2, segunda: 2, dos: 2, '2': 2, tercero: 3, tercera: 3, tres: 3, '3': 3, cuarto: 4, cuarta: 4, cuatro: 4, '4': 4, quinto: 5, quinta: 5, cinco: 5, '5': 5, ultimo: -1, ultima: -1 },
    choose: /^(?:me refiero a |quiero |prefiero |el |la |numero |opcion |# ?|no )*(primero|primera|segundo|segunda|tercero|tercera|cuarto|cuarta|quinto|quinta|ultimo|ultima|1|2|3|4|5|uno|una|dos|tres|cuatro|cinco)(?: opcion| boton| enlace)?$/,
    stopNow: /^(para|parar|detente|calla|callate|silencio|cancela|basta|stop|para ya)$/,
    confirmWords: 'comprar|compra|pagar|pago|pedido|realizar pedido|finalizar compra|finalizar|tramitar|suscribir|suscribirse|suscribete|enviar|eliminar|borrar|quitar|confirmar|donar|donacion',
    ui: {
      title: 'VoiceLayer', placeholder: 'Escribe una orden…', send: 'Enviar', stop: 'STOP',
      micIdle: 'Toca para hablar', micActive: 'Escuchando… toca para parar',
      openLabel: 'Abrir asistente de voz', closeLabel: 'Cerrar asistente',
      states: { idle: 'En espera', listening: 'Escuchando', thinking: 'Pensando', speaking: 'Hablando' },
      mute: 'Silenciar respuestas habladas', unmute: 'Activar respuestas habladas', stopAll: 'Detener todo',
      minimize: 'Minimizar', turnOff: 'Apagar', verified: 'verificado por relectura', typeLabel: 'Escribe una orden', convo: 'Conversación',
      lang: 'Idioma', restoreTab: 'Mostrar asistente de voz', micUnavailable: 'La entrada de voz no está disponible en este navegador',
      micUnavailableShort: 'Entrada de voz no disponible', askMe: 'Pregúntame', dismiss: 'Cerrar',
      privacyBrowser: 'El micrófono solo se enciende cuando lo tocas y se apaga al pulsar STOP o al cerrar este panel. ' +
        'El reconocimiento de voz lo hace el servicio de voz de tu navegador (en Chrome, el de Google). No se envía nada a este sitio web.',
      privacyDeepgram: 'El micrófono solo se enciende cuando lo tocas y se apaga al pulsar STOP o al cerrar este panel. ' +
        'Mientras está encendido, tu voz se envía a Deepgram para transcribirla, y las respuestas habladas las genera Deepgram. Este widget no guarda audio.'
    },
    greeting: '¡Hola! Toca el micrófono y pregúntame por esta página. Prueba “¿qué es este sitio?”, “haz clic en añadir al carrito” o “busca auriculares”.',
    m: {
      noRec: 'Este navegador no admite entrada de voz; escribe abajo y te responderé en voz alta.',
      noTTS: 'Este navegador no puede hablar, así que responderé por escrito.',
      noRecSay: 'La entrada de voz no está disponible en este navegador. Escribe tu orden abajo y te responderé en voz alta.',
      err: function (code, lang) {
        return ({
          'not-allowed': 'Se bloqueó el acceso al micrófono. Puedes permitirlo en los ajustes del sitio de tu navegador, o escribir abajo y te responderé en voz alta.',
          'no-mic': 'No encuentro ningún micrófono. Puedes escribir tu orden abajo.',
          'unsupported': 'Este navegador no admite entrada de voz. Escribe abajo; te responderé en voz alta.',
          'network': 'El servicio de voz no responde ahora mismo. Puedes escribir tus órdenes.',
          'language': 'Este navegador no admite el reconocimiento de voz para “' + lang + '”. Escribe tus órdenes.',
          'idle-timeout': 'Apagué el micrófono tras un rato sin oír nada. Toca el micrófono para hablar de nuevo.',
          'restart-loop': 'El reconocimiento de voz se sigue interrumpiendo en este navegador. Puedes escribir tus órdenes.'
        })[code] || 'El reconocimiento de voz se detuvo (' + code + '). Puedes escribir.';
      },
      dgFallback: 'El servicio de voz mejorado no está disponible; uso la voz de tu navegador.',
      stopped: 'Detenido: no hay nada en marcha y el micrófono está apagado.',
      empty: 'No he oído nada. Prueba “ayuda” para saber qué puedo hacer.',
      that: 'eso',
      declined: function (what) { return 'Vale, no haré ' + (what || 'eso') + '.'; },
      badChoice: function (max) { return 'Elige un número del 1 al ' + max + ', o di cancelar.'; },
      help: 'Puedes decir: “ve a” una sección, “haz clic en” un botón, “busca” una palabra, “lee esto” o “qué es este sitio”. ' +
        'Di “para” en cualquier momento, o pulsa el botón rojo STOP. También puedes escribir.',
      toTop: 'Voy al principio.', toBottom: 'Voy al final.',
      scrolling: function (dir) { return dir === 'abajo' ? 'Bajando.' : 'Subiendo.'; },
      noHistory: 'No hay una página anterior a la que volver.', goingBack: 'Volviendo.',
      resume: function (title) { return 'Aquí estamos: ' + (title || 'la nueva página') + '. Toca el micrófono cuando quieras seguir hablando.'; },
      aboutThis: function (t) { return 'Esto es ' + t + '.'; },
      aboutPage: 'esta página',
      aboutHeading: function (h) { return 'El título principal dice: ' + h + '.'; },
      aboutSections: function (n, list) { return 'La página tiene ' + (n === 1 ? 'una sección' : n + ' secciones') + ': ' + list + '.'; },
      aboutProducts: function (n, from, to) { return 'Veo ' + n + ' producto' + (n > 1 ? 's' : '') + (from ? ', con precios desde ' + from + ' hasta ' + to : '') + '.'; },
      aboutButtons: function (list) { return 'Hay botones como ' + list + '.'; },
      readNoSection: function (a) { return 'No encontré ninguna sección llamada “' + a + '” para leer. Di “lee esto” para leer lo que hay en pantalla.'; },
      onScreen: 'lo que hay en pantalla',
      reading: function (label) { return 'Leyendo ' + label + '…'; },
      readNothing: 'No veo texto legible en pantalla ahora mismo. Prueba a desplazarte, o di “qué es este sitio”.',
      findNone: function (q, alt) { return 'No encontré “' + q + '” en esta página.' + (alt ? ' Veo secciones como ' + alt + '. ¿Quieres que vaya a alguna?' : ''); },
      findFirst: function (n, fuzzy, q, ctx, snip) {
        return (n === 1 ? 'Encontré una coincidencia' : 'Encontré ' + n + ' coincidencias') + (fuzzy ? ' parecidas a “' + q + '”' : ' para “' + q + '”') + '. ' +
          'Muestro la primera' + (ctx ? ', en ' + ctx : '') + ': ' + snip + (n > 1 ? '. Di “siguiente” para ver la siguiente.' : '.');
      },
      findNext: function (i, n, ctx, snip) { return 'Coincidencia ' + i + ' de ' + n + (ctx ? ', en ' + ctx : '') + ': ' + snip + '.'; },
      stepNothing: 'Todavía no hay nada que recorrer. Prueba primero “busca” y una palabra.',
      stepGone: 'Esas coincidencias ya no están en la página. Prueba “busca” otra vez.',
      goNoMatch: function (q, opts) { return 'No encontré ninguna sección ni página llamada “' + q + '”.' + (opts ? ' ¿Querías decir ' + opts + '? Puedes decir “ve a” y el nombre.' : ' Prueba “qué es este sitio” para saber qué hay aquí.'); },
      goChoose: function (n, q) { return 'Encontré ' + n + ' lugares que coinciden con “' + q + '”:'; },
      anotherPage: ' (otra página)',
      taking: function (l) { return 'Te llevo a ' + l + '.'; },
      going: function (l) { return 'Voy a ' + l + '.'; },
      notInView: function (l) { return 'Me desplacé hacia “' + l + '”, pero no puedo confirmar que esté a la vista. Quizá tengas que desplazarte un poco.'; },
      clickNone: function (q, fb) { return 'No encontré ningún botón ni enlace llamado “' + q + '”.' + (fb ? ' Esto es lo que veo: ' + fb + '. ¿Cuál quieres?' : ' No veo ningún botón en pantalla.'); },
      clickChoose: function (n, q) { return 'Encontré ' + n + ' coincidencias para “' + q + '”:'; },
      chooseList: function (intro, items) { return intro + ' ' + items.join('. ') + '. ¿Cuál? Di un número o un nombre, o di cancelar.'; },
      notVisible: function (l) { return '“' + l + '” ya no está visible, así que no hice clic.'; },
      disabled: function (l) { return 'El botón “' + l + '” está desactivado ahora mismo, así que no puedo pulsarlo.'; },
      paymentForm: 'Ese control pertenece a un formulario con campos de pago o contraseña. No los toco: hazlo tú, por favor.',
      clickWhat: function (t) { return 'hacer clic en “' + t + '”'; },
      confirmAsk: function (l) { return '“' + l + '” parece una compra o algo difícil de deshacer. ¿Quieres que haga clic? Di sí o no.'; },
      clicking: function (l) { return 'Haciendo clic en ' + l + '.'; },
      stoppedBefore: 'Vale, me detuve antes de hacer clic.',
      pageChanged: function (l) { return 'La página cambió antes de que pudiera hacer clic en “' + l + '”, así que no lo hice.'; },
      doneCart: function (l, b, a) { return 'Hecho. Hice clic en ' + l + ' y el carrito pasó de ' + b + ' a ' + a + '.'; },
      cartSame: function (l, a) { return 'Hice clic en ' + l + ', pero el contador del carrito no cambió (sigue en ' + a + '), así que no puedo confirmar que se añadiera. Conviene que revises el carrito.'; },
      urlChanged: function (l) { return 'Hice clic en ' + l + ' y la página cambió.'; },
      updated: function (l) { return 'Hice clic en ' + l + ' y la página se actualizó. No puedo confirmar por mi cuenta qué cambió.'; },
      noChange: function (l) { return 'Hice clic en ' + l + ', pero no vi que cambiara nada en la página, así que no puedo confirmar que funcionara.'; },
      unkGo: function (l) { return 'No entendí la orden, pero veo “' + l + '”. Di “ve a ' + l + '” si es lo que quieres.'; },
      unkClick: function (t) { return 'No entendí la orden, pero veo un botón “' + t + '”. Di “haz clic en ' + t + '” para pulsarlo.'; },
      unknown: function (raw) { return 'Lo siento, no entendí “' + raw + '”. Puedo ir a una sección, pulsar un botón, buscar una palabra, leer lo que hay en pantalla o decirte qué es este sitio. Di “ayuda” para más.'; },
      error: 'Perdona, algo falló al hacerlo. No se cambió nada. Puedes intentarlo otra vez o decir ayuda.',
      langChanged: 'Idioma: español.',
      minimizedNote: 'Minimizado: toca la pestaña para volver a llamarme.',
      offNote: function (hot, hasLink) { return 'La ayuda por voz está apagada. Para volver a activarla pulsa ' + hot + (hasLink ? ' o usa el enlace “Ayuda por voz” de la página.' : '.'); },
      bubble: function (c) {
        if (c.product && c.nav) return '¿Necesitas ayuda? Prueba “busca ' + c.product + '” o “ve a ' + c.nav + '”.';
        if (c.nav) return '¿Necesitas ayuda? Prueba “ve a ' + c.nav + '” o “¿qué es este sitio?”.';
        return '¿Necesitas ayuda? Pregúntame por esta página: puedo buscar cosas y leértelas en voz alta.';
      },
      dir: { down: 'abajo', up: 'arriba' },
      showWord: 'muestra'
    }
  };

  const SUPPORTED = Object.keys(PACKS);
  let LANG = 'en';                 // current language code
  let I = PACKS.en;                // current pack
  let M = I.m;                     // current messages
  let STOPWORDS = I.stop;          // used by score()
  let SPEECH_LANG = I.speech;      // BCP-47 passed to recognition + synthesis

  /** pick the language: visitor's saved choice > owner config > <html lang> > browser language > English */
  function resolveLang() {
    const pick = function (c) { c = String(c || '').toLowerCase().replace('_', '-'); const b = c.split('-')[0]; return CONFIG.languages.indexOf(b) >= 0 && PACKS[b] ? { code: b, full: c } : null; };
    const saved = store.get('voicelayer.lang');
    return pick(saved) || (CONFIG.language && CONFIG.language !== 'auto' ? pick(CONFIG.language) : null) ||
      pick(document.documentElement.lang) || pick(navigator.language) || { code: 'en', full: 'en-US' };
  }
  function setLang(code, full, persist) {
    if (!PACKS[code]) return false;
    LANG = code; I = PACKS[code]; M = I.m; STOPWORDS = I.stop;
    SPEECH_LANG = (full && full.indexOf('-') > 0 && full.split('-')[0] === code) ? full.replace(/-(\w+)$/, function (a, r) { return '-' + r.toUpperCase(); }) : I.speech;
    if (persist) store.set('voicelayer.lang', code);
    return true;
  }
  /** owner text overrides: CONFIG.text = { en: {…ui keys}, es: {…} }, CONFIG.greeting = 'text' | { en, es } */
  function UIs() {
    const o = (CONFIG.text && CONFIG.text[LANG]) || {};
    return Object.assign({}, I.ui, o, { states: Object.assign({}, I.ui.states, o.states || {}) });
  }
  function greetingText() {
    const g = CONFIG.greeting;
    if (g && typeof g === 'object') return g[LANG] || I.greeting;
    return g || I.greeting;
  }
  function orList(arr) { return arr.length < 2 ? arr.join('') : arr.slice(0, -1).join(', ') + ' ' + I.or + ' ' + arr[arr.length - 1]; }
  function andList(arr) { return arr.length < 2 ? arr.join('') : arr.slice(0, -1).join(', ') + ' ' + I.and + ' ' + arr[arr.length - 1]; }

  /* =========================================================================
   * 2c. COMPANION — what the glass assistant says FIRST and what it notices.
   *     Intent-agnostic: a preset (wellness / training / coaching / support / none) is just data + rules.
   *     Rule-based on purpose (no LLM): every sentence traces back to ONE data point and ONE rule you can audit.
   *     Hard guardrails (not configurable):
   *       • statements of data, never diagnoses or "you need to take X"  (text linter drops offending rules)
   *       • stale data is never presented as current
   *       • products only from owner-APPROVED catalog entries, always with a disclosure + "why am I seeing this"
   *       • prescription items are never sold or recommended: they route to the user's provider
   *       • emergency phrases get an immediate safety message, nothing else
   *       • nothing health-related is stored by the widget; events carry rule ids, never raw values
   * ========================================================================= */
  PACKS.en.cp = {
    part: { morning: 'Good morning', afternoon: 'Good afternoon', evening: 'Good evening', night: 'Hi' },
    hello: function (part, name) { return part + (name ? ', ' + name : '') + '.'; },
    demoNote: 'Quick note: this is demo data, not yours.',
    moodQ: { wellness: 'How are you feeling today?', training: 'How is your body feeling today? Ready to move?', coaching: 'How are you showing up today?', support: 'How can I help you today?', none: 'How are you doing?' },
    moodAck: { good: 'Love to hear it.', neutral: 'Thanks for telling me.', low: 'Thanks for being honest. I’ll keep this short and easy.', unknown: 'Thanks.' },
    moodExtra: { sore: ' I’ll remember the soreness.', sick: ' I hope you feel better soon.' },
    intro: function (n) { return n ? 'I have ' + n + (n > 1 ? ' things' : ' thing') + ' to share from your data. Here’s the first.' : 'Nothing needs your attention right now.'; },
    none: 'Nothing needs your attention right now. Ask me anything, or tap the circle to pause.',
    noFresh: 'I don’t have fresh data to go on today, so I won’t guess.',
    hint: 'Say “next” to continue, or “why” to hear where that comes from.',
    ending: 'That’s everything for now. You can keep talking to me, or tap the circle to pause.',
    back: function (name) { return 'Welcome back' + (name ? ', ' + name : '') + '. Say “update” for your summary.'; },
    plainGreet: 'Hi! I’m listening. Try “what is this site?”, or say “help”.',
    disclosure: 'This is a product suggestion, not medical advice.',
    offer: function (item, disc) { return 'If it helps, there’s ' + item + ' in the approved catalog. ' + disc + ' Want to see it? Say yes or no.'; },
    offerYes: function (item) { return 'Okay — here’s ' + item + '.'; },
    offerNo: 'No problem.',
    rxRoute: function (provider) { return 'Anything like that has to come from your own provider' + (provider ? ', ' + provider : '') + '. I can’t sell or recommend prescription items.'; },
    optOut: 'Okay, no more product suggestions.',
    why: function (w, because) { return 'You’re seeing this because ' + (because || 'a rule matched your data') + (w.label ? ' (' + w.label + (w.date ? ', ' + w.date : '') + (w.source ? ', source: ' + w.source : '') + ')' : '') + '. I only state what the data says; I don’t diagnose.'; },
    whyOffer: 'You’re seeing this because of the reading I just mentioned. The site owner approved this catalog; I never pick products on my own, and you can say “no suggestions” to turn them off.',
    nothingToSay: 'There’s nothing to explain yet. Say “update” and I’ll go through your data.',
    crisis: 'I’m an automated assistant and I can’t help with this. If you might be in danger, please call your local emergency number now — 911 in the US, 112 in Europe — or contact a crisis line, and tell someone near you.',
    today: 'today', yesterday: 'yesterday', daysAgo: function (n) { return n + ' days ago'; },
    yourData: 'your connected data',
    prevPart: function (prev, unit) { return ', versus ' + prev + (unit ? ' ' + unit : '') + ' before'; },
    dueAt: function (due) { return due ? ' at ' + due : ''; },
    // grammar (matched on norm(text): lowercase, no accents/punctuation)
    next: /^(next|continue|go on|go ahead|keep going|more|okay next|ok next|next one|carry on|and then)$/,
    skip: /^(skip|skip it|not now|later|pass|move on|maybe later)$/,
    whyRe: /^(why|why is that|why am i seeing this|why am i seeing that|where does that come from|where is that from|how do you know|explain|explain that|what do you mean|source)$/,
    repeat: /^(repeat|say that again|again|repeat that|come again|what was that|pardon)$/,
    optRe: /\b(no|stop|dont|do not) (more )?(product )?(suggestions|recommendations|offers|ads)\b|\bstop suggesting\b|\bdont suggest\b/,
    update: /^(update|my update|give me my update|what do you have|what did you find|how am i doing|any news|whats new|what is new|anything new|status|check in|checkin|summary)$/,
    crisisRe: /\b(suicid\w*|kill myself|end my life|want to die|hurt myself|self ?harm|chest pain|cant breathe|can not breathe|heart attack|overdos\w*|having a stroke|bleeding heavily)\b/,
    moodNotBad: /\bnot bad\b/,
    moodLow: /\b(not (so |very |too )?(good|great|well)|bad|terrible|awful|rough|tired|exhausted|sleepy|drained|low|sad|down|stressed|stress|anxious|anxiety|overwhelmed|burnt out|burned out|sore|achy|aching|hurt|sick|unwell|worn out|heavy|meh)\b/,
    moodGood: /\b(great|good|well|awesome|amazing|happy|energi[sz]ed|strong|ready|pumped|excellent|fantastic|better|rested|motivated|wonderful)\b/,
    moodNeutral: /\b(ok|okay|alright|so so|fine|average|normal|decent)\b/,
    tagSore: /\b(sore|achy|aching|stiff|hurt)\b/, tagSick: /\b(sick|unwell|ill|flu|cold)\b/
  };
  PACKS.es.cp = {
    part: { morning: 'Buenos días', afternoon: 'Buenas tardes', evening: 'Buenas noches', night: 'Hola' },
    hello: function (part, name) { return part + (name ? ', ' + name : '') + '.'; },
    demoNote: 'Aviso: son datos de demostración, no los tuyos.',
    moodQ: { wellness: '¿Cómo te sientes hoy?', training: '¿Cómo está tu cuerpo hoy? ¿Listo para moverte?', coaching: '¿Cómo llegas hoy?', support: '¿En qué puedo ayudarte hoy?', none: '¿Cómo estás?' },
    moodAck: { good: 'Me alegra oírlo.', neutral: 'Gracias por contármelo.', low: 'Gracias por ser sincero. Lo haré breve y sencillo.', unknown: 'Gracias.' },
    moodExtra: { sore: ' Tendré en cuenta las molestias.', sick: ' Espero que te mejores pronto.' },
    intro: function (n) { return n ? 'Tengo ' + n + (n > 1 ? ' cosas' : ' cosa') + ' que contarte con tus datos. Esta es la primera.' : 'Nada requiere tu atención ahora mismo.'; },
    none: 'Nada requiere tu atención ahora mismo. Pregúntame lo que quieras, o toca el círculo para pausar.',
    noFresh: 'No tengo datos recientes para hoy, así que no voy a adivinar.',
    hint: 'Di “siguiente” para continuar, o “por qué” para saber de dónde sale.',
    ending: 'Eso es todo por ahora. Puedes seguir hablando conmigo, o tocar el círculo para pausar.',
    back: function (name) { return 'Bienvenido de nuevo' + (name ? ', ' + name : '') + '. Di “resumen” para tu actualización.'; },
    plainGreet: '¡Hola! Te escucho. Prueba “¿qué es este sitio?”, o di “ayuda”.',
    disclosure: 'Es una sugerencia de producto, no un consejo médico.',
    offer: function (item, disc) { return 'Si te sirve, en el catálogo aprobado hay ' + item + '. ' + disc + ' ¿Quieres verlo? Di sí o no.'; },
    offerYes: function (item) { return 'Vale, aquí tienes ' + item + '.'; },
    offerNo: 'Sin problema.',
    rxRoute: function (provider) { return 'Algo así tiene que venir de tu propio profesional' + (provider ? ', ' + provider : '') + '. No puedo vender ni recomendar productos con receta.'; },
    optOut: 'Vale, no más sugerencias de productos.',
    why: function (w, because) { return 'Lo ves porque ' + (because || 'una regla coincidió con tus datos') + (w.label ? ' (' + w.label + (w.date ? ', ' + w.date : '') + (w.source ? ', fuente: ' + w.source : '') + ')' : '') + '. Solo digo lo que dicen los datos; no diagnostico.'; },
    whyOffer: 'Lo ves por la lectura que acabo de mencionar. El dueño del sitio aprobó este catálogo; yo nunca elijo productos por mi cuenta, y puedes decir “sin sugerencias” para desactivarlas.',
    nothingToSay: 'Todavía no hay nada que explicar. Di “resumen” y repaso tus datos.',
    crisis: 'Soy un asistente automático y no puedo ayudarte con esto. Si puedes estar en peligro, llama ahora a tu número local de emergencias — 112 en Europa, 911 en EE. UU. y otros países — o a una línea de crisis, y díselo a alguien cercano.',
    today: 'hoy', yesterday: 'ayer', daysAgo: function (n) { return 'hace ' + n + ' días'; },
    yourData: 'tus datos conectados',
    prevPart: function (prev, unit) { return ', frente a ' + prev + (unit ? ' ' + unit : '') + ' antes'; },
    dueAt: function (due) { return due ? ' a las ' + due : ''; },
    next: /^(siguiente|continua|continuar|sigue|adelante|mas|el siguiente|otro|vale siguiente|ok siguiente)$/,
    skip: /^(salta|saltar|omitir|omite|ahora no|luego|despues|mas tarde|paso|pasa|sigamos)$/,
    whyRe: /^(por que|por que me lo dices|por que veo esto|por que veo eso|de donde sale|de donde sale eso|como lo sabes|explicame|explica|explicalo|fuente|que quieres decir)$/,
    repeat: /^(repite|repetir|repitelo|otra vez|dilo otra vez|que dijiste|perdon|repite eso)$/,
    optRe: /\b(sin|no mas|no quiero|deja de|no me) (sugerencias|sugerir|sugieras|recomendaciones|recomendar|ofertas|anuncios)\b|\bno sugieras\b/,
    update: /^(resumen|mi resumen|dame mi resumen|que tienes|que encontraste|como voy|alguna novedad|novedades|que hay de nuevo|estado|chequeo|revision|actualizacion|actualizame)$/,
    crisisRe: /\b(suicid\w*|quitarme la vida|matarme|quiero morir\w*|me quiero morir|hacerme dano|autolesion\w*|dolor (en el|de) pecho|no puedo respirar|infarto|sobredosis|derrame cerebral|desmayo|desmayando)\b/,
    moodNotBad: /\bno (esta |estoy )?mal\b/,
    moodLow: /\b(mal|fatal|horrible|cansad[oa]|agotad[oa]|sueno|bajo|baja|triste|estresad[oa]|estres|ansios[oa]|ansiedad|agobiad[oa]|dolorid[oa]|adolorid[oa]|dolor|enferm[oa]|pesad[oa]|no muy bien|no tan bien)\b/,
    moodGood: /\b(genial|bien|muy bien|excelente|fantastic[oa]|content[oa]|feliz|fuerte|list[oa]|motivad[oa]|descansad[oa]|mejor|estupendo|de maravilla|increible|con energia)\b/,
    moodNeutral: /\b(normal|regular|asi asi|tirando|ok|okay|aceptable|mas o menos|ni bien ni mal)\b/,
    tagSore: /\b(dolorid[oa]|adolorid[oa]|agujetas|rigid[oa]|dolor muscular)\b/, tagSick: /\b(enferm[oa]|gripe|resfriad[oa]|malestar)\b/
  };
  // glass-mode UI strings (merged into each language pack's ui; owners can override via CONFIG.text)
  Object.assign(PACKS.en.ui, {
    gTap: 'Tap to start', gTapSub: 'Tap the circle. I’ll speak first, then listen. The mic turns on when you tap.',
    gMicOn: 'Mic on', gMicOff: 'Mic off', gClose: 'Close', gDemo: 'DEMO DATA', gWhy: 'Why am I seeing this?', gShow: 'Show me', gNotNow: 'Not now',
    gNext: 'Next', gSuggest: 'Suggestion', gGlassLabel: 'Voice assistant', gCircleLabel: 'Assistant circle: tap to start, pause or interrupt',
    gSource: 'Source', gOpenLabel: 'Open voice assistant', gProvider: 'Ask your provider', gTapMic: 'Tap the circle to talk', gKindData: 'From your data', gKindReminder: 'Reminder', gKindPraise: 'Nice work', gBecause: 'Because', gTypeHere: 'Or type here…', gPause: 'Pause assistant', gOffTxt: 'Turn off voice assistant'
  });
  Object.assign(PACKS.es.ui, {
    gTap: 'Toca para empezar', gTapSub: 'Toca el círculo. Hablo yo primero y luego escucho. El micrófono se enciende cuando tocas.',
    gMicOn: 'Micrófono activo', gMicOff: 'Micrófono apagado', gClose: 'Cerrar', gDemo: 'DATOS DE DEMO', gWhy: '¿Por qué veo esto?', gShow: 'Muéstramelo', gNotNow: 'Ahora no',
    gNext: 'Siguiente', gSuggest: 'Sugerencia', gGlassLabel: 'Asistente de voz', gCircleLabel: 'Círculo del asistente: toca para empezar, pausar o interrumpir',
    gSource: 'Fuente', gOpenLabel: 'Abrir asistente de voz', gProvider: 'Consulta con tu profesional', gTapMic: 'Toca el círculo para hablar', gKindData: 'De tus datos', gKindReminder: 'Recordatorio', gKindPraise: 'Buen trabajo', gBecause: 'Porque', gTypeHere: 'O escribe aquí…', gPause: 'Pausar asistente', gOffTxt: 'Apagar asistente de voz'
  });

  Object.assign(PACKS.en.cp, {
    cmdMute: /^(mute|mute (yourself|the voice|the sound|voice))$/, cmdUnmute: /^(unmute|unmute (yourself|the voice|the sound|voice)|speak again|talk again|voice on)$/,
    cmdOff: /^(turn (it |this |the assistant |the voice assistant |voice help )?off|switch (it )?off|disable (the )?(voice )?assistant|shut down|turn off voice help)$/,
    cmdMin: /^(minimi[sz]e|minimi[sz]e (it|this|the assistant)|make it small)$/,
    cmdSleep: /^(pause|pause (the )?assistant|go to sleep|sleep|take a break|that s all|thats all|i m done|im done)$/,
    cmdLang: /^(?:speak |switch to |change (?:the language )?to |in )?(spanish|english)$/, langMap: { spanish: 'es', english: 'en' },
    act: { next: 'next', why: 'why', yes: 'yes', no: 'no' },
    ackMute: 'Voice muted. I’ll keep showing captions.', ackUnmute: 'Voice is back on.', ackSleep: 'Pausing. Tap the circle whenever you want me.'
  });
  Object.assign(PACKS.es.cp, {
    cmdMute: /^(silencia|silenciar|silencia (la voz|el sonido)|enmudece|sin voz)$/, cmdUnmute: /^(activa (la )?voz|quita (el )?silencio|habla otra vez|desilencia|voz activada)$/,
    cmdOff: /^(apagate|apaga|apagar|apaga (el )?asistente|apaga (la )?ayuda de voz|desactiva (el )?asistente|apaga todo)$/,
    cmdMin: /^(minimiza|minimizar|hazte pequeno|minimiza (el )?asistente)$/,
    cmdSleep: /^(pausa|pausar|pausa (el )?asistente|a dormir|descansa|descansar|eso es todo|ya esta|ya termine)$/,
    cmdLang: /^(?:habla |hablame |cambia a |en )?(ingles|espanol)$/, langMap: { ingles: 'en', espanol: 'es' },
    act: { next: 'siguiente', why: 'por qué', yes: 'sí', no: 'no' },
    ackMute: 'Voz silenciada. Seguiré mostrando subtítulos.', ackUnmute: 'La voz está de nuevo activa.', ackSleep: 'Pausando. Toca el círculo cuando me quieras.'
  });


  /* ---- skills strings (forms / memory / knowledge) ---- */
  PACKS.en.sk = {
    f: {
      noFields: 'I don’t see any form fields on this page.',
      noField: function (q, list) { return 'I couldn’t find a field called “' + q + '” on this page.' + (list ? ' I can see: ' + list + '.' : ''); },
      which: function (n, q) { return 'I found ' + n + ' fields that could be “' + q + '”:'; },
      blocked: function (l) { return 'I won’t fill “' + l + '” by voice. It looks like a password, payment or other sensitive field. Please type it yourself.'; },
      readonly: function (l) { return '“' + l + '” is read-only or disabled, so I can’t change it.'; },
      unsupported: function (l, k) { return '“' + l + '” is a ' + k + ' control. I can’t set that one by voice, please use it yourself.'; },
      invalid: function (l, why) { return 'That doesn’t look like a valid ' + why + ' for “' + l + '”, so I changed nothing. Please say it again.'; },
      confirm: function (l, v) { return 'I’ll change ' + l + ' to ' + v + '. Is that right? Say yes or no.'; },
      what: 'that change',
      doing: function (l) { return 'Changing ' + l + '.'; },
      done: function (l, v) { return 'Done. ' + l + ' now shows ' + v + '. I haven’t submitted the form — say “click save” or tap the button when you’re ready.'; },
      mismatch: function (l, v) { return 'I entered it, but ' + l + ' now shows “' + v + '”, so I can’t confirm the change. Please check the field.'; },
      gone: function (l) { return 'The ' + l + ' field isn’t available any more, so I changed nothing.'; },
      stopped: 'Okay, I stopped before changing anything.',
      undoNone: 'There’s nothing to undo.',
      undone: function (l) { return 'Undone. ' + l + ' is back to what it was.'; },
      undoFail: function (l) { return 'I tried to put ' + l + ' back, but I can’t confirm it. Please check the field.'; },
      why: { phone: 'phone number', email: 'email address', number: 'number', url: 'web address', option: 'choice', length: 'value (it’s too long)', pattern: 'value', range: 'number in the allowed range' },
      kinds: { date: 'date or time', checkbox: 'checkbox', radio: 'radio button', file: 'file', range: 'slider', color: 'colour', other: 'special' }
    },
    m: {
      off: 'I don’t keep anything about visitors on this site, so there’s nothing to remember or forget.',
      hint: 'If you’d like, I can remember your name on this device. Just say “remember me”.',
      consentAsk: 'I can remember your name, the pages you visit and notes you ask me to keep. It stays on this device only, never health or payment details, and you can say “forget me” any time. Want me to? Say yes or no.',
      consentAskName: function (n) { return 'Nice to meet you, ' + n + '. Want me to remember that on this device? It stays here, never health or payment details, and you can say “forget me” any time. Yes or no?'; },
      consentAskFact: 'I can keep that note on this device only, never health or payment details, and you can say “forget me” any time. Want me to? Say yes or no.',
      consentOk: 'Okay. I’ll remember on this device only. Say “what do you remember” to see it, or “forget me” to delete it.',
      alreadyOn: 'I’m already remembering on this device. Say “what do you remember” to see it, or “forget me” to delete it.',
      resumed: 'Okay, I’m remembering again.',
      savedName: function (n) { return 'Got it, ' + n + '. I’ll remember that.'; },
      sessionName: function (n) { return 'Okay, ' + n + '. I’ll use that name for this visit only.'; },
      badName: 'I didn’t catch a name there. Try “my name is” and your first name.',
      savedFact: 'Noted. I’ll keep that on this device.',
      refuse: 'I don’t store health, payment or password details. Your provider’s own system is the right place for those.',
      recallNone: 'I don’t have anything saved about you on this device.',
      recall: function (parts) { return 'Here’s what I have on this device: ' + parts + '. I never store health or payment details. Say “forget me” to delete it all.'; },
      rName: function (n) { return 'your name, ' + n; },
      rVisits: function (n) { return 'you’ve visited ' + n + (n === 1 ? ' time' : ' times'); },
      rPages: function (l) { return 'recent pages: ' + l; },
      rNotes: function (l) { return (l.length === 1 ? 'one note: ' : l.length + ' notes: ') + l.map(function (x) { return '“' + x + '”'; }).join(', '); },
      paused: 'Okay. I’ll stop adding to it. What I already saved stays until you say “forget me”.',
      forgetAsk: 'Delete everything I remember about you on this device? Say yes or no.',
      forgetNameAsk: 'Delete your name from what I remember? Say yes or no.',
      forgot: 'Done. I deleted it, and I checked: nothing is stored on this device any more.',
      forgotName: 'Done. I deleted your name, and I checked that it’s gone.',
      forgotFail: 'I tried to delete it, but I can’t confirm that it’s gone. You can clear this site’s data in your browser settings.',
      nothing: 'There’s nothing saved, so there’s nothing to forget.',
      welcome: function (n, last) { return 'Welcome back' + (n ? ', ' + n : '') + '.' + (last ? ' Last time you were looking at “' + last + '”.' : ''); },
      that: 'that',
      noStore: 'This browser won’t let me save anything on this device, so I can’t remember you. I’ll use your name for this visit only.',
      lastTime: function (last) { return 'Last time you were looking at “' + last + '”.'; }
    },
    k: {
      from: function (s) { return 'That’s from ' + s + '.'; },
      goAsk: 'Want me to take you there so you can read the rest? Say yes or no.',
      medText: function (s) { return 'The section ' + s + ' has medical details. I won’t read dosing or treatment information aloud, because it depends on your situation. Please check it with your provider.'; },
      none: 'I couldn’t find that in this site’s pages, and I don’t want to guess.',
      noneSuggest: function (l) { return ' Maybe “' + l + '” helps. Want me to take you there? Say yes or no.'; },
      noneTip: ' You could try asking another way, or contact the site’s team.',
      medical: 'I can’t give medical advice or tell you what to take. Please ask your doctor, pharmacist or care team.',
      medicalGo: function (l) { return ' I can take you to “' + l + '”. Say yes or no.'; },
      that: 'that'
    },
    help: { forms: ' To change a field, say “change my phone to” and the new number.', memory: ' Say “remember me” and I’ll remember your name on this device.', knowledge: ' You can ask about this site, like “what’s the return policy?”.' }
  };
  PACKS.es.sk = {
    f: {
      noFields: 'No veo ningún campo de formulario en esta página.',
      noField: function (q, list) { return 'No encontré un campo llamado “' + q + '” en esta página.' + (list ? ' Veo: ' + list + '.' : ''); },
      which: function (n, q) { return 'Encontré ' + n + ' campos que podrían ser “' + q + '”:'; },
      blocked: function (l) { return 'No voy a rellenar “' + l + '” por voz. Parece un campo de contraseña, de pago u otro dato sensible. Por favor, escríbelo tú.'; },
      readonly: function (l) { return '“' + l + '” es de solo lectura o está desactivado, así que no puedo cambiarlo.'; },
      unsupported: function (l, k) { return '“' + l + '” es un control de tipo ' + k + '. Ese no puedo cambiarlo por voz, úsalo tú, por favor.'; },
      invalid: function (l, why) { return 'Eso no parece un ' + why + ' válido para “' + l + '”, así que no cambié nada. Por favor, dilo otra vez.'; },
      confirm: function (l, v) { return 'Voy a cambiar ' + l + ' a ' + v + '. ¿Es correcto? Di sí o no.'; },
      what: 'ese cambio',
      doing: function (l) { return 'Cambiando ' + l + '.'; },
      done: function (l, v) { return 'Listo. ' + l + ' ahora muestra ' + v + '. No he enviado el formulario: di “haz clic en guardar” o pulsa el botón cuando quieras.'; },
      mismatch: function (l, v) { return 'Lo introduje, pero ' + l + ' ahora muestra “' + v + '”, así que no puedo confirmar el cambio. Revisa el campo, por favor.'; },
      gone: function (l) { return 'El campo ' + l + ' ya no está disponible, así que no cambié nada.'; },
      stopped: 'Vale, me detuve antes de cambiar nada.',
      undoNone: 'No hay nada que deshacer.',
      undone: function (l) { return 'Deshecho. ' + l + ' vuelve a estar como antes.'; },
      undoFail: function (l) { return 'Intenté dejar ' + l + ' como estaba, pero no puedo confirmarlo. Revisa el campo, por favor.'; },
      why: { phone: 'número de teléfono', email: 'correo electrónico', number: 'número', url: 'enlace web', option: 'opción', length: 'valor (es demasiado largo)', pattern: 'valor', range: 'número dentro del rango permitido' },
      kinds: { date: 'fecha u hora', checkbox: 'casilla', radio: 'botón de opción', file: 'archivo', range: 'deslizador', color: 'color', other: 'especial' }
    },
    m: {
      off: 'En este sitio no guardo nada sobre los visitantes, así que no hay nada que recordar ni olvidar.',
      hint: 'Si quieres, puedo recordar tu nombre en este dispositivo. Solo di “recuérdame”.',
      consentAsk: 'Puedo recordar tu nombre, las páginas que visitas y las notas que me pidas guardar. Se queda solo en este dispositivo, nunca datos de salud ni de pago, y puedes decir “olvídame” cuando quieras. ¿Quieres que lo haga? Di sí o no.',
      consentAskName: function (n) { return 'Encantada, ' + n + '. ¿Quieres que lo recuerde en este dispositivo? Se queda aquí, nunca datos de salud ni de pago, y puedes decir “olvídame” cuando quieras. ¿Sí o no?'; },
      consentAskFact: 'Puedo guardar esa nota solo en este dispositivo, nunca datos de salud ni de pago, y puedes decir “olvídame” cuando quieras. ¿Quieres que lo haga? Di sí o no.',
      consentOk: 'Vale. Recordaré solo en este dispositivo. Di “qué recuerdas” para verlo, o “olvídame” para borrarlo.',
      alreadyOn: 'Ya estoy recordando en este dispositivo. Di “qué recuerdas” para verlo, o “olvídame” para borrarlo.',
      resumed: 'Vale, vuelvo a recordar.',
      savedName: function (n) { return 'Entendido, ' + n + '. Lo recordaré.'; },
      sessionName: function (n) { return 'Vale, ' + n + '. Usaré ese nombre solo en esta visita.'; },
      badName: 'No entendí un nombre. Prueba con “me llamo” y tu nombre.',
      savedFact: 'Anotado. Lo guardo en este dispositivo.',
      refuse: 'No guardo datos de salud, de pago ni contraseñas. El sistema de tu profesional es el lugar adecuado para eso.',
      recallNone: 'No tengo nada guardado sobre ti en este dispositivo.',
      recall: function (parts) { return 'Esto es lo que tengo en este dispositivo: ' + parts + '. Nunca guardo datos de salud ni de pago. Di “olvídame” para borrarlo todo.'; },
      rName: function (n) { return 'tu nombre, ' + n; },
      rVisits: function (n) { return 'nos has visitado ' + n + (n === 1 ? ' vez' : ' veces'); },
      rPages: function (l) { return 'páginas recientes: ' + l; },
      rNotes: function (l) { return (l.length === 1 ? 'una nota: ' : l.length + ' notas: ') + l.map(function (x) { return '“' + x + '”'; }).join(', '); },
      paused: 'Vale. Dejo de añadir cosas. Lo que ya guardé se queda hasta que digas “olvídame”.',
      forgetAsk: '¿Borro todo lo que recuerdo de ti en este dispositivo? Di sí o no.',
      forgetNameAsk: '¿Borro tu nombre de lo que recuerdo? Di sí o no.',
      forgot: 'Listo. Lo borré y lo comprobé: ya no hay nada guardado en este dispositivo.',
      forgotName: 'Listo. Borré tu nombre y comprobé que ya no está.',
      forgotFail: 'Intenté borrarlo, pero no puedo confirmar que ya no esté. Puedes borrar los datos de este sitio en la configuración del navegador.',
      nothing: 'No hay nada guardado, así que no hay nada que olvidar.',
      welcome: function (n, last) { return 'Qué bueno verte de nuevo' + (n ? ', ' + n : '') + '.' + (last ? ' La última vez estabas mirando “' + last + '”.' : ''); },
      that: 'eso',
      noStore: 'Este navegador no me deja guardar nada en este dispositivo, así que no puedo recordarte. Usaré tu nombre solo en esta visita.',
      lastTime: function (last) { return 'La última vez estabas mirando “' + last + '”.'; }
    },
    k: {
      from: function (s) { return 'Eso viene de ' + s + '.'; },
      goAsk: '¿Quieres que te lleve allí para leer el resto? Di sí o no.',
      medText: function (s) { return 'La sección ' + s + ' tiene detalles médicos. No leeré en voz alta dosis ni tratamientos, porque dependen de tu situación. Consúltalo con tu profesional.'; },
      none: 'No encontré eso en las páginas de este sitio, y prefiero no adivinar.',
      noneSuggest: function (l) { return ' Quizá te ayude “' + l + '”. ¿Quieres que te lleve? Di sí o no.'; },
      noneTip: ' Puedes preguntarlo de otra forma o contactar con el equipo del sitio.',
      medical: 'No puedo dar consejo médico ni decirte qué tomar. Pregunta a tu médico, tu farmacéutico o tu equipo de cuidado.',
      medicalGo: function (l) { return ' Puedo llevarte a “' + l + '”. Di sí o no.'; },
      that: 'eso'
    },
    help: { forms: ' Para cambiar un campo, di “cambia mi teléfono a” y el número nuevo.', memory: ' Di “recuérdame” y recordaré tu nombre en este dispositivo.', knowledge: ' Puedes preguntar sobre este sitio, por ejemplo “¿cuál es la política de devoluciones?”.' }
  };


  /* ---- skills grammar (matched on accent-folded, lowercased text) ---- */
  Object.assign(PACKS.en.sk.k, {
    srcSec: function (q, page) { return 'the “' + q + '” section' + (page ? ' of the “' + page + '” page' : ''); },
    srcOwner: 'the site’s own notes'
  });
  Object.assign(PACKS.es.sk.k, {
    srcSec: function (q, page) { return 'la sección “' + q + '”' + (page ? ' de la página “' + page + '”' : ''); },
    srcOwner: 'las notas del propio sitio'
  });
  PACKS.en.sg = {
    pre: /^(please|could you|can you|would you|will you|i want to|i would like to|id like to|i d like to|i need to|lets|let s|i wanna|go ahead and|hey|ok|okay|hi|hello|voicelayer|assistant)\s+/,
    mem: {
      enable: /^(remember me|remember my name|remember my preferences|remember this for me|start remembering|start remembering me|keep my details|save my preferences|you can remember me|please remember me)$/,
      pause: /^(stop remembering|stop remembering me|stop saving|stop learning|stop learning about me|dont remember me|dont remember anything|do not remember me|dont save anything)$/,
      recall: /^(what do you (remember|know)( about me)?|what have you (saved|stored|remembered)( about me)?|whats (saved|stored) about me|what did you save|what data do you have( on me| about me)?|what do you have on me|show me what you remember|what are you remembering|what are you remembering about me)$/,
      forget: /^(forget me|forget everything|forget all of it|forget everything about me|delete (my data|everything|my memory|what you remember|all my data|my info|my information|me)|erase (my data|everything|me|my memory)|clear (my data|my memory|everything)|wipe (my data|everything|my memory))$/,
      forgetName: /^(forget my name|delete my name|erase my name|remove my name)$/,
      name: /\b(?:my name is|call me|im called|i am called|they call me)\s+(.+)$/,
      fact: /\b(?:remember that|make a note that|note that|take a note that|keep a note that)\s+(.+)$/
    },
    notName: /^(back|later|tomorrow|now|when|if|maybe|at|on|please|an?|the|it|that)\b|^(\S+\s+){3,}\S+$/,
    undo: /^(undo|undo that|undo the change|undo that change|put it back|revert|revert that|revert it|revert the change|change it back|set it back)$/,
    formset: [
      { re: /^(?:(?:please|could you|can you|would you|i want to|i would like to|id like to|i need to|lets|go ahead and)\s+)*(?:change|set|update|edit|correct|fix|replace)\s+(?:my|the|your|our)?\s*(.+?)\s+(?:to|as|with|so it says|should be|is now)\s+(.+)$/, f: 1, v: 2 },
      { re: /^(?:(?:please|could you|can you|would you|i want to|i would like to|id like to|i need to|lets|go ahead and)\s+)*(?:enter|type|put|write|fill in|fill out|input)\s+(.+?)\s+(?:in|into|in to|for)\s+(?:my|the|your)?\s*(.+?)(?:\s+(?:field|box|input|form))?$/, f: 2, v: 1 },
      { re: /^(?:my|the)\s+(.+?)\s+(?:is|are now|has changed to)\s+(.+)$/, f: 1, v: 2, soft: true }
    ],
    contactQ: 'contact appointment book',
    notField: /^(language|the language|voice|speed|volume|mode|theme|assistant|voice assistant|sound|it|that|this|everything|your voice|the voice)$/,
    q: /^(what|whats|how|hows|when|where|who|whos|why|which|do|does|did|can|could|is|are|will|would|should|tell me|i want to know|i would like to know|id like to know|explain|any|got)\b/,
    medText: /\b(dose|doses|dosage|dosing|mg|milligrams?|tablets?|capsules?|inject\w*|contraindicat\w*|side effects?|take (one|two|three|\d+)|units of|insulin|titrat\w*)\b/,
    medBiz: /\b(return|returns|refund|ship|shipping|deliver\w*|order|orders|buy|cost|price|prices|pay|payment|cancel|exchange|warranty|appointment|schedule|book|hours|open|located|location|address|contact|account|login|sign ?up|membership|subscription|discount|coupon|policy|policies)\b/,
    medAdvice: /\b(should i|can i|may i|could i|is it ok(ay)? (to|if i)|is it safe (to|for me)|do i need (to|a)|what should i|am i|do i have|why do i|why am i|how (do|can) i (treat|cure|fix|stop|lower|raise|manage))\b/,
    medTerms: /\b(medic\w*|pills?|tablets?|capsules?|doses?|dosage|insulin|drugs?|antibiotics?|painkillers?|ibuprofen|aspirin|tylenol|paracetamol|vitamins?|supplements?|prescription\w*|injections?|inject\w*|symptoms?|diagnos\w+|treatment|therapy|surgery|pain|fever|infection|allerg\w+|blood pressure|blood sugar|glucose|pregnan\w+|rash|cough|headache|chest|dizz\w+|nausea|bleeding|cancer|diabet\w+|disease|condition|sick|ill|dying)\b/,
    medExplicit: /\b(diagnose me|what is wrong with me|am i dying|am i having a|do i have (a |an )?\w* ?(disease|infection|cancer|diabetes|disorder)|what (dose|dosage) (should|do) i|how much (.* )?should i (take|inject|use)|should i (take|stop|start|increase|decrease|skip|double) (my |the |some )?(meds?|medicat\w*|pills?|insulin|dose|dosage|antibiotics?|supplements?)|treat my|cure my)\b/
  };
  PACKS.es.sg = {
    pre: /^(por favor|puedes|podrias|podria|puede|quiero|quisiera|me gustaria|necesito|vamos a|a ver|oye|vale|ok|okay|venga|ahora|hola|hey|voicelayer|asistente)\s+/,
    mem: {
      enable: /^(recuerdame|recuerda me|acuerdate de mi|recuerda mi nombre|recuerda mis preferencias|empieza a recordar|guarda mis preferencias|guarda mis datos|recordarme|puedes recordarme)$/,
      pause: /^(deja de recordar|deja de recordarme|no me recuerdes|no guardes nada|deja de guardar|no recuerdes nada|deja de aprender)$/,
      recall: /^(que recuerdas( de mi)?|que sabes de mi|que has guardado( de mi)?|que tienes guardado( de mi)?|que datos tienes( de mi| mios)?|muestrame lo que recuerdas|que estas recordando|que guardas de mi)$/,
      forget: /^(olvidame|olvida todo|olvida todo lo que sabes de mi|borra todo|borra mis datos|borra lo que recuerdas|elimina mis datos|elimina todo|borrame|borra mi memoria|olvidate de mi)$/,
      forgetName: /^(olvida mi nombre|borra mi nombre|elimina mi nombre)$/,
      name: /\b(?:me llamo|mi nombre es|llamame)\s+(.+)$/,
      fact: /\b(?:recuerda que|anota que|apunta que|toma nota de que|toma nota que|guarda que)\s+(.+)$/
    },
    notName: /^(luego|despues|manana|mas tarde|ahora|cuando|si|a las|al|por favor|un|una|el|la|eso)\b|^(\S+\s+){3,}\S+$/,
    undo: /^(deshaz|deshacer|deshaz eso|deshaz el cambio|deshacer el cambio|vuelve a ponerlo|ponlo como estaba|revierte|revertir|revierte el cambio)$/,
    formset: [
      { re: /^(?:(?:por favor|puedes|podrias|quiero|necesito|quisiera|me gustaria)\s+)*(?:cambia|cambiar|actualiza|actualizar|edita|editar|corrige|corregir|modifica|modificar|cambiame)\s+(?:mi|mis|el|la|tu)?\s*(.+?)\s+(?:a|por|como|con|para que diga|en|sea)\s+(.+)$/, f: 1, v: 2 },
      { re: /^(?:(?:por favor|puedes|podrias|quiero|necesito|quisiera|me gustaria)\s+)*(?:pon|poner|ponme)\s+(?:mi|mis|el|la)\s+(.+?)\s+(?:a|como|en)\s+(.+)$/, f: 1, v: 2 },
      { re: /^(?:(?:por favor|puedes|podrias|quiero|necesito|quisiera|me gustaria)\s+)*(?:escribe|teclea|introduce|pon|anota|ingresa)\s+(.+?)\s+(?:en|dentro de|para)\s+(?:mi|el|la|tu)?\s*(.+?)(?:\s+(?:campo|casilla|cuadro|formulario))?$/, f: 2, v: 1 },
      { re: /^(?:mi|mis|el|la)\s+(.+?)\s+(?:es|son|ahora es|ha cambiado a)\s+(.+)$/, f: 1, v: 2, soft: true }
    ],
    contactQ: 'contacto cita reservar',
    notField: /^(idioma|el idioma|lenguaje|voz|la voz|velocidad|volumen|modo|tema|asistente|el asistente|sonido|eso|esto|todo)$/,
    q: /^(que|cual|cuales|como|cuando|donde|quien|por que|cuanto|cuanta|cuantos|cuantas|puedo|puede|pueden|hay|tienen|tiene|tienes|se puede|es posible|dime|cuentame|explicame|venden|vende|ofrecen|ofrece|aceptan|acepta|atienden|abren|cierran|hacen|trabajan|dan|cobran|necesito saber)\b/,
    medText: /\b(dosis|mg|miligramos?|tabletas?|pastillas?|capsulas?|inyect\w*|contraindicac\w*|efectos secundarios|insulina|tomar (uno|una|dos|tres|\d+)|unidades de)\b/,
    medBiz: /\b(devoluci\w*|reembolso|envio|envios|entrega|pedido|pedidos|comprar|costo|precio|precios|pagar|pago|cancelar|cambio|garantia|cita|horario|horarios|ubicacion|direccion|contacto|cuenta|suscripcion|membresia|descuento|cupon|politica|politicas)\b/,
    medAdvice: /\b(debo|debería|deberia|puedo|podria|es seguro|necesito|tengo|por que me|como (puedo )?(tratar|curar|bajar|subir|controlar)|que debo)\b/,
    medTerms: /\b(medic\w*|pastillas?|tabletas?|capsulas?|dosis|insulina|farmacos?|antibioticos?|analgesicos?|ibuprofeno|aspirina|paracetamol|vitaminas?|suplementos?|receta|inyecc\w*|sintomas?|diagnostic\w*|tratamiento|terapia|cirugia|dolor|fiebre|infeccion|alergi\w+|presion arterial|azucar en sangre|glucosa|embaraz\w+|sarpullido|tos|dolor de cabeza|pecho|mareo\w*|nauseas?|sangrado|cancer|diabet\w+|enfermedad|enfermo|enferma)\b/,
    medExplicit: /\b(diagnosticame|que me pasa|me estoy muriendo|tengo (una |un )?\w* ?(enfermedad|infeccion|cancer|diabetes|trastorno)|que dosis (debo|tomo)|cuanto (.* )?debo (tomar|inyectar|usar)|debo (tomar|dejar|empezar|aumentar|reducir|saltar|duplicar) (mi |mis |la |el |las |los )?(medicacion|medicamentos?|pastillas?|insulina|dosis|antibioticos?|suplementos?)|tratar mi|curar mi)\b/
  };

  const CP_LINT = /\b(you (need|must|should|have) (to )?(take|buy|start|stop|use)|you are (deficient|sick|ill)|you have (an? )?(disease|disorder|condition|deficiency|illness)|diagnos\w*|prescrib\w*|tienes que (tomar|comprar|usar)|debes (tomar|comprar|dejar|usar)|estas (enferm[oa]|deficiente)|tienes (una |un )?(enfermedad|deficiencia|trastorno)|diagnostic\w*|recet\w*)\b/i;
  const CP_RULES = {
    wellness: [
      { id: 'sleep_low', pri: 70, when: { metric: 'sleep_hours', op: '<', value: 6 },
        text: { en: 'Your sleep last night was {value} {unit}, under six hours{prevPart}. Source: {source}.', es: 'Anoche dormiste {value} {unit}, menos de seis horas{prevPart}. Fuente: {source}.' },
        because: { en: 'your sleep reading was under six hours', es: 'tu lectura de sueño fue menor de seis horas' } },
      { id: 'hrv_drop', pri: 65, when: { metric: 'hrv', change: { op: '<', value: -10 } },
        text: { en: 'Your {label} is {value} {unit}, down {change} percent from {prev}. Source: {source}.', es: 'Tu {label} es {value} {unit}, un {change} por ciento menos que {prev}. Fuente: {source}.' },
        because: { en: 'your HRV fell more than ten percent against your previous reading', es: 'tu HRV bajó más de un diez por ciento frente a tu lectura anterior' } },
      { id: 'rhr_up', pri: 55, when: { metric: 'resting_hr', change: { op: '>', value: 8 } },
        text: { en: 'Your resting heart rate is {value} {unit}, up {change} percent from {prev}. Source: {source}.', es: 'Tu frecuencia cardíaca en reposo es {value} {unit}, un {change} por ciento más que {prev}. Fuente: {source}.' },
        because: { en: 'your resting heart rate rose more than eight percent', es: 'tu frecuencia en reposo subió más de un ocho por ciento' } },
      { id: 'lab_range', pri: 75, when: { metric: '*', lab: true, outOfRange: true },
        text: { en: 'Your {label} result ({date}) was {value} {unit}, outside the reference range of {low} to {high}. That’s worth discussing with your clinician.', es: 'Tu resultado de {label} ({date}) fue {value} {unit}, fuera del rango de referencia de {low} a {high}. Conviene comentarlo con tu profesional de salud.' },
        because: { en: 'a lab value on file sits outside its reference range', es: 'un valor de laboratorio registrado está fuera de su rango de referencia' } },
      { id: 'steps_low', pri: 35, when: { metric: 'steps', belowTarget: 0.5 },
        text: { en: 'You’re at {value} steps so far today, about {pct} percent of your {target} target.', es: 'Llevas {value} pasos hoy, cerca del {pct} por ciento de tu objetivo de {target}.' },
        because: { en: 'your steps are under half of your daily target', es: 'tus pasos están por debajo de la mitad de tu objetivo diario' } },
      { id: 'med_due', pri: 80, kind: 'reminder', when: { task: { kind: ['medication', 'supplement'] }, pending: true },
        text: { en: 'Reminder from your own list: {label}{dueAt}.', es: 'Recordatorio de tu propia lista: {label}{dueAt}.' },
        because: { en: 'it is on the list you or your provider set up and isn’t marked done', es: 'está en la lista que tú o tu profesional configuraron y no está marcado como hecho' } },
      { id: 'streak', pri: 20, kind: 'praise', when: { metric: 'streak_days', op: '>=', value: 3 },
        text: { en: 'You’re on a {value}-day streak. Nice consistency.', es: 'Llevas {value} días seguidos. Buena constancia.' },
        because: { en: 'you have a streak of three days or more', es: 'tienes una racha de tres días o más' } }
    ],
    training: [
      { id: 'session_today', pri: 80, kind: 'reminder', when: { task: { kind: 'session' }, pending: true },
        text: { en: 'On your plan today: {label}{dueAt}.', es: 'En tu plan de hoy: {label}{dueAt}.' },
        because: { en: 'it is on your training plan and not marked done', es: 'está en tu plan de entrenamiento y no está marcado como hecho' } },
      { id: 'load_high', pri: 70, when: { metric: 'load_ratio', op: '>', value: 1.5 },
        text: { en: 'Your training load is {value} times your four-week average. Ratios above 1.5 are linked with higher injury risk, so you may want an easier day.', es: 'Tu carga de entrenamiento es {value} veces tu media de cuatro semanas. Valores por encima de 1,5 se asocian con más riesgo de lesión, así que quizá convenga un día más suave.' },
        because: { en: 'your load ratio is above 1.5', es: 'tu ratio de carga supera 1,5' } },
      { id: 'recovery_low', pri: 65, when: { metric: 'recovery', op: '<', value: 34 },
        text: { en: 'Your recovery score is {value} percent{prevPart}, in the low zone. Source: {source}.', es: 'Tu puntuación de recuperación es {value} por ciento{prevPart}, en la zona baja. Fuente: {source}.' },
        because: { en: 'your recovery score is under 34 percent', es: 'tu recuperación está por debajo del 34 por ciento' } },
      { id: 'sessions_behind', pri: 40, when: { metric: 'sessions_week', belowTarget: 1 },
        text: { en: 'You’ve done {value} of {target} sessions this week.', es: 'Llevas {value} de {target} sesiones esta semana.' },
        because: { en: 'your sessions this week are under your weekly target', es: 'tus sesiones de esta semana están por debajo de tu objetivo semanal' } },
      { id: 'streak', pri: 20, kind: 'praise', when: { metric: 'streak_days', op: '>=', value: 3 },
        text: { en: 'That’s {value} training days in a row. Strong consistency.', es: 'Son {value} días de entrenamiento seguidos. Gran constancia.' },
        because: { en: 'you have a streak of three days or more', es: 'tienes una racha de tres días o más' } }
    ],
    coaching: [
      { id: 'habit_open', pri: 70, kind: 'reminder', when: { task: { kind: 'habit' }, pending: true },
        text: { en: 'Still open today: {label}{dueAt}.', es: 'Sigue pendiente hoy: {label}{dueAt}.' },
        because: { en: 'it is one of your daily habits and isn’t marked done', es: 'es uno de tus hábitos diarios y no está marcado como hecho' } },
      { id: 'review_due', pri: 60, kind: 'reminder', when: { task: { kind: 'review' }, pending: true },
        text: { en: 'Coming up: {label}{dueAt}.', es: 'Próximamente: {label}{dueAt}.' },
        because: { en: 'it is on your calendar and not done yet', es: 'está en tu calendario y aún no está hecho' } },
      { id: 'goal_pace', pri: 50, when: { metric: 'goal_pct', belowTarget: 1 },
        text: { en: 'Your goal progress is {value} percent; the pace you set calls for {target} percent by now.', es: 'Tu avance hacia el objetivo es {value} por ciento; el ritmo que fijaste pide {target} por ciento a estas alturas.' },
        because: { en: 'your progress is behind the pace you set', es: 'tu avance va por detrás del ritmo que fijaste' } },
      { id: 'streak', pri: 20, kind: 'praise', when: { metric: 'streak_days', op: '>=', value: 3 },
        text: { en: 'You’ve kept your habit going {value} days in a row.', es: 'Llevas tu hábito {value} días seguidos.' },
        because: { en: 'you have a streak of three days or more', es: 'tienes una racha de tres días o más' } }
    ],
    support: [
      { id: 'order_update', pri: 70, kind: 'reminder', when: { task: { kind: 'order' }, pending: true },
        text: { en: 'Update on your order: {label}.', es: 'Novedad de tu pedido: {label}.' },
        because: { en: 'you have an order that isn’t completed yet', es: 'tienes un pedido que aún no está completado' } },
      { id: 'tickets_open', pri: 60, when: { metric: 'open_tickets', op: '>', value: 0 },
        text: { en: 'You have {value} open support {p:request|requests} with us.', es: 'Tienes {value} {p:solicitud abierta|solicitudes abiertas} de soporte con nosotros.' },
        because: { en: 'there is at least one open support request on your account', es: 'hay al menos una solicitud de soporte abierta en tu cuenta' } }
    ],
    none: []
  };

  /** demo datasets: clearly labelled in the UI ("DEMO DATA") and in the spoken greeting */
  function cpDemo(preset) {
    const H = 3600e3, D = 24 * H, now = Date.now();
    const U = function (en, es) { return { en: en, es: es }; };
    const L = function (en, es) { return { en: en, es: es }; };
    const base = { name: 'Boss', metrics: {}, tasks: [], demo: true };
    if (preset === 'wellness') {
      base.metrics = {
        sleep_hours: { value: 5.7, prev: 7.1, unit: U('hours', 'horas'), label: L('sleep', 'sueño'), at: now - 6 * H, source: 'Demo band' },
        hrv: { value: 41, prev: 49, unit: 'ms', label: 'HRV', at: now - 6 * H, source: 'Demo band' },
        vitamin_d: { value: 22, unit: 'ng/mL', label: L('vitamin D', 'vitamina D'), at: now - 20 * D, ref: { low: 30, high: 100 }, lab: true, ttlHours: 90 * 24, source: 'Demo lab' },
        steps: { value: 3200, target: 8000, unit: '', label: L('steps', 'pasos'), at: now - 1 * H, source: 'Demo phone' }
      };
      base.tasks = [{ id: 'm1', kind: 'supplement', label: L('your morning supplement', 'tu suplemento de la mañana'), due: '08:00', done: false }];
    } else if (preset === 'training') {
      base.metrics = {
        sessions_week: { value: 2, target: 4, unit: '', label: L('sessions', 'sesiones'), at: now - 2 * H, source: 'Demo log' },
        load_ratio: { value: 1.6, unit: '', label: L('training load', 'carga'), at: now - 2 * H, source: 'Demo log' },
        recovery: { value: 31, prev: 62, unit: '%', label: L('recovery', 'recuperación'), at: now - 5 * H, source: 'Demo band' },
        streak_days: { value: 5, unit: '', label: L('streak', 'racha'), at: now - 2 * H, source: 'Demo log' }
      };
      base.tasks = [{ id: 's1', kind: 'session', label: L('upper-body strength', 'fuerza de tren superior'), due: '18:00', done: false }];
    } else if (preset === 'coaching') {
      base.metrics = {
        goal_pct: { value: 40, target: 60, unit: '%', label: L('goal', 'objetivo'), at: now - 4 * H, source: 'Demo tracker' },
        streak_days: { value: 4, unit: '', label: L('streak', 'racha'), at: now - 4 * H, source: 'Demo tracker' }
      };
      base.tasks = [{ id: 'h1', kind: 'habit', label: L('morning journaling', 'diario de la mañana'), due: '', done: false }, { id: 'r1', kind: 'review', label: L('your weekly review', 'tu revisión semanal'), due: '17:00', done: false }];
    } else if (preset === 'support') {
      base.metrics = { open_tickets: { value: 1, unit: '', label: L('open requests', 'solicitudes abiertas'), at: now - 1 * H, source: 'Demo desk' } };
      base.tasks = [{ id: 'o1', kind: 'order', label: L('order 1042 ships tomorrow', 'el pedido 1042 sale mañana'), due: '', done: false }];
    }
    return base;
  }
  function cpDemoCatalog(preset) {
    if (preset !== 'wellness') return [];
    return [
      { id: 'd3', name: { en: 'Vitamin D3 2000 IU', es: 'Vitamina D3 2000 UI' }, for: ['vitamin_d'], approved: true, rx: false, price: '$14' },
      { id: 'rec', name: { en: 'a recovery peptide protocol', es: 'un protocolo de péptidos de recuperación' }, for: ['hrv'], approved: true, rx: true, provider: 'your clinician' }
    ];
  }

  const loc = function (v) { if (v == null) return ''; if (typeof v === 'object') return v[LANG] != null ? v[LANG] : (v.en != null ? v.en : ''); return String(v); };
  const cpNum = function (v) { if (v == null || v === '' || !isFinite(Number(v))) return ''; const n = Math.round(Number(v) * 10) / 10; const s = String(n); return LANG === 'es' ? s.replace('.', ',') : s; };
  function cpCmp(a, op, b) { return op === '<' ? a < b : op === '<=' ? a <= b : op === '>' ? a > b : op === '>=' ? a >= b : op === '==' ? a === b : false; }
  function cpAtMs(a) { if (a == null || a === '') return Date.now(); const n = typeof a === 'number' ? a : Date.parse(a); return isFinite(n) ? n : Date.now(); }
  function cpRel(ms) { const P = I.cp, d = Math.floor((Date.now() - ms) / 864e5); return d <= 0 ? P.today : d === 1 ? P.yesterday : P.daysAgo(d); }
  function cpDaypart() { const h = new Date().getHours(); return h >= 5 && h < 12 ? 'morning' : h >= 12 && h < 18 ? 'afternoon' : h >= 18 && h < 23 ? 'evening' : 'night'; }
  function cpNormalize(s) {
    const out = { name: '', metrics: {}, tasks: [] };
    if (!s || typeof s !== 'object') return out;
    out.name = clean((s.profile && s.profile.name) || s.name || '');
    const mm = s.metrics || {};
    Object.keys(mm).forEach(function (k) {
      let m = mm[k]; if (m == null) return;
      if (typeof m !== 'object') m = { value: m };
      const v = Number(m.value); if (!isFinite(v)) return;
      out.metrics[k] = { key: k, value: v, prev: m.prev != null && isFinite(Number(m.prev)) ? Number(m.prev) : null, unit: m.unit || '', label: m.label || k.replace(/_/g, ' '),
        at: cpAtMs(m.at), ref: m.ref || null, target: m.target != null && isFinite(Number(m.target)) ? Number(m.target) : null, source: m.source || '', ttlHours: m.ttlHours, lab: !!m.lab };
    });
    (Array.isArray(s.tasks) ? s.tasks : []).forEach(function (t, i) {
      if (t && (t.label || t.kind)) out.tasks.push({ id: t.id || ('t' + i), kind: t.kind || 'task', label: t.label || t.kind, due: t.due || '', done: !!t.done });
    });
    out.demo = !!s.demo;
    return out;
  }
  function cpWhen(w, ctx) {
    if (typeof w === 'function') { let r; try { r = w(ctx); } catch (e) { return []; } if (!r) return []; return Array.isArray(r) ? r : [{}]; }
    if (!w) return [];
    const out = [];
    if (w.task) {
      const kinds = [].concat(w.task.kind || []);
      ctx.tasks.forEach(function (t) { if ((!kinds.length || kinds.indexOf(t.kind) >= 0) && (!w.pending || !t.done)) out.push({ t: t }); });
      return out;
    }
    const keys = w.metric === '*' ? Object.keys(ctx.metrics) : [w.metric];
    keys.forEach(function (k) {
      const m = ctx.metrics[k]; if (!m) return;
      const ttl = (m.ttlHours || ctx.maxAgeHours) * 3600e3;
      if (Date.now() - m.at > ttl) return;                                  // stale → never presented as current
      if (w.lab && !m.lab) return;
      if (w.op && !cpCmp(m.value, w.op, w.value)) return;
      let change = '';
      if (w.change) { if (m.prev == null || !m.prev) return; const pc = (m.value - m.prev) / Math.abs(m.prev) * 100; if (!cpCmp(pc, w.change.op, w.change.value)) return; change = Math.round(Math.abs(pc)); }
      if (w.outOfRange) { const r = m.ref; if (!r) return; const lo = isFinite(r.low) && m.value < r.low, hi = isFinite(r.high) && m.value > r.high; if (!(lo || hi)) return; }
      if (w.belowTarget != null) { if (m.target == null || !(m.value < m.target * w.belowTarget)) return; }
      out.push({ m: m, change: change });
    });
    return out;
  }
  function cpFill(str, hit, name) {
    const P = I.cp, m = hit.m || null, t = hit.t || null;
    const unit = m ? loc(m.unit) : '';
    const rep = {
      label: m ? loc(m.label) : (t ? loc(t.label) : ''), value: m ? cpNum(m.value) : '', unit: unit, prev: m ? cpNum(m.prev) : '', change: hit.change !== undefined ? String(hit.change) : '',
      target: m ? cpNum(m.target) : '', low: m && m.ref ? cpNum(m.ref.low) : '', high: m && m.ref ? cpNum(m.ref.high) : '', date: m ? cpRel(m.at) : '',
      source: m ? (m.source || P.yourData) : '', name: name || '', pct: m && m.target ? String(Math.round(m.value / m.target * 100)) : '',
      prevPart: m && m.prev != null ? P.prevPart(cpNum(m.prev), unit) : '', dueAt: t ? P.dueAt(t.due) : ''
    };
    return String(str).replace(/\{p:([^|}]*)\|([^}]*)\}/g, function (a, x, y) { return m && Number(m.value) === 1 ? x : y; })
      .replace(/\{(\w+)\}/g, function (a, k) { return rep[k] != null ? rep[k] : ''; })
      .replace(/\s+([.,;:])/g, '$1').replace(/\s{2,}/g, ' ').trim();
  }

  const Companion = {
    cfg: null, data: null, loaded: false, stage: 'off', insights: [], i: -1, cur: null, mood: null, greeted: false, optOut: false, _lastSay: '',
    enabled: function () { return !!this.cfg; },
    engaged: function () { return !!this.cfg && VL.woke && this.stage !== 'off'; },
    init: function () {
      const c = CONFIG.companion;
      if (!c || typeof c !== 'object') { this.cfg = null; return; }
      const preset = CP_RULES[c.preset] ? c.preset : 'none';
      this.cfg = Object.assign({ preset: preset, name: '', demo: false, maxInsights: 3, maxAgeHours: 48, rules: [], catalog: [], replaceRules: false }, c, { preset: preset });
      this.optOut = store.get(KEYS.cdismissed) === '1';
      this.rules = this.buildRules();
    },
    buildRules: function () {
      const cfg = this.cfg, list = (cfg.replaceRules ? [] : CP_RULES[cfg.preset].slice()).concat(Array.isArray(cfg.rules) ? cfg.rules : []);
      const ok = [];
      list.forEach(function (r) {
        if (!r || !r.id || !r.text || !r.when) { console.warn('[VoiceLayer] companion rule ignored (needs id, when, text):', r && r.id); return; }
        const texts = typeof r.text === 'string' ? [r.text] : Object.keys(r.text).map(function (k) { return r.text[k]; });
        const bad = texts.concat(typeof r.because === 'string' ? [r.because] : (r.because ? Object.keys(r.because).map(function (k) { return r.because[k]; }) : [])).find(function (t) { return CP_LINT.test(String(t)); });
        if (bad) { console.warn('[VoiceLayer] companion rule "' + r.id + '" dropped: wording looks like a diagnosis/instruction ("' + String(bad).slice(0, 60) + '…"). State data instead.'); return; }
        ok.push(r);
      });
      return ok;
    },
    setSignals: function (s) { this.cfg && (this.cfg.signals = s); this.loaded = false; },
    load: async function () {
      if (this.loaded) return;
      const cfg = this.cfg; let s = cfg.signals;
      try {
        if (typeof s === 'function') s = await s();
        else if (s && typeof s.then === 'function') s = await s;
        else if (!s && cfg.signalsUrl && location.protocol !== 'file:') { const r = await fetch(cfg.signalsUrl, { credentials: 'same-origin' }); if (r.ok) s = await r.json(); }
      } catch (e) { log('signals failed', e && e.message); s = null; }
      if (!s && cfg.demo) s = cpDemo(cfg.preset);
      this.data = cpNormalize(s);
      this.loaded = true;
    },
    catalogFor: function (rule, keys) {
      const cat = (this.cfg.catalog && this.cfg.catalog.length ? this.cfg.catalog : (this.cfg.demo ? cpDemoCatalog(this.cfg.preset) : []));
      const want = keys.concat(rule.offerFor || []);
      return cat.find(function (c) { return c && c.approved === true && (c.for || []).some(function (f) { return want.indexOf(f) >= 0; }); }) || null;
    },
    build: function () {
      const P = I.cp, d = this.data, ctx = { metrics: d.metrics, tasks: d.tasks, now: Date.now(), maxAgeHours: this.cfg.maxAgeHours, mood: this.mood };
      const name = d.name || this.cfg.name || '', cand = [], seen = {};
      this.rules.slice().sort(function (a, b) { return (b.pri || 50) - (a.pri || 50); }).forEach(function (r) {
        cpWhen(r.when, ctx).forEach(function (hit) {
          const key = r.id + ':' + ((hit.m && hit.m.key) || (hit.t && hit.t.id) || '');
          const slot = (hit.m && hit.m.key) || (hit.t && ('task:' + hit.t.id)) || key;
          if (seen[slot]) return; seen[slot] = true;
          const tpl = typeof r.text === 'string' ? r.text : (r.text[LANG] || r.text.en || '');
          if (!tpl) return;
          const bt = r.because ? (typeof r.because === 'string' ? r.because : (r.because[LANG] || r.because.en || '')) : '';
          const m = hit.m || null;
          const item = Companion.catalogFor(r, m ? [m.key] : []);
          cand.push({ id: key, rule: r.id, kind: r.kind || 'data', pri: r.pri || 50, text: cpFill(tpl, hit, name), because: bt,
            why: { key: m ? m.key : '', label: m ? loc(m.label) : (hit.t ? loc(hit.t.label) : ''), value: m ? cpNum(m.value) : '', unit: m ? loc(m.unit) : '', prev: m ? cpNum(m.prev) : '',
              change: hit.change !== undefined ? hit.change : '', date: m ? cpRel(m.at) : '', source: m ? (m.source || P.yourData) : '' },
            offer: item && !item.rx ? item : null, rx: item && item.rx ? item : null });
        });
      });
      return cand.slice(0, Math.max(1, this.cfg.maxInsights | 0));
    },
    /** the visitor switched language: rebuild what is on screen in the new language (nothing is spoken here) */
    onLang: function () {
      if (!this.cfg || !this.data) return;
      UI.hideCard(); VL.pending = null;
      if (this.stage === 'insights' || this.stage === 'done') {
        this.insights = this.build();
        this.cur = this.insights[this.i] || null;
        if (this.cur && this.stage === 'insights') UI.showCard(this.cur, this.i, this.insights.length);
      }
    },
    emit: function (type, extra) { try { window.dispatchEvent(new CustomEvent('voicelayer:companion', { detail: Object.assign({ type: type, preset: this.cfg && this.cfg.preset }, extra || {}) })); } catch (e) {} },

    /** speak-first: runs on the wake tap */
    begin: async function (alive) {
      const P = I.cp, cfg = this.cfg;
      await this.load();
      if (!alive()) return;
      const name = this.data.name || Memory.name() || cfg.name || '';
      UI.setDemo(!!(cfg.demo || this.data.demo));
      if (this.greeted || store.sget(KEYS.cdone)) { this.greeted = true; this.stage = 'insights'; this.emit('welcome_back'); return VL.say(P.back(name)); }
      this.greeted = true; store.sset(KEYS.cdone, '1');
      const g = cfg.greeting && (typeof cfg.greeting === 'object' ? cfg.greeting[LANG] : cfg.greeting);
      const hello = g ? g.replace(/\{name\}/g, name) : P.hello(P.part[cpDaypart()], name);
      const rt = Memory.ret(), back = rt && rt.last ? ' ' + I.sk.m.lastTime(rt.last) : '';
      const text = hello + back + (cfg.demo || this.data.demo ? ' ' + P.demoNote : '') + ' ' + (P.moodQ[cfg.preset] || P.moodQ.none);
      this.stage = 'mood'; this.emit('greeted');
      await VL.say(text);
    },
    classifyMood: function (t) {
      const P = I.cp; let mood = 'unknown';
      if (P.moodNotBad.test(t)) mood = 'neutral';
      else if (P.moodLow.test(t)) mood = 'low';
      else if (P.moodGood.test(t)) mood = 'good';
      else if (P.moodNeutral.test(t)) mood = 'neutral';
      return { mood: mood, sore: P.tagSore.test(t), sick: P.tagSick.test(t) };
    },
    startInsights: async function (ack, alive) {
      const P = I.cp;
      this.insights = this.build(); this.i = -1;
      const anyMetric = Object.keys(this.data.metrics).length > 0;
      if (!this.insights.length) {
        this.stage = 'done'; UI.hideCard();
        return VL.say(ack + ' ' + (anyMetric && !this.fresh() ? P.noFresh : P.none));
      }
      await VL.say(ack + ' ' + P.intro(this.insights.length));
      if (!alive()) return;
      return this.present(0, alive);
    },
    fresh: function () { const ttl = this.cfg.maxAgeHours * 3600e3, d = this.data; return Object.keys(d.metrics).some(function (k) { const m = d.metrics[k]; return Date.now() - m.at <= (m.ttlHours ? m.ttlHours * 3600e3 : ttl); }) || d.tasks.length > 0; },
    present: async function (i, alive) {
      const P = I.cp, ins = this.insights[i]; if (!ins) return this.finish(alive);
      this.i = i; this.cur = ins; this.stage = 'insights'; VL.pending = null;
      UI.showCard(ins, i, this.insights.length);
      this.emit('insight', { rule: ins.rule, index: i, of: this.insights.length });
      await VL.say(ins.text + (i === 0 ? ' ' + P.hint : ''));
      if (!alive()) return;
      if (ins.offer && !this.optOut) return this.askOffer(ins, alive);
      if (ins.rx) { UI.showRx(ins.rx); this.emit('rx_routed', { rule: ins.rule, item: ins.rx.id }); return VL.say(P.rxRoute(loc(ins.rx.provider))); }
    },
    disclosure: function () { return loc(this.cfg.disclosure) || I.cp.disclosure; },     // can never be empty
    askOffer: async function (ins, alive) {
      const P = I.cp, name = loc(ins.offer.name);
      UI.showOffer(ins.offer, this.disclosure());
      VL.pending = { kind: 'offer', until: performance.now() + 45000, ins: ins };
      this.emit('offer_shown', { rule: ins.rule, item: ins.offer.id });
      await VL.say(P.offer(name, this.disclosure()));
    },
    finish: async function (alive) {
      this.stage = 'done'; this.cur = null; UI.hideCard(); VL.pending = null;
      return VL.say(I.cp.ending);
    },
    crisis: async function () {
      this.stage = 'ready'; VL.pending = null; UI.hideCard();
      this.emit('safety');
      return VL.say(I.cp.crisis);
    },
    /** called from VL.run before the normal command grammar. Returns true when handled. */
    intercept: async function (text, intent, tok, alive) {
      const P = I.cp, t = norm(text), pend = VL.pending && VL.pending.kind === 'offer' ? VL.pending : null;
      if (pend) {
        if (I.yes.test(t)) {
          VL.pending = null; const it = pend.ins.offer;
          this.emit('offer_accepted', { rule: pend.ins.rule, item: it.id });
          UI.showOffer(it, this.disclosure(), true);
          try { window.dispatchEvent(new CustomEvent('voicelayer:offer', { detail: { id: it.id, name: loc(it.name), url: it.url || '', rule: pend.ins.rule } })); } catch (e) {}
          await VL.say(P.offerYes(loc(it.name)));
          if (it.url && /^(https?:|\/)/i.test(it.url) && alive()) { await sleep(900); if (alive()) location.href = it.url; }
          return true;
        }
        if (I.no.test(t) || P.skip.test(t)) { VL.pending = null; UI.hideOffer(); await VL.say(P.offerNo); return true; }
        if (!P.whyRe.test(t) && !P.optRe.test(t)) { VL.pending = null; UI.hideOffer(); }       // anything else lapses the offer
      }
      if (P.optRe.test(t)) { this.optOut = true; store.set(KEYS.cdismissed, '1'); VL.pending = null; UI.hideOffer(); this.emit('opt_out'); await VL.say(P.optOut); return true; }
      if (P.update.test(t)) { await this.startInsights('', alive); return true; }
      if (this.stage === 'mood' && intent.type === 'unknown') {
        const c = this.classifyMood(t); this.mood = c.mood; this.emit('mood', { mood: c.mood });
        const ack = P.moodAck[c.mood] + (c.sore ? P.moodExtra.sore : '') + (c.sick ? P.moodExtra.sick : '');
        await this.startInsights(ack, alive); return true;
      }
      if (this.stage === 'insights' || this.stage === 'done') {
        if (P.whyRe.test(t)) {
          if (pend) { await VL.say(P.whyOffer); return true; }
          if (!this.cur) { await VL.say(P.nothingToSay); return true; }
          UI.showWhy(true); await VL.say(P.why(this.cur.why, this.cur.because)); return true;
        }
        if (P.repeat.test(t)) { if (this.cur) { await VL.say(this.cur.text); return true; } }
        if (this.stage === 'insights' && (P.next.test(t) || P.skip.test(t))) { UI.hideOffer(); await this.present(this.i + 1, alive); return true; }
      }
      if (intent.type === 'unknown' && typeof CONFIG.aiAnswer === 'function') {
        if (await VL.aiAnswerFlow(text, alive)) return true;
      }
      return false;
    }
  };

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
        m.prices.push({ text: clean(mm[0]), value: parseMoney(mm[0]), el: n.parentElement });
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

    unwatch: function () {
      clearTimeout(this._timer);
      if (this._obs) { try { this._obs.disconnect(); } catch (e) {} this._obs = null; }
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
   *    NOTE: browsers do not expose speechSynthesis audio to Web Audio, so with the BROWSER voice SPEAKING is a
   *    pre-programmed voice-like wave tied to utterance boundary events. With the DEEPGRAM voice it reacts to the real audio.
   * ========================================================================= */
  function WaveformRenderer(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.state = 'idle';
    this.analyser = null;
    this.outAnalyser = null;                  // real TTS audio level (only with the Deepgram voice, which plays through Web Audio)
    this.outFreq = null;
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
  WaveformRenderer.prototype.setOutAnalyser = function (a) {
    this.outAnalyser = a || null;
    this.outFreq = a ? new Uint8Array(a.frequencyBinCount) : null;
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
        if (this.outAnalyser && this.outFreq) {                        // real audio: symmetric, smoothed
          const usable = Math.floor(this.outFreq.length * 0.55), idx = Math.min(usable - 1, Math.floor(d * usable));
          return (0.10 + 0.9 * Math.pow(this.outFreq[idx] / 255, 1.1)) * (1 - 0.35 * d * d) * k;
        }
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
    if (this.outAnalyser && this.outFreq && this.state === 'speaking') this.outAnalyser.getByteFrequencyData(this.outFreq);
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
   * 4b. RadialRenderer — the glass-mode visual: a glowing circle ringed by radial bars + expanding ripples.
   *     Reads the SAME audio taps as the panel waveform (UI.wave): mic analyser while listening, real TTS output
   *     analyser while speaking (Deepgram voice), a voice-shaped simulation otherwise.
   *       sleep      slow breathing circle + a "tap me" ripple
   *       idle       soft breathing, flat shimmer
   *       listening  bars follow YOUR voice, ripples leave the circle when you speak
   *       thinking   a bright arc sweeps around the ring
   *       speaking   smooth symmetric bars + ripples that follow the assistant's voice
   * ========================================================================= */
  function RadialRenderer(canvas) {
    this.canvas = canvas; this.ctx = canvas.getContext('2d');
    this.N = 72; this.cur = new Float32Array(this.N);
    this.ripples = []; this.lastRip = 0; this.level = 0; this.lastLevel = 0;
    this.t0 = performance.now(); this.running = false; this.dpr = 1; this.S = 400; this.R = 100;
    this.lite = false; this.hue = 215; this.sleep = false;
    this.visual = 'line'; this.flow = 'out'; this.W = 400; this.hist = new Float32Array(24); this._lastTick = 0; this._seed = 1;
    this.reduced = !!(window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches);
    this._loop = this._loop.bind(this);
  }
  RadialRenderer.prototype.configure = function (o) {
    this.lite = !!o.lite; this.auto = !!o.auto; this.hue = o.hue; this.N = this.lite ? 48 : 72; this.cur = new Float32Array(this.N);
    this.visual = (o.visual === 'radial' || o.visual === 'both') ? o.visual : 'line'; this.flow = o.flow === 'right' ? 'right' : 'out';
    this.LN = this.lite ? 29 : 41; this.hist = new Float32Array(this.flow === 'right' ? this.LN : (this.LN + 1) / 2);
  };
  RadialRenderer.prototype.resize = function () {
    const vw = document.documentElement.clientWidth || window.innerWidth, vh = window.innerHeight || 700;
    this.R = clamp(Math.round(Math.min(vw * 0.19, vh * (vh < 560 ? 0.10 : 0.13))), 46, 120);
    this.S = Math.round(this.R * 5);
    this.W = this.visual === 'radial' ? this.S : Math.max(this.S, Math.round(Math.min(vw * 0.88, 720)));
    this.dpr = this.lite ? 1 : Math.min(window.devicePixelRatio || 1, 2);
    this.canvas.style.width = this.W + 'px'; this.canvas.style.height = this.S + 'px';
    this.canvas.width = Math.round(this.W * this.dpr); this.canvas.height = Math.round(this.S * this.dpr);
    const host = (this.canvas.closest && this.canvas.closest('.vl-g-stage')) || this.canvas.parentNode; if (host && host.style) host.style.setProperty('--vl-R', this.R + 'px');
  };
  RadialRenderer.prototype.start = function () { if (this.running) return; this.running = true; this.resize(); requestAnimationFrame(this._loop); };
  RadialRenderer.prototype.stop = function () { this.running = false; };
  RadialRenderer.prototype._targets = function (i, t, state, w) {
    const N = this.N, th = (i / N) * Math.PI * 2, d = (1 - Math.cos(th)) / 2, k = this.reduced ? 0.4 : 1;   // d: 0 top → 1 bottom, mirrored left/right
    const sim = function (a) { const env = 0.5 + 0.5 * Math.sin(t * 1.7) * Math.sin(t * 0.63 + 1.3), jit = 0.5 + 0.5 * Math.sin(t * 9 + i * 1.9) * Math.sin(t * 5.3 + i * 0.7); return (0.12 + 0.75 * env * jit) * a; };
    if (state === 'listening') {
      if (w && w.analyser && w.freq) { const u = Math.floor(w.freq.length * 0.6), idx = Math.min(u - 1, Math.floor(d * u)); return Math.pow(w.freq[idx] / 255, 1.15) * (1.05 - 0.3 * d); }
      return sim(1 - 0.4 * d) * k;
    }
    if (state === 'speaking') {
      if (w && w.outAnalyser && w.outFreq) { const u = Math.floor(w.outFreq.length * 0.55), idx = Math.min(u - 1, Math.floor(d * u)); return (0.10 + 0.9 * Math.pow(w.outFreq[idx] / 255, 1.1)) * (1 - 0.3 * d * d) * k; }
      const kick = 0.55 + 0.45 * (w ? w.pulse : 0), a = 0.5 + 0.5 * Math.sin(t * 3.1 - d * 5.2), b = 0.5 + 0.5 * Math.sin(t * 1.9 - d * 2.6 + 1.1);
      return (0.14 + 0.70 * (0.6 * a + 0.4 * b) * kick) * (1 - 0.45 * d * d) * k;
    }
    if (state === 'thinking') {
      const ph = (t * 0.7) % 1, dist = Math.min(Math.abs(i / N - ph), 1 - Math.abs(i / N - ph));
      return (0.07 + 0.55 * Math.exp(-dist * dist * 260)) * k;
    }
    return 0.03 + 0.03 * (0.5 + 0.5 * Math.sin(t * 1.3 + i * 0.55)) * k;       // idle / sleep
  };
  /** one 0..1 loudness sample for the line: real analyser data when we have it, otherwise a speech-shaped simulation (browser voices can't be measured) */
  RadialRenderer.prototype._amp = function (state, t, w) {
    const mean = function (a, frac) { const u = Math.max(1, Math.floor(a.length * frac)); let s = 0; for (let k = 0; k < u; k++) s += a[k]; return s / u / 255; };
    const k = this.reduced ? 0.4 : 1;
    const wobble = 0.6 + 0.8 * Math.random();
    if (state === 'speaking') {
      if (w && w.outAnalyser && w.outFreq) return clamp(Math.pow(mean(w.outFreq, 0.5), 0.9) * 2.1, 0, 1) * (0.75 + 0.5 * Math.random());
      const syl = Math.max(0, Math.sin(t * 11.5) * 0.5 + Math.sin(t * 7.3 + 1.1) * 0.5), gap = 0.5 + 0.5 * Math.sin(t * 1.7) * Math.sin(t * 0.63 + 1.3);
      return clamp((0.12 + 0.78 * syl * (0.35 + 0.65 * gap)) * (0.55 + 0.45 * (w ? w.pulse : 0)) * wobble, 0, 1) * k;
    }
    if (state === 'listening') {
      if (w && w.analyser && w.freq) return clamp(Math.pow(mean(w.freq, 0.5), 1.1) * 2.3, 0, 1) * (0.8 + 0.4 * Math.random());
      return clamp(0.04 + 0.2 * (0.5 + 0.5 * Math.sin(t * 2.2)) * wobble, 0, 1) * k;
    }
    if (state === 'thinking') return 0.06 + 0.08 * (0.5 + 0.5 * Math.sin(t * 4.2));
    return 0;
  };
  /** advance the travelling wave: a new sample enters at the centre (or the left edge) and everything older moves outward */
  RadialRenderer.prototype._tick = function (now, a) {
    const step = this.reduced ? 110 : 52;
    if (now - this._lastTick < step) return;
    this._lastTick = now;
    const h = this.hist;
    for (let k = h.length - 1; k > 0; k--) h[k] = h[k - 1] * 0.985;
    h[0] = a;
  };
  RadialRenderer.prototype._drawLine = function (state, col, glow, cx, y, R, t) {
    const ctx = this.ctx, N = this.LN, c = (N - 1) / 2, wl = this.W * 0.9, stepX = wl / (N - 1), pw = Math.max(3, stepX * 0.6);
    const hb = Math.max(3, R * 0.04), H = R * 0.9, h = this.hist, out = this.flow === 'out';
    if (!this.lite) { ctx.shadowColor = col(glow * 0.9, 0); ctx.shadowBlur = state === 'idle' ? 4 : 12; }
    for (let i = 0; i < N; i++) {
      const k = out ? Math.abs(i - c) : i, v = clamp(h[Math.min(k, h.length - 1)] || 0, 0, 1);
      const x = cx - wl / 2 + i * stepX, edge = Math.abs(i - c) / c;                 // 0 centre … 1 end
      const idle = this.reduced ? 1 : 0.8 + 0.2 * Math.sin(t * 1.4 + i * 0.7), hh = hb + v * H * (1 - 0.35 * edge), a = clamp((0.30 + 0.70 * (1 - Math.pow(edge, 1.7))) * (0.55 + 0.45 * Math.min(1, v * 3 + 0.35)) * (v < 0.05 ? idle : 1), 0.12, 1);
      ctx.fillStyle = col(Math.min(1, a + 0.2), -26 + 12 * edge); ctx.strokeStyle = 'rgba(255,255,255,' + (0.7 * a).toFixed(2) + ')'; ctx.lineWidth = 1;
      const rx = x - pw / 2, ry = y - hh / 2, rr = Math.min(pw, hh) / 2;
      ctx.beginPath(); ctx.moveTo(rx + rr, ry); ctx.lineTo(rx + pw - rr, ry); ctx.arc(rx + pw - rr, ry + rr, rr, -Math.PI / 2, 0); ctx.lineTo(rx + pw, ry + hh - rr);
      ctx.arc(rx + pw - rr, ry + hh - rr, rr, 0, Math.PI / 2); ctx.lineTo(rx + rr, ry + hh); ctx.arc(rx + rr, ry + hh - rr, rr, Math.PI / 2, Math.PI); ctx.lineTo(rx, ry + rr);
      ctx.arc(rx + rr, ry + rr, rr, Math.PI, Math.PI * 1.5); ctx.closePath(); ctx.fill(); ctx.stroke();
    }
    ctx.shadowBlur = 0;
  };
  RadialRenderer.prototype._loop = function (now) {
    if (!this.running) return;
    requestAnimationFrame(this._loop);
    if (document.hidden || !this.canvas.isConnected || !this.canvas.getClientRects().length) { this._lt = 0; return; }      // nothing visible → no work
    if (this._lt) {                                                    // measured fallback: sustained slow frames → cheaper rendering (only when lite:'auto')
      const dt = now - this._lt;
      if (dt < 500) { this._acc = (this._acc || 0) + dt; this._n = (this._n || 0) + 1; if (this._n >= 120) { if (this.auto && !this.lite && this._acc / this._n > 42 && this.onSlow) this.onSlow(); this._acc = 0; this._n = 0; } }
    }
    this._lt = now;
    const w = UI.wave, state = this.sleep ? 'idle' : (w ? w.state : 'idle'), t = (now - this.t0) / 1000, N = this.N, R = this.R, S = this.S, W = this.W, dpr = this.dpr, ctx = this.ctx;
    if (w) {                                              // the panel renderer isn't running in glass mode, so we feed its buffers
      if (w.analyser && w.freq && state === 'listening') w.analyser.getByteFrequencyData(w.freq);
      if (w.outAnalyser && w.outFreq && state === 'speaking') w.outAnalyser.getByteFrequencyData(w.outFreq);
      w.pulse *= 0.94;
    }
    const ease = state === 'speaking' ? 0.14 : state === 'listening' ? 0.38 : 0.2;
    let sum = 0;
    for (let i = 0; i < N; i++) { const tg = clamp(this._targets(i, t, state, w), 0, 1); this.cur[i] += (tg - this.cur[i]) * ease; sum += this.cur[i]; }
    const lvl = sum / N; this.level += (lvl - this.level) * 0.25; this.lastLevel = this.level; if (w) w.lastLevel = this.level;
    // palette per state (hue-rotated blue family)
    const H = this.hue; let h = H, s = 88, l = 62, glow = 0.8;
    if (state === 'speaking') { h = H - 22; l = 70; glow = 0.95; } else if (state === 'listening') { h = H + 2; l = 64; glow = 0.95; } else if (state === 'thinking') { h = H + 8; s = 45; l = 62; glow = 0.55; } else { s = 72; l = 52; glow = 0.45; }
    const col = function (a, dl) { return 'hsla(' + h + ',' + s + '%,' + clamp(l + (dl || 0), 5, 95) + '%,' + a + ')'; };
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, W, S);
    const cx = W / 2, cy = S / 2, breathe = 1 + (this.reduced ? 0 : 0.035 * Math.sin(t * 1.3)) + this.level * 0.16, r = R * breathe;
    // ripples leave the circle with the voice (or gently, as a "tap me" cue while asleep)
    if (!this.reduced) {
      const gap = this.sleep ? 2600 : (320 - this.level * 220);
      if ((this.sleep || (this.visual !== 'line' && (state === 'listening' || state === 'speaking') && this.level > 0.13)) && now - this.lastRip > gap) { this.ripples.push({ b: now, a: this.sleep ? 0.5 : clamp(this.level * 1.6, 0.25, 0.9) }); this.lastRip = now; if (this.ripples.length > 7) this.ripples.shift(); }
    }
    const life = this.sleep ? 3200 : 1900;
    this.ripples = this.ripples.filter(function (p) { return now - p.b < life; });
    ctx.lineWidth = 2;
    for (let q = 0; q < this.ripples.length; q++) {
      const p = this.ripples[q], u = (now - p.b) / life, e = 1 - Math.pow(1 - u, 2.2);
      ctx.strokeStyle = col(p.a * (1 - u) * 0.9, 6); ctx.beginPath(); ctx.arc(cx, cy, r * (1.08 + 0.9 * e), 0, 6.2832); ctx.stroke();
    }
    // core: soft glass sphere
    const g = ctx.createRadialGradient(cx - r * 0.3, cy - r * 0.35, r * 0.1, cx, cy, r);
    g.addColorStop(0, col(0.55, 18)); g.addColorStop(0.55, col(0.22, 0)); g.addColorStop(1, col(0.12, -22));
    if (!this.lite) { ctx.shadowColor = col(glow, 4); ctx.shadowBlur = 18 + this.level * 46; }
    ctx.fillStyle = g; ctx.beginPath(); ctx.arc(cx, cy, r, 0, 6.2832); ctx.fill();
    ctx.shadowBlur = 0;
    ctx.strokeStyle = col(0.7, 14); ctx.lineWidth = 1.6; ctx.beginPath(); ctx.arc(cx, cy, r, 0, 6.2832); ctx.stroke();
    ctx.strokeStyle = 'rgba(255,255,255,.28)'; ctx.lineWidth = 1; ctx.beginPath(); ctx.arc(cx, cy, r - 3, Math.PI * 1.1, Math.PI * 1.65); ctx.stroke();   // glass highlight
    // the travelling line (default visual)
    if (this.visual !== 'radial') { this._tick(now, this.sleep ? 0 : this._amp(state, t, w)); this._drawLine(this.sleep ? 'idle' : state, col, glow, cx, cy + R * 1.72, R, t); }
    if (this.visual === 'line') return;
    // radial bars
    const r0 = r * 1.1, maxL = R * 0.72, bw = Math.max(2, (6.2832 * r0 / N) * 0.52);
    ctx.lineCap = 'round'; ctx.lineWidth = bw;
    if (!this.lite) { ctx.shadowColor = col(glow, 0); ctx.shadowBlur = state === 'idle' ? 3 : 10; }
    const grad = ctx.createLinearGradient(cx, cy - r0 - maxL, cx, cy + r0 + maxL); grad.addColorStop(0, col(0.98, 14)); grad.addColorStop(0.5, col(0.9, 0)); grad.addColorStop(1, col(0.98, 14));
    ctx.strokeStyle = grad;
    for (let i = 0; i < N; i++) {
      const th = (i / N) * 6.2832 - Math.PI / 2, len = 2 + this.cur[i] * maxL, c = Math.cos(th), sn = Math.sin(th);
      ctx.beginPath(); ctx.moveTo(cx + c * r0, cy + sn * r0); ctx.lineTo(cx + c * (r0 + len), cy + sn * (r0 + len)); ctx.stroke();
    }
    ctx.shadowBlur = 0;
  };

  /* =========================================================================
   * 5. VOICE I/O
   *    Two engines behind one interface:
   *      browser   SpeechRecognition (input) + speechSynthesis (output). Free, no server.
   *      deepgram  Nova-3 streaming STT over WebSocket + Aura-2 TTS, both through YOUR server (CONFIG.apiBase).
   *                The Deepgram API key stays on the server. Any failure falls back to the browser engine.
   * ========================================================================= */
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  const TTS = ('speechSynthesis' in window) && typeof window.SpeechSynthesisUtterance === 'function';
  const AC = window.AudioContext || window.webkitAudioContext;

  /* ---- tiny fetch helper for the server routes ---- */
  const Net = {
    url: function (p) { return CONFIG.apiBase + p; },
    req: async function (path, init, ms) {
      const ctl = typeof AbortController === 'function' ? new AbortController() : null;
      const t = setTimeout(function () { ctl && ctl.abort(); }, ms || 8000);
      try {
        const r = await fetch(Net.url(path), Object.assign({ credentials: 'same-origin', signal: ctl && ctl.signal }, init || {}));
        return r;
      } finally { clearTimeout(t); }
    },
    config: async function () {
      const r = await Net.req('/config', { method: 'GET' }, 2500);
      if (!r.ok) throw new Error('config ' + r.status);
      return r.json();
    },
    token: async function (lang) {
      const r = await Net.req('/token', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ lang: lang }) }, 6000);
      if (!r.ok) throw new Error('token ' + r.status);
      return r.json();
    },
    speak: async function (text, lang) {
      const r = await Net.req('/speak', { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: text, lang: lang, voice: (CONFIG.dgVoices && CONFIG.dgVoices[lang]) || '' }) }, 15000);
      if (!r.ok) throw new Error('speak ' + r.status);
      return r.arrayBuffer();
    }
  };

  const WORKLET_SRC =
    'class P extends AudioWorkletProcessor{constructor(){super();this.n=0;this.b=new Int16Array(2048);}' +
    'process(i){var c=i[0]&&i[0][0];if(!c)return true;for(var k=0;k<c.length;k++){var s=Math.max(-1,Math.min(1,c[k]));' +
    'this.b[this.n++]=s<0?s*32768:s*32767;if(this.n===2048){this.port.postMessage(this.b.buffer,[this.b.buffer]);this.b=new Int16Array(2048);this.n=0;}}return true;}}' +
    'registerProcessor("vl-pcm",P);';

  const Voice = {
    engine: 'browser',            // active engine: 'browser' | 'deepgram'
    dgOk: false,                  // server says Deepgram is configured + enabled
    dgBroken: false,              // set after repeated Deepgram failures this session
    dgTtsBroken: 0,
    supportsRecognition: function () { return !!(window.__VL_MOCK_SR || SR) || this.wantDG(); },
    supportsSpeech: function () { return TTS || this.wantDG(); },
    wantDG: function () { return this.engine === 'deepgram' && this.dgOk && !this.dgBroken && !!(AC && navigator.mediaDevices && navigator.mediaDevices.getUserMedia); },

    onFinal: null, onInterim: null, onError: null, onEnd: null, onStart: null, onAudioLevelReady: null, onOutAnalyser: null, onNotice: null,

    // ---- recognition state ----
    _rec: null, _active: false, _restartN: 0, _restartTimer: null, _idleTimer: null,
    _stream: null, _actx: null, _src: null, _analyser: null, _node: null, _mute: null,
    _ws: null, _wsGen: 0, _dgBuf: '', _flushTimer: null, _dgRetry: 0, _usingDG: false, _dgTransport: '',

    isListening: function () { return this._active; },

    /** MUST be called from a user gesture (tap). Resolves true if the mic is live. */
    start: async function () {
      if (this._active) return true;
      this.unlock();
      const useDG = this.wantDG();
      if (!useDG && !(window.__VL_MOCK_SR || SR)) { this.onError && this.onError('unsupported'); return false; }
      this._active = true; this._restartN = 0; this._dgRetry = 0;
      // 1) microphone stream (needed for Deepgram; for the browser engine it only feeds the live waveform)
      if ((useDG || CONFIG.micVisualizer) && navigator.mediaDevices && navigator.mediaDevices.getUserMedia && AC) {
        try {
          this._stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 } });
          if (!this._active) { this._releaseStream(); return false; } // user hit STOP while the permission prompt was open
          this._actx = new AC();
          if (this._actx.state === 'suspended') await this._actx.resume();
          this._src = this._actx.createMediaStreamSource(this._stream);
          this._analyser = this._actx.createAnalyser();
          this._analyser.fftSize = 256; this._analyser.smoothingTimeConstant = 0.75;
          this._src.connect(this._analyser);                      // NOT connected to destination → no feedback
          this.onAudioLevelReady && this.onAudioLevelReady(this._analyser);
        } catch (e) {
          log('mic stream unavailable', e && e.name);
          if (e && (e.name === 'NotAllowedError' || e.name === 'SecurityError' || e.name === 'PermissionDeniedError')) {
            this._active = false; this._releaseStream(); this.onError && this.onError('not-allowed'); return false;
          }
          if (e && e.name === 'NotFoundError') { this._active = false; this._releaseStream(); this.onError && this.onError('no-mic'); return false; }
          if (useDG) this._stream = null;                          // can't stream → fall through to the browser engine
        }
      }
      if (!this._active) return false;
      if (useDG && this._stream) {
        const r = await this._dgStart();
        if (!this._active) return false;
        if (r === true) { this._usingDG = true; this._bumpIdle(); this.onStart && this.onStart(); return true; }
        // Deepgram failed → browser engine for the rest of this session (mic stays live, no second prompt)
        this.dgBroken = true; this.engine = 'browser';
        this.onNotice && this.onNotice('dgFallback');
        if (!(window.__VL_MOCK_SR || SR)) { this._fail('network'); return false; }
      }
      this._usingDG = false;
      this._startRec();
      this._bumpIdle();
      return true;
    },

    /* ----- browser engine ----- */
    _startRec: function () {
      const Ctor = window.__VL_MOCK_SR || SR; const self = this;
      let rec;
      try { rec = new Ctor(); } catch (e) { this._fail('unsupported'); return; }
      rec.lang = SPEECH_LANG; rec.continuous = true; rec.interimResults = true; rec.maxAlternatives = 1;
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

    /* ----- Deepgram engine (streaming STT) ----- */
    _dgLang: function () {
      const c = String(SPEECH_LANG || '').toLowerCase();
      if (LANG === 'es') return /^es-(mx|ar|co|cl|pe|ve|ec|uy|py|bo|cr|pa|do|gt|hn|ni|sv|cu|pr|us|419)$/.test(c) ? 'es-419' : 'es';
      return 'en';
    },
    _dgStart: async function () {
      const self = this, gen = ++this._wsGen;
      let tk;
      try { tk = await Net.token(LANG); } catch (e) { log('token failed', e && e.message); return false; }
      if (!this._active || gen !== this._wsGen) return 'aborted';
      const rate = Math.round(this._actx.sampleRate);
      const q = 'model=nova-3&language=' + encodeURIComponent(this._dgLang()) + '&interim_results=true&smart_format=true&punctuate=true' +
        '&endpointing=300&utterance_end_ms=1000&vad_events=true&encoding=linear16&sample_rate=' + rate + '&channels=1';
      const attempts = [];
      const mode = CONFIG.dgTransport || 'auto';
      if (tk.listenUrl && tk.token && mode !== 'proxy') attempts.push({ kind: 'direct', url: tk.listenUrl + (tk.listenUrl.indexOf('?') > 0 ? '&' : '?') + q, protocols: ['bearer', tk.token] });
      if (tk.proxy !== false && mode !== 'direct') {
        const base = Net.url('/listen');
        const abs = /^https?:/i.test(base) ? base : (location.origin + (base.charAt(0) === '/' ? '' : '/') + base);
        attempts.push({ kind: 'proxy', url: abs.replace(/^http/i, 'ws') + '?' + q, protocols: [] });
      }
      for (let i = 0; i < attempts.length; i++) {
        const ws = await this._dgOpen(attempts[i], gen);
        if (!this._active || gen !== this._wsGen) { try { ws && ws.close(); } catch (e) {} return 'aborted'; }
        if (ws) {
          this._ws = ws; this._dgTransport = attempts[i].kind; this._dgBuf = '';
          this._bindDG(ws, gen);
          if (!(await this._startPcm(ws))) { try { ws.close(); } catch (e) {} this._ws = null; return false; }
          return true;
        }
        log('deepgram transport failed:', attempts[i].kind);
      }
      return false;
    },
    _dgOpen: function (a, gen) {
      return new Promise(function (resolve) {
        let ws, settled = false;
        const fin = function (v) { if (settled) return; settled = true; clearTimeout(timer); resolve(v); };
        const timer = setTimeout(function () { try { ws && ws.close(); } catch (e) {} fin(null); }, 6000);
        try { ws = a.protocols.length ? new WebSocket(a.url, a.protocols) : new WebSocket(a.url); } catch (e) { return fin(null); }
        ws.binaryType = 'arraybuffer';
        ws.onopen = function () { fin(ws); };
        ws.onerror = function () { fin(null); };
        ws.onclose = function () { fin(null); };
      });
    },
    _bindDG: function (ws, gen) {
      const self = this;
      ws.onmessage = function (ev) {
        if (typeof ev.data !== 'string') return;
        let m; try { m = JSON.parse(ev.data); } catch (e) { return; }
        if (m.type === 'Results') {
          const alt = m.channel && m.channel.alternatives && m.channel.alternatives[0];
          const txt = alt ? clean(alt.transcript || '') : '';
          if (m.is_final) {
            if (txt) { self._dgBuf = clean(self._dgBuf + ' ' + txt); self._bumpIdle(); self._dgRetry = 0; }
            self.onInterim && self.onInterim(self._dgBuf);
            if (m.speech_final) self._dgFlush(); else self._armFlush();
          } else if (txt) {
            self._bumpIdle();
            self.onInterim && self.onInterim(clean(self._dgBuf + ' ' + txt));
          }
        } else if (m.type === 'UtteranceEnd') { self._dgFlush(); }
      };
      ws.onclose = function () {
        if (self._ws !== ws) return;
        self._ws = null; self._stopPcm();
        if (!self._active || gen !== self._wsGen) return;
        // unexpected drop while listening → reconnect (new token) up to 3 times, then fall back
        if (++self._dgRetry > 3) { self.dgBroken = true; self.engine = 'browser'; self.onNotice && self.onNotice('dgFallback'); return self._fail('network'); }
        setTimeout(async function () {
          if (!self._active) return;
          const r = await self._dgStart();
          if (r !== true && self._active) { self.dgBroken = true; self.engine = 'browser'; self.onNotice && self.onNotice('dgFallback'); self._fail('network'); }
        }, 300 * self._dgRetry);
      };
      ws.onerror = function () { /* onclose follows */ };
    },
    _armFlush: function () { const self = this; clearTimeout(this._flushTimer); this._flushTimer = setTimeout(function () { self._dgFlush(); }, 1500); },
    _dgFlush: function () {
      clearTimeout(this._flushTimer);
      const t = clean(this._dgBuf); this._dgBuf = '';
      if (t) { this.onInterim && this.onInterim(''); this.onFinal && this.onFinal(t); }
    },
    /** capture mic → 16-bit PCM → WebSocket. AudioWorklet where allowed (blob: scripts), else ScriptProcessor. */
    _startPcm: async function (ws) {
      const ctx = this._actx, self = this;
      const send = function (buf) { if (ws.readyState === 1 && ws.bufferedAmount < 1 << 20) ws.send(buf); };
      const mute = this._mute = ctx.createGain(); mute.gain.value = 0; mute.connect(ctx.destination);
      try {
        if (!ctx.audioWorklet || !window.Blob || !URL.createObjectURL) throw new Error('no worklet');
        const url = URL.createObjectURL(new Blob([WORKLET_SRC], { type: 'application/javascript' }));
        try { await ctx.audioWorklet.addModule(url); } finally { URL.revokeObjectURL(url); }
        const node = this._node = new AudioWorkletNode(ctx, 'vl-pcm', { numberOfInputs: 1, numberOfOutputs: 1, channelCount: 1 });
        node.port.onmessage = function (e) { send(e.data); };
        this._src.connect(node); node.connect(mute);
        return true;
      } catch (e) {
        log('worklet unavailable, using ScriptProcessor', e && e.message);
        try {
          const node = this._node = ctx.createScriptProcessor(4096, 1, 1);
          node.onaudioprocess = function (e) {
            const c = e.inputBuffer.getChannelData(0), o = new Int16Array(c.length);
            for (let k = 0; k < c.length; k++) { const s = Math.max(-1, Math.min(1, c[k])); o[k] = s < 0 ? s * 32768 : s * 32767; }
            send(o.buffer);
          };
          this._src.connect(node); node.connect(mute);
          return true;
        } catch (e2) { log('no audio capture path', e2 && e2.message); return false; }
      }
    },
    _stopPcm: function () {
      try { if (this._node) { this._node.port && (this._node.port.onmessage = null); this._node.onaudioprocess = null; this._node.disconnect(); } } catch (e) {}
      try { this._mute && this._mute.disconnect(); } catch (e) {}
      this._node = this._mute = null;
    },

    _fail: function (code) { this.stop(); this.onError && this.onError(code); },

    _bumpIdle: function () {
      const self = this; clearTimeout(this._idleTimer);
      this._idleTimer = setTimeout(function () { if (self._active) { self.stop(); self.onError && self.onError('idle-timeout'); } }, CONFIG.listenIdleTimeoutMs);
    },

    _releaseStream: function () {
      this._stopPcm();
      try { this._src && this._src.disconnect(); } catch (e) {}
      if (this._stream) this._stream.getTracks().forEach(function (t) { try { t.stop(); } catch (e) {} });
      try { this._actx && this._actx.state !== 'closed' && this._actx.close(); } catch (e) {}
      this._stream = this._actx = this._src = this._analyser = null;
    },

    /** stop listening and RELEASE the microphone (and close any Deepgram socket) */
    stop: function () {
      const was = this._active;
      this._active = false; this._netErr = 0; this._wsGen++; this._usingDG = false;
      clearTimeout(this._restartTimer); clearTimeout(this._idleTimer); clearTimeout(this._flushTimer);
      const rec = this._rec; this._rec = null;
      if (rec) { rec.onend = rec.onerror = rec.onresult = null; try { rec.abort ? rec.abort() : rec.stop(); } catch (e) {} }
      const ws = this._ws; this._ws = null;
      if (ws) { ws.onclose = ws.onmessage = ws.onerror = null; try { if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'CloseStream' })); ws.close(); } catch (e) {} }
      this._dgBuf = '';
      this._releaseStream();
      if (was) this.onEnd && this.onEnd();
    },

    /* ======================= output (speech) ======================= */
    _voice: null, _speaking: false, _genSpeak: 0, _keepAlive: null,
    _octx: null, _oan: null, _osrc: null,
    onSpeakStart: null, onSpeakEnd: null, onBoundary: null,

    /** call from a user gesture: lets Web Audio output start later without an autoplay block */
    unlock: function () {
      if (!AC || !this.wantDG()) return;
      try {
        if (!this._octx || this._octx.state === 'closed') {
          this._octx = new AC();
          this._oan = this._octx.createAnalyser(); this._oan.fftSize = 256; this._oan.smoothingTimeConstant = 0.8;
          this._oan.connect(this._octx.destination);
        }
        if (this._octx.state === 'suspended') this._octx.resume();
      } catch (e) { log('audio output unlock failed', e && e.message); }
    },

    pickVoice: function () {
      if (!TTS) return null;
      const vs = speechSynthesis.getVoices(); if (!vs.length) return null;
      if (CONFIG.voiceName) { const v = vs.find(function (x) { return x.name === CONFIG.voiceName; }); if (v) return v; }
      const lang = SPEECH_LANG.toLowerCase(), base = lang.split('-')[0];
      const cands = vs.filter(function (v) { return v.lang && v.lang.toLowerCase().replace('_', '-').indexOf(base) === 0; });
      const exact = cands.filter(function (v) { return v.lang.toLowerCase().replace('_', '-') === lang; });
      const pool = exact.length ? exact : cands;
      // gender: browsers don't publish it, so match well-known voice names (this is a best-effort heuristic, not a guarantee)
      const FEM = /female|woman|samantha|victoria|karen|moira|tessa|fiona|allison|ava|susan|zira|hazel|aria|jenny|libby|sonia|michelle|emma|ana\b|monica|paulina|helena|laura|sabina|elvira|dalia|elena|salome|catalina|mia\b|isabella|lucia|marisol|paloma|camila|natasha|clara|sara\b|microsoft (aria|jenny|zira|sonia|libby|hazel|ana|elvira|dalia|helena|laura|sabina|salome|catalina|elena|paloma|camila|lucia|marisol)|google (uk english female|us english)|siri.*female/i;
      const MAL = /\bmale\b|\bman\b|daniel|alex\b|fred\b|david|mark\b|george|james|ryan|guy\b|davis|christopher|eric\b|roger|steffan|jorge|diego|juan|pablo|raul|alvaro|jaime|arnau|tomas|enrique|ricardo|google uk english male/i;
      const NICE = /natural|neural|online|enhanced|premium|google|samantha|monica|paulina/i, g = CONFIG.voiceGender;
      const rankV = function (v) {
        let sc = 0;
        if (g === 'female') { if (MAL.test(v.name) && !/female/i.test(v.name)) sc -= 6; if (FEM.test(v.name)) sc += 6; }
        else if (g === 'male') { if (FEM.test(v.name)) sc -= 6; if (MAL.test(v.name)) sc += 6; }
        if (NICE.test(v.name)) sc += 2;
        if (v.localService === false && /natural|neural|online/i.test(v.name)) sc += 1;
        return sc;
      };
      let best = null, bs = -99;
      pool.forEach(function (v) { const sc = rankV(v); if (sc > bs) { bs = sc; best = v; } });
      return best;
    },

    /** split into sentence-sized chunks — long utterances silently die in Chrome (~15s bug) */
    _chunks: function (text, max) {
      max = max || 170;
      const parts = clean(text).match(/[^.!?;:\n]+[.!?;:]*\s*/g) || [clean(text)];
      const out = []; let cur = '';
      parts.forEach(function (p) {
        if ((cur + p).length > max && cur) { out.push(cur.trim()); cur = p; } else cur += p;
      });
      if (cur.trim()) out.push(cur.trim());
      return out.filter(Boolean);
    },

    speak: function (text) {
      if (!CONFIG.speak || !clean(text)) return Promise.resolve(false);
      const gen = ++this._genSpeak;
      this._stopOut();
      if (this.wantDG() && this.dgTtsBroken < 2 && this._octx) return this._speakDG(text, gen);
      return this._speakBrowser(text, gen);
    },

    _stopOut: function () {
      try { TTS && speechSynthesis.cancel(); } catch (e) {}
      if (this._osrc) { try { this._osrc.onended = null; this._osrc.stop(); } catch (e) {} this._osrc = null; }
      clearInterval(this._keepAlive); this._keepAlive = null;
    },

    /** Deepgram Aura-2 via the server. Sentences are fetched one ahead of playback. Falls back to browser TTS. */
    _speakDG: function (text, gen) {
      const self = this, ctx = this._octx, chunks = this._chunks(text, 260);
      this._speaking = true;
      const ended = function () { if (self._genSpeak === gen) { self._speaking = false; self.onOutAnalyser && self.onOutAnalyser(null); self.onSpeakEnd && self.onSpeakEnd(); } };
      const fetchBuf = function (t) {
        return Net.speak(t, LANG).then(function (ab) {
          return new Promise(function (res, rej) { try { const p = ctx.decodeAudioData(ab, res, rej); p && p.then && p.then(res, rej); } catch (e) { rej(e); } });
        });
      };
      return (async function () {
        try {
          if (ctx.state !== 'running') { try { await Promise.race([ctx.resume(), sleep(500)]); } catch (e) {} }
          if (ctx.state !== 'running') throw new Error('audio output blocked');
          let next = fetchBuf(chunks[0]), started = false;
          for (let i = 0; i < chunks.length; i++) {
            const buf = await next;
            if (self._genSpeak !== gen) return false;                 // cancelled / superseded
            if (i + 1 < chunks.length) { next = fetchBuf(chunks[i + 1]); next.catch(function () {}); }
            await new Promise(function (resolve) {
              const src = ctx.createBufferSource(); src.buffer = buf; src.connect(self._oan);
              self._osrc = src; src.onended = function () { if (self._osrc === src) self._osrc = null; resolve(); };
              if (!started) { started = true; self.onOutAnalyser && self.onOutAnalyser(self._oan); self.onSpeakStart && self.onSpeakStart(); }
              src.start();
            });
          }
          self.dgTtsBroken = 0;
          ended(); return true;
        } catch (e) {
          log('deepgram tts failed → browser voice', e && e.message);
          if (self._genSpeak !== gen) return false;
          self.dgTtsBroken++;
          self.onOutAnalyser && self.onOutAnalyser(null);
          return self._speakBrowser(text, gen);
        }
      })();
    },

    /** browser speechSynthesis. onSpeakStart fires when the first audio chunk actually starts (or after a 1.2s fallback). */
    _speakBrowser: function (text, gen) {
      const self = this;
      if (!TTS) { this._speaking = false; return Promise.resolve(false); }
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
          u.lang = SPEECH_LANG; u.rate = CONFIG.speechRate; u.pitch = CONFIG.speechPitch;
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
      this._stopOut();
      this.onOutAnalyser && this.onOutAnalyser(null);
      if (this._speaking) { this._speaking = false; this.onSpeakEnd && this.onSpeakEnd(); }
    },
    isSpeaking: function () { return this._speaking; },
    resetVoice: function () { this._voice = null; }
  };
  if (TTS) { try { speechSynthesis.onvoiceschanged = function () { Voice._voice = null; }; } catch (e) {} }

  /* =========================================================================
   * 6. UI — everything lives in a Shadow DOM so host CSS can't break us and we can't break the host.
   *    The host page DOM is never modified (highlight rings are overlays inside our own shadow root).
   *    Modes:  on (orb)  ·  min (small edge tab)  ·  off (nothing visible; bring back with link / hotkey / ?voicelayer=on)
   * ========================================================================= */
  const ICON = {
    mic: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/></svg>',
    close: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>',
    minus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M6 17h12"/></svg>',
    pause: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><path d="M9 6v12M15 6v12"/></svg>',
    vol: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 9v6h4l5 4V5L8 9H4z"/><path d="M16.5 8.5a5 5 0 0 1 0 7M19 6a8.5 8.5 0 0 1 0 12"/></svg>',
    mute: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 9v6h4l5 4V5L8 9H4z"/><path d="M17 9l5 6M22 9l-5 6"/></svg>'
  };
  const MOBILE_MQ = '(max-width: 600px)';

  const UI = {
    h: {},                 // handlers set by controller
    host: null, root: null, shadow: null,
    orb: null, tab: null, panel: null, wave: null, canvas: null, captions: null, interim: null, stateChip: null,
    input: null, micBtn: null, muteBtn: null, layer: null, bubble: null, toast: null,
    open: false, mode: 'on', pos: { fx: 1, fy: 1 }, _suppressUntil: 0, rings: [], _ringRaf: 0, forced: null,
    _muted: false, _listening: false, _micAvail: true, _micReason: '', _engine: 'browser', _state: 'idle',

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

      // stylesheet inside the shadow root (works from file:// too, unlike fetch())
      const link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = CONFIG.cssUrl || ((SCRIPT && SCRIPT.src) ? SCRIPT.src.replace(/[^\/?#]*(\?.*)?(#.*)?$/, '') + 'voicelayer.css' : 'voicelayer.css');
      sh.appendChild(link);

      const root = this.root = document.createElement('div');
      root.className = 'vl-root'; root.setAttribute('data-state', 'idle'); root.setAttribute('data-open', 'false'); root.setAttribute('data-mode', 'on');
      if (CONFIG.debug) root.setAttribute('data-debug', 'true');
      const G = CONFIG.mode === 'glass'; this.isGlass = G;
      root.setAttribute('data-ui', G ? 'glass' : 'assistant');
      if (G) {
        root.style.setProperty('--vl-blur', clamp(Number(CONFIG.glass.blur) || 0, 0, 40) + 'px');
        root.style.setProperty('--vl-tint', String(clamp(Number(CONFIG.glass.tint) || 0, 0, 0.6)));
        root.setAttribute('data-pass', CONFIG.glass.passThrough === false ? 'false' : 'true');
        if (CONFIG.glass.dock === 'top') {
          const frac = clamp(Number(CONFIG.glass.height) || 0.42, 0.25, 0.6);
          root.setAttribute('data-dock', 'top');
          root.style.setProperty('--vl-dock-h', frac * 100 + 'vh');
          root.style.setProperty('--vl-dock-scale', String(frac));
        }
      }
      const GLASS_HTML = !G ? '' :
        '<section class="vl-glass" id="vl-glass" role="dialog" aria-modal="false" data-awake="false" data-mic="off" data-card="false">' +
          '<div class="vl-g-pane" aria-hidden="true"></div>' +
          '<div class="vl-g-ui">' +
            '<header class="vl-g-top">' +
              '<span class="vl-g-badge" id="vl-g-demo" hidden></span><span class="vl-spacer"></span>' +
              '<span class="vl-g-chip vl-g-micchip" id="vl-g-mic" role="status" aria-live="polite"><i></i><span id="vl-g-mictxt"></span></span>' +
              '<span class="vl-g-chip vl-g-statechip" id="vl-g-state" role="status"></span>' +
              '<button class="vl-g-ib" type="button" id="vl-g-mute" aria-pressed="false">' + ICON.vol + '</button>' +
              '<span class="vl-lang" id="vl-g-lang" role="group"></span>' +
              '<button class="vl-g-ib" type="button" id="vl-g-pause">' + ICON.pause + '</button>' +
              '<button class="vl-g-ib" type="button" id="vl-g-x">' + ICON.close + '</button>' +
            '</header>' +
            '<main class="vl-g-stage">' +
              '<button class="vl-g-circle" type="button" id="vl-g-circle"><canvas id="vl-g-canvas" aria-hidden="true"></canvas></button>' +
              '<div class="vl-g-tap" id="vl-g-tap"><strong id="vl-g-tap1"></strong><span id="vl-g-tap2"></span></div>' +
              '<p class="vl-g-hint" id="vl-g-hint"></p>' +
            '</main>' +
            '<footer class="vl-g-bottom">' +
              '<p class="vl-g-user" id="vl-g-user"></p><p class="vl-g-interim" id="vl-g-interim" aria-hidden="true"></p>' +
              '<p class="vl-g-line" id="vl-g-line" role="log" aria-live="polite"></p>' +
              '<article class="vl-g-card" id="vl-g-card" hidden>' +
                '<header class="vl-g-chead"><span class="vl-g-kind" id="vl-g-kind"></span><span class="vl-g-n" id="vl-g-n"></span></header>' +
                '<p class="vl-g-ctext" id="vl-g-ctext"></p>' +
                '<p class="vl-g-because" id="vl-g-because" hidden></p>' +
                '<p class="vl-g-rx" id="vl-g-rx" hidden></p>' +
                '<div class="vl-g-offer" id="vl-g-offer" hidden><p class="vl-g-oname" id="vl-g-oname"></p><p class="vl-g-disc" id="vl-g-disc"></p>' +
                  '<div class="vl-g-row" id="vl-g-orow"><button class="vl-g-btn primary" type="button" id="vl-g-yes"></button><button class="vl-g-btn" type="button" id="vl-g-no"></button></div></div>' +
                '<div class="vl-g-row" id="vl-g-actions"><button class="vl-g-btn" type="button" id="vl-g-why"></button><button class="vl-g-btn" type="button" id="vl-g-next"></button></div>' +
              '</article>' +
              '<form class="vl-g-form" id="vl-g-form" autocomplete="off"><input class="vl-input" id="vl-g-input" type="text" enterkeyhint="send" /><button class="vl-send" type="submit" id="vl-g-send"></button></form>' +
              '<div class="vl-g-ctrl"><button class="vl-g-stop" type="button" id="vl-g-stop"></button><button class="vl-off" type="button" id="vl-g-off"></button></div>' +
            '</footer>' +
          '</div>' +
        '</section>';
      root.innerHTML =
        '<div class="vl-layer" id="vl-layer"></div>' + GLASS_HTML +
        '<button class="vl-orb" type="button" id="vl-orb" aria-haspopup="dialog" aria-expanded="false">' + ICON.mic + '</button>' +
        '<button class="vl-tab" type="button" id="vl-tab">' + ICON.mic + '</button>' +
        '<div class="vl-bubble" id="vl-bubble" role="status" aria-live="polite">' +
          '<button class="vl-bubble-main" type="button" id="vl-bubble-main"></button>' +
          '<button class="vl-bubble-x" type="button" id="vl-bubble-x">' + ICON.close + '</button>' +
        '</div>' +
        '<section class="vl-panel" id="vl-panel" role="dialog" tabindex="-1">' +
          '<header class="vl-head">' +
            '<span class="vl-title" id="vl-title"></span>' +
            '<span class="vl-state" id="vl-state" role="status" aria-live="polite"></span>' +
            '<span class="vl-spacer"></span>' +
            '<button class="vl-iconbtn" type="button" id="vl-mute" aria-pressed="false">' + ICON.vol + '</button>' +
            '<button class="vl-iconbtn" type="button" id="vl-min">' + ICON.minus + '</button>' +
            '<button class="vl-iconbtn" type="button" id="vl-close">' + ICON.close + '</button>' +
          '</header>' +
          '<canvas class="vl-wave" id="vl-wave" aria-hidden="true"></canvas>' +
          '<div class="vl-captions" id="vl-captions" role="log" aria-live="polite"></div>' +
          '<div class="vl-interim" id="vl-interim" aria-hidden="true"></div>' +
          '<form class="vl-form" id="vl-form" autocomplete="off">' +
            '<input class="vl-input" id="vl-input" type="text" enterkeyhint="send" />' +
            '<button class="vl-send" type="submit" id="vl-send"></button>' +
          '</form>' +
          '<div class="vl-controls">' +
            '<button class="vl-mic" type="button" id="vl-mic" aria-pressed="false">' + ICON.mic + '<span id="vl-mictxt"></span></button>' +
            '<button class="vl-stop" type="button" id="vl-stop"></button>' +
          '</div>' +
          '<p class="vl-note" id="vl-note"></p>' +
          '<div class="vl-foot">' +
            '<span class="vl-lang" id="vl-lang" role="group"></span>' +
            '<button class="vl-off" type="button" id="vl-off"></button>' +
          '</div>' +
          '<div class="vl-debug" id="vl-debug"><span>force state:</span>' +
            STATES.map(function (s) { return '<button type="button" data-force="' + s + '" aria-pressed="false">' + s + '</button>'; }).join('') +
            '<button type="button" data-force="auto" aria-pressed="false">auto</button></div>' +
        '</section>' +
        '<div class="vl-toast" id="vl-toast" role="status" aria-live="polite"></div>';
      sh.appendChild(root);

      const $ = function (id) { return sh.getElementById ? sh.getElementById(id) : root.querySelector('#' + id); };
      this.$ = $;
      this.orb = $('vl-orb'); this.tab = $('vl-tab'); this.panel = $('vl-panel'); this.canvas = $('vl-wave'); this.captions = $('vl-captions');
      this.interim = $('vl-interim'); this.stateChip = $('vl-state'); this.input = $('vl-input'); this.micBtn = $('vl-mic');
      this.muteBtn = $('vl-mute'); this.layer = $('vl-layer'); this.micTxt = $('vl-mictxt'); this.bubble = $('vl-bubble'); this.toast = $('vl-toast');
      this.minBtn = $('vl-min'); this.offBtn = $('vl-off'); this.langBox = $('vl-lang'); this.note = $('vl-note');
      this.minBtn.hidden = !CONFIG.allowMinimize; this.offBtn.hidden = !CONFIG.allowTurnOff;
      this.langBoxes = [this.langBox];
      if (G) {
        this.glass = $('vl-g-glass') || $('vl-glass'); this.gcircle = $('vl-g-circle'); this.gcanvas = $('vl-g-canvas'); this.gcard = $('vl-g-card');
        this.gline = $('vl-g-line'); this.guser = $('vl-g-user'); this.ginterim = $('vl-g-interim'); this.gstate = $('vl-g-state'); this.gmic = $('vl-g-mic');
        this.gmictxt = $('vl-g-mictxt'); this.ghint = $('vl-g-hint'); this.gmute = $('vl-g-mute'); this.goff = $('vl-g-off'); this.ginput = $('vl-g-input');
        this.langBoxes.push($('vl-g-lang'));
        this.goff.hidden = !CONFIG.allowTurnOff;
      }

      const mount = function () {
        (document.body || document.documentElement).appendChild(host);
        self.wave = new WaveformRenderer(self.canvas);
        if (G) {
          self.radial = new RadialRenderer(self.gcanvas);
          self.radial.onSlow = function () { self.setLite(true); };
          self.setLite(self.liteWanted(), true);
          self.radial.sleep = true; self.radial.start();       // the panel waveform stays idle: the circle is the visual
        } else self.wave.start();
      };
      if (document.body) mount(); else document.addEventListener('DOMContentLoaded', mount);

      const ready = function () { root.classList.add('vl-ready'); self.placeOrb(); self.wave && self.wave.resize(); self.radial && self.radial.resize(); };
      link.addEventListener('load', ready);
      link.addEventListener('error', function () { console.warn('[VoiceLayer] could not load voicelayer.css from', link.href); ready(); });
      setTimeout(function () { if (!root.classList.contains('vl-ready')) ready(); }, 3000);

      // --- initial position (corner + offsets, or remembered position) ---
      const saved = CONFIG.rememberPosition && store.get(KEYS.pos);
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
          if (CONFIG.rememberPosition) store.set(KEYS.pos, JSON.stringify(self.pos));
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
      this.minBtn.addEventListener('click', function () { self.h.onMinimize && self.h.onMinimize(); });
      this.offBtn.addEventListener('click', function () { self.h.onTurnOff && self.h.onTurnOff(); });
      this.tab.addEventListener('click', function () { self.h.onRestore && self.h.onRestore(); });
      $('vl-stop').addEventListener('click', function () { self.h.onStop && self.h.onStop(); });
      this.micBtn.addEventListener('click', function () { self.h.onMic && self.h.onMic(); });
      this.muteBtn.addEventListener('click', function () { self.h.onMute && self.h.onMute(); });
      $('vl-bubble-main').addEventListener('click', function () { self.h.onBubble && self.h.onBubble(); });
      $('vl-bubble-x').addEventListener('click', function () { self.h.onBubbleDismiss && self.h.onBubbleDismiss(); });
      $('vl-form').addEventListener('submit', function (e) {
        e.preventDefault(); const v = self.input.value; self.input.value = '';
        if (clean(v)) self.h.onSubmit && self.h.onSubmit(v);
      });
      this.panel.addEventListener('keydown', function (e) {
        if (e.key === 'Escape') { e.stopPropagation(); self.h.onClose && self.h.onClose(); }
      });
      this.bubble.addEventListener('keydown', function (e) { if (e.key === 'Escape') { e.stopPropagation(); self.h.onBubbleDismiss && self.h.onBubbleDismiss(); } });
      qsa('[data-force]', root).forEach(function (b) {
        b.addEventListener('click', function () { self.h.onForce && self.h.onForce(b.getAttribute('data-force')); });
      });

      if (G) {
        this.gcircle.addEventListener('click', function () { self.h.onCircle && self.h.onCircle(); });
        $('vl-g-pause').addEventListener('click', function () { self.h.onPause && self.h.onPause(); });
        $('vl-g-x').addEventListener('click', function () { self.h.onClose && self.h.onClose(); });
        $('vl-g-stop').addEventListener('click', function () { self.h.onStop && self.h.onStop(); });
        this.gmute.addEventListener('click', function () { self.h.onMute && self.h.onMute(); });
        this.goff.addEventListener('click', function () { self.h.onTurnOff && self.h.onTurnOff(); });
        $('vl-g-why').addEventListener('click', function () { self.h.onAct && self.h.onAct('why'); });
        $('vl-g-next').addEventListener('click', function () { self.h.onAct && self.h.onAct('next'); });
        $('vl-g-yes').addEventListener('click', function () { self.h.onAct && self.h.onAct('yes'); });
        $('vl-g-no').addEventListener('click', function () { self.h.onAct && self.h.onAct('no'); });
        $('vl-g-form').addEventListener('submit', function (e) {
          e.preventDefault(); const v = self.ginput.value; self.ginput.value = '';
          if (clean(v)) self.h.onSubmit && self.h.onSubmit(v);
        });
      }
      window.addEventListener('resize', function () { self.placeOrb(); if (self.open) self.positionPanel(); self.wave && self.wave.resize(); self.radial && self.radial.resize(); self._updateRings(); });
      this.buildLangSwitch();
      this.applyText();
    },

    /** (re)apply every user-facing string for the current language */
    applyText: function () {
      const T = UIs();
      this.T = T;
      this.host.setAttribute('lang', LANG);
      this.orb.setAttribute('aria-label', T.openLabel);
      this.tab.setAttribute('aria-label', T.restoreTab); this.tab.title = T.restoreTab;
      this.panel.setAttribute('aria-label', T.title);
      this.$('vl-title').textContent = T.title;
      this.minBtn.setAttribute('aria-label', T.minimize); this.minBtn.title = T.minimize;
      this.$('vl-close').setAttribute('aria-label', T.closeLabel); this.$('vl-close').title = T.closeLabel;
      this.captions.setAttribute('aria-label', T.convo);
      this.input.setAttribute('aria-label', T.typeLabel); this.input.placeholder = T.placeholder;
      this.$('vl-send').textContent = T.send;
      this.$('vl-stop').textContent = T.stop; this.$('vl-stop').setAttribute('aria-label', T.stopAll);
      this.offBtn.textContent = T.turnOff;
      this.$('vl-bubble-x').setAttribute('aria-label', T.dismiss);
      this.langBox.setAttribute('aria-label', T.lang);
      qsa('[data-lang]', this.root).forEach(function (b) { b.setAttribute('aria-pressed', String(b.getAttribute('data-lang') === LANG)); });
      if (this.isGlass) {
        const $ = this.$;
        this.glass.setAttribute('aria-label', T.gGlassLabel);
        this.gcircle.setAttribute('aria-label', T.gCircleLabel);
        $('vl-g-tap1').textContent = T.gTap; $('vl-g-tap2').textContent = T.gTapSub;
        $('vl-g-pause').setAttribute('aria-label', T.gPause); $('vl-g-pause').title = T.gPause;
        $('vl-g-x').setAttribute('aria-label', T.gClose); $('vl-g-x').title = T.gClose;
        $('vl-g-stop').textContent = T.stop; $('vl-g-stop').setAttribute('aria-label', T.stopAll);
        this.goff.textContent = T.turnOff; this.goff.setAttribute('aria-label', T.gOffTxt);
        this.ginput.setAttribute('aria-label', T.typeLabel); this.ginput.placeholder = T.gTypeHere; $('vl-g-send').textContent = T.send;
        $('vl-g-why').textContent = T.gWhy; $('vl-g-next').textContent = T.gNext; $('vl-g-yes').textContent = T.gShow; $('vl-g-no').textContent = T.gNotNow;
        $('vl-g-demo').textContent = T.gDemo;
        this.gcard.setAttribute('aria-label', T.gSuggest);
      }
      this.setState(this._state);
      this.setMuteUI(this._muted);
      this.setMicUI(this._listening, this._micAvail, this._micReason);
      this.setEngine(this._engine);
      if (this.open) this.positionPanel();
      this.updateHint();
    },
    buildLangSwitch: function () {
      const self = this;
      const list = (CONFIG.languages || []).filter(function (c) { return PACKS[c]; });
      this.langBoxes.forEach(function (box) {
        box.innerHTML = '';
        box.hidden = !(CONFIG.showLangSwitch && list.length > 1);
        list.forEach(function (c) {
          const b = document.createElement('button');
          b.type = 'button'; b.className = 'vl-langbtn'; b.setAttribute('data-lang', c);
          b.textContent = PACKS[c].short; b.title = PACKS[c].name; b.setAttribute('lang', c);
          b.setAttribute('aria-pressed', String(c === LANG));
          b.addEventListener('click', function () { self.h.onLang && self.h.onLang(c); });
          box.appendChild(b);
        });
      });
    },

    /* ---------------- glass mode ---------------- */
    liteWanted: function () {
      const g = CONFIG.glass.lite;
      if (g === true || g === 'true') return true;
      if (g === false || g === 'false') return false;
      const noBlur = !(window.CSS && CSS.supports && (CSS.supports('backdrop-filter', 'blur(1px)') || CSS.supports('-webkit-backdrop-filter', 'blur(1px)')));
      return noBlur || (navigator.hardwareConcurrency && navigator.hardwareConcurrency <= 2) || (navigator.deviceMemory && navigator.deviceMemory <= 1) || false;
    },
    setLite: function (on, initial) {
      this.root.setAttribute('data-lite', on ? 'true' : 'false');
      if (this.radial) { this.radial.configure({ lite: on, auto: CONFIG.glass.lite === 'auto', hue: CONFIG.glass.hue, visual: CONFIG.glass.visual, flow: CONFIG.glass.flow }); this.radial.resize(); }
      if (!initial) log('glass: switched to lite rendering');
    },
    /** awake = the visitor tapped the circle (the assistant may speak and the mic may be used). asleep = "tap to start". */
    setAwake: function (on) {
      if (!this.isGlass) return;
      this.glass.setAttribute('data-awake', on ? 'true' : 'false');
      if (this.radial) this.radial.sleep = !on;
      this.updateHint();
    },
    setDemo: function (on) { if (this.isGlass) { this.$('vl-g-demo').hidden = !on; } },
    updateHint: function () {
      if (!this.isGlass) return;
      const T = this.T || I.ui, awake = this.glass.getAttribute('data-awake') === 'true';
      this.ghint.textContent = !awake ? '' : (this._listening ? T.states.listening : (this._state === 'idle' ? T.gTapMic : ''));
    },
    setLine: function (kind, text) {
      if (!this.isGlass) return;
      if (kind === 'user') { this.guser.textContent = text; return; }
      this.guser.textContent = ''; this.gline.textContent = text; this.gline.setAttribute('data-kind', kind);
    },
    showCard: function (ins, i, n) {
      if (!this.isGlass) return;
      const T = this.T || I.ui, $ = this.$;
      this.gcard.hidden = false; this.gcard.setAttribute('data-kind', ins.kind);
      $('vl-g-kind').textContent = ins.kind === 'reminder' ? T.gKindReminder : ins.kind === 'praise' ? T.gKindPraise : T.gKindData;
      $('vl-g-n').textContent = n > 1 ? (i + 1) + ' / ' + n : '';
      $('vl-g-ctext').textContent = ins.text;
      $('vl-g-because').hidden = true; $('vl-g-rx').hidden = true; $('vl-g-offer').hidden = true;
      $('vl-g-next').hidden = !(i + 1 < n);
      $('vl-g-why').hidden = false; $('vl-g-actions').hidden = false;
      this.glass.setAttribute('data-card', 'true');
    },
    hideCard: function () {
      if (!this.isGlass) return;
      this.gcard.hidden = true; this.$('vl-g-offer').hidden = true; this.glass.setAttribute('data-card', 'false');
    },
    showWhy: function (on) {
      if (!this.isGlass || !this.gcard || this.gcard.hidden) return;
      const T = this.T || I.ui, c = Companion.cur, el = this.$('vl-g-because');
      if (!c) { el.hidden = true; return; }
      const w = c.why || {};
      el.textContent = T.gBecause + ': ' + (c.because || '') + (w.label ? ' · ' + w.label + (w.date ? ', ' + w.date : '') : '') + (w.source ? ' · ' + T.gSource + ': ' + w.source : '');
      el.hidden = !on;
    },
    showOffer: function (item, disc, accepted) {
      if (!this.isGlass) return;
      const $ = this.$; this.gcard.hidden = false; this.glass.setAttribute('data-card', 'true');
      $('vl-g-offer').hidden = false; $('vl-g-offer').setAttribute('data-accepted', accepted ? 'true' : 'false');
      $('vl-g-oname').textContent = (accepted ? '✓ ' : '') + loc(item.name) + (item.price ? ' · ' + item.price : '');
      $('vl-g-disc').textContent = disc;
      $('vl-g-orow').hidden = !!accepted; $('vl-g-actions').hidden = true;
    },
    hideOffer: function () { if (this.isGlass) { this.$('vl-g-offer').hidden = true; this.$('vl-g-actions').hidden = !Companion.cur; } },
    showRx: function (item) {
      if (!this.isGlass) return;
      const el = this.$('vl-g-rx'), T = this.T || I.ui;
      el.textContent = T.gProvider + ': ' + loc(item.name) + (item.provider ? ' — ' + loc(item.provider) : '');
      el.hidden = false; this.gcard.hidden = false; this.glass.setAttribute('data-card', 'true');
    },
    setEngine: function (eng) {
      this._engine = eng;
      this.root.setAttribute('data-engine', eng);
      this.note.textContent = eng === 'deepgram' ? this.T.privacyDeepgram : this.T.privacyBrowser;
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
      this.placeTab(); this.placeBubble();
    },
    placeTab: function () {
      if (!this.tab) return; const p = this.orbXY(), left = (p.x + 30) < this.vw() / 2;
      this.tab.setAttribute('data-side', left ? 'left' : 'right');
      this.tab.style.top = clamp(p.y + 2, 8, Math.max(8, this.vh() - 64)) + 'px';
    },
    placeBubble: function () {
      if (!this.bubble || !this.bubble.classList.contains('show')) return;
      const vw = this.vw(), vh = this.vh(), p = this.orbXY(), b = this.bubble;
      b.style.maxWidth = Math.min(280, vw - 24) + 'px';
      const bw = b.offsetWidth, bh = b.offsetHeight, rightHalf = (p.x + 30) > vw / 2;
      let x = rightHalf ? p.x + 60 - bw : p.x; x = clamp(x, 8, Math.max(8, vw - bw - 8));
      let y = p.y - bh - 12; if (y < 8) y = Math.min(vh - bh - 8, p.y + 72);
      b.style.left = x + 'px'; b.style.top = y + 'px';
      b.setAttribute('data-tail', rightHalf ? 'right' : 'left'); b.setAttribute('data-below', y > p.y ? 'true' : 'false');
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

    setMode: function (mode) {
      this.mode = mode; this.root.setAttribute('data-mode', mode);
      if (mode !== 'on') this.hideBubble();
      if (mode === 'min') this.placeTab();
    },
    setOpen: function (on, quiet) {
      this.open = !!on;
      this.root.setAttribute('data-open', on ? 'true' : 'false');
      this.orb.setAttribute('aria-expanded', on ? 'true' : 'false');
      if (on) {
        this.hideBubble();
        this.positionPanel();
        this.wave && this.wave.resize();
        this.radial && this.radial.resize();
        const self = this; if (!quiet) setTimeout(function () { try { (self.isGlass ? self.gcircle : self.panel).focus({ preventScroll: true }); } catch (e) {} }, 30);   // never steal focus on an automatic open
      } else if (this.mode === 'on') { try { this.orb.focus({ preventScroll: true }); } catch (e) {} }
    },

    showBubble: function (text) {
      this.$('vl-bubble-main').textContent = text;
      this.bubble.classList.add('show'); this.placeBubble();
    },
    hideBubble: function () { if (this.bubble) this.bubble.classList.remove('show'); },
    bubbleShown: function () { return !!(this.bubble && this.bubble.classList.contains('show')); },

    flash: function (text, ms) {
      const t = this.toast; t.textContent = text; t.classList.add('show');
      clearTimeout(this._toastT); this._toastT = setTimeout(function () { t.classList.remove('show'); }, ms || 6000);
    },

    setState: function (s) {
      this._state = s;
      if (this.forced) s = this.forced;
      this.root.setAttribute('data-state', s);
      this.stateChip.textContent = (this.T || CONFIG.text).states[s] || s;
      if (this.isGlass) this.gstate.textContent = this.stateChip.textContent;
      this.wave && this.wave.setState(s);
      this.updateHint();
    },
    force: function (s) {
      this.forced = (s === 'auto' || !s) ? null : s;
      qsa('[data-force]', this.root).forEach(function (b) { b.setAttribute('aria-pressed', String(b.getAttribute('data-force') === (s || 'auto'))); });
    },

    setMicUI: function (listening, available, reason) {
      this._listening = !!listening; this._micAvail = available !== false; this._micReason = reason || '';
      const T = this.T || I.ui;
      this.micBtn.setAttribute('aria-pressed', String(!!listening));
      this.micTxt.textContent = listening ? T.micActive : T.micIdle;
      this.micBtn.disabled = !this._micAvail;
      this.micBtn.title = this._micAvail ? '' : (this._micReason || T.micUnavailableShort);
      if (this.isGlass) {
        this.glass.setAttribute('data-mic', listening ? 'on' : 'off');
        this.gmictxt.textContent = listening ? T.gMicOn : T.gMicOff;
        this.updateHint();
      }
    },
    setMuteUI: function (muted) {
      this._muted = !!muted;
      const T = this.T || I.ui;
      this.muteBtn.innerHTML = muted ? ICON.mute : ICON.vol;
      this.muteBtn.setAttribute('aria-pressed', String(!!muted));
      this.muteBtn.setAttribute('aria-label', muted ? T.unmute : T.mute); this.muteBtn.title = muted ? T.unmute : T.mute;
      if (this.isGlass) {
        this.gmute.innerHTML = muted ? ICON.mute : ICON.vol; this.gmute.setAttribute('aria-pressed', String(!!muted));
        this.gmute.setAttribute('aria-label', muted ? T.unmute : T.mute); this.gmute.title = muted ? T.unmute : T.mute;
      }
    },

    /** kind: 'bot' | 'user' | 'sys' */
    addLine: function (kind, text, opts) {
      const d = document.createElement('div');
      d.className = 'vl-line ' + kind + (opts && opts.verified ? ' verified' : '');
      if (opts && opts.verified) d.setAttribute('data-v', (this.T || I.ui).verified);
      d.textContent = text;
      this.captions.appendChild(d);
      while (this.captions.children.length > 60) this.captions.removeChild(this.captions.firstChild);
      this.captions.scrollTop = this.captions.scrollHeight;
      if (this.open) this.positionPanel();
      this.setLine(kind, text);
      return d;
    },
    setInterim: function (t) { this.interim.textContent = t || ''; if (this.isGlass) this.ginterim.textContent = t || ''; },

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
      this.root.setAttribute('data-rings', 'true');            // glass relaxes its blur so the highlighted element is readable
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
      if (this.root) this.root.setAttribute('data-rings', 'false');
    }
  };

  /* =========================================================================
   * 7. COMMANDS — a small rule-based grammar per language (English, Spanish).
   *    Rule-based on purpose: no LLM means page text can never "instruct" the assistant.
   *    Input is norm()-ed first: lowercase, accents/¿¡/punctuation removed (so "¿Qué es este sitio?" → "que es este sitio").
   * ========================================================================= */
  const GENERIC_READ = {
    en: /^(this|that|it|this page|the page|page|aloud|out loud|to me|this page aloud|the main content|main content|content|the content|whats on screen|the screen|screen|what is on screen|this section|here)( aloud| out loud| to me)?$/,
    es: /^(esto|eso|lo|esta pagina|la pagina|pagina|en voz alta|el contenido|contenido|el contenido principal|lo que hay en pantalla|que hay en pantalla|la pantalla|pantalla|esta seccion|aqui|todo)( en voz alta)?$/
  };

  function parseEN(raw) {
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
      if (!rest || GENERIC_READ.en.test(rest)) return { type: 'read', raw: raw };
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

  function parseES(raw) {
    let t = norm(raw);
    t = t.replace(/^(oye |hola |vale |ok |okay |hey )?(voice ?layer|asistente)\s+/, '');
    for (let i = 0; i < 3; i++) t = t.replace(/^(por favor|puedes|podrias|podria|puede|quiero|quisiera|me gustaria|necesito|vamos a|a ver|oye|vale|ok|venga|ahora)\s+/, '');
    t = t.replace(/\s+(por favor|gracias|porfa)$/, '').trim();
    let m;
    if (!t) return { type: 'empty', raw: raw };
    if (/^(para|parar|detente|detener|calla|callate|silencio|cancela|cancelar|basta|alto|stop|para ya|detente ya|deja de (hablar|leer|escuchar)|para de (hablar|leer|escuchar)|para (todo|eso|esto))$/.test(t)) return { type: 'stop', raw: raw };
    if (/^(cierra|cerrar|oculta|ocultar|adios|chao|chau|hasta luego|salir|sal|cierra (el |la |este |esta )?(asistente|panel|widget|ventana|chat|esto|eso|voice ?layer))$/.test(t)) return { type: 'close', raw: raw };
    if (/^(ayuda|ayudame|comandos|que puedes hacer|que puedo (decir|hacer)|que comandos hay|como funciona|como (se )?(usa|te uso)|como funciona esto)$/.test(t)) return { type: 'help', raw: raw };
    if (/que es (este|esta|el|la) (sitio|sitio web|web|pagina|pagina web|tienda|lugar)|(cuentame|hablame|dime) (sobre|de|acerca de) (este|esta|el|la) (sitio|sitio web|web|pagina|tienda)|de que (va|trata) (este|esta|el|la) (sitio|sitio web|web|pagina|tienda)|(describe|resume|explica|resumen de) (este|esta|el|la) (sitio|sitio web|web|pagina|tienda)|que (puedo hacer|venden|vendes|vende|hay|tienen|tienes) (aqui|en esta)|que se vende aqui|donde estoy|^resumen$|^resumir$|^resume$/.test(t)) return { type: 'about', raw: raw };
    if ((m = t.match(/^(?:lee|leer|leeme|lee me|leelo|lee lo|leemelo)(?: en voz alta)?(?: (.+))?$/))) {
      const rest = (m[1] || '').trim();
      if (!rest || GENERIC_READ.es.test(rest)) return { type: 'read', raw: raw };
      return { type: 'read', arg: rest.replace(/^(la |el |las |los |en voz alta )+/, '').replace(/^(seccion|apartado) (de |del )?/, ''), raw: raw };
    }
    if (/^(siguiente|el siguiente|la siguiente|otro|otra vez|proximo|el proximo|siguiente resultado|siguiente coincidencia|muestra (el|la) siguiente|sigue|adelante)$/.test(t)) return { type: 'step', dir: 1, raw: raw };
    if (/^(anterior|el anterior|la anterior|previo|el previo|resultado anterior|coincidencia anterior|uno atras|el de antes)$/.test(t)) return { type: 'step', dir: -1, raw: raw };
    if (/^(vuelve|volver|atras|vuelve atras|ve atras|regresa|regresar|ir atras|pagina anterior|vuelve a la pagina anterior|retrocede)$/.test(t)) return { type: 'history', raw: raw };
    if ((m = t.match(/^(?:baja|bajar|sube|subir|desplazate|desplaza|mueve|muevete|pagina|scroll)(?: hacia)?( abajo| arriba)?(?: un poco| mas)?$/)) && (/^(baja|bajar|sube|subir)/.test(t) || m[1])) {
      const dir = m[1] ? (m[1].trim() === 'abajo' ? 'down' : 'up') : (/^(baja|bajar)/.test(t) ? 'down' : 'up');
      return { type: 'scrollby', dir: dir, raw: raw };
    }
    if ((m = t.match(/^(?:ve|ir|vete|sube|baja|bajar|subir|desplazate|llevame|lleva me|salta|vuelve)(?: (?:a|al|hasta|hacia))?(?: la| el)? (principio|inicio|comienzo|arriba|top|final|fin|abajo|parte superior|parte inferior|cima)(?: de (?:la |esta )?pagina)?$/)) ||
        (m = t.match(/^(principio|inicio|arriba|abajo|final|cima)(?: de la pagina)?$/)))
      return { type: 'scrollto', where: /final|fin|abajo|inferior/.test(m[1]) ? 'bottom' : 'top', raw: raw };
    if ((m = t.match(/^(?:anade|anadir|agrega|agregar|pon|poner|mete|meter|echa|echar)(?: me)? (.+?) (?:al|a la|en el|en la|a mi|en mi) (?:carrito|cesta|bolsa|carro|canasta)(?: de la compra)?$/))) return { type: 'click', arg: 'anadir ' + m[1] + ' al carrito', raw: raw };
    if ((m = t.match(/^(?:haz |hacer |da |dale |dar )?(?:clic|click|cliq)(?: en| sobre| a)?(?: el| la| los| las)? (.+)$/)) ||
        (m = t.match(/^(?:pulsa|pulsar|presiona|presionar|aprieta|apretar|toca|tocar|selecciona|seleccionar|elige|elegir|activa|activar|pincha|pinchar|clica|clicar|dale a|dale)(?: en| sobre| a)?(?: el| la| los| las)? (.+)$/)))
      return { type: 'click', arg: m[1], raw: raw };
    if ((m = t.match(/^(?:busca|buscar|buscame|busca me|encuentra|encuentrame|encontrar|localiza|localizar|resalta|resaltar|ubica|ubicar|donde (?:esta|estan|hay)|muestrame donde (?:esta|estan))(?: el| la| los| las| un| una| unos| unas| algun| alguna)? (.+)$/)))
      return { type: 'find', arg: m[1], raw: raw };
    if ((m = t.match(/^(?:ve|ir|vete|llevame|lleva me|navega|salta|desplazate|baja|sube|dirigete|visita|vuelve)(?: (?:a|al|hasta|hacia))?(?: (?:la|el|los|las))?(?: (?:seccion|pagina|apartado|parte|zona)(?: del?)?)?(?: (?:la|el|los|las))? (.+)$/)))
      return { type: 'go', arg: m[1], raw: raw };
    if ((m = t.match(/^(abre|abrir|muestrame|muestra|ensename|mostrar|ensenar)(?: me)?(?: el| la| los| las)? (.+)$/)))
      return { type: 'go', arg: m[2], soft: /^abr/.test(m[1]) ? 'open' : 'show', raw: raw };
    return { type: 'unknown', arg: t, raw: raw };
  }

  /** parse in the active language */
  function parse(raw) { return LANG === 'es' ? parseES(raw) : parseEN(raw); }

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
  function fmtPrice(v, cur) {
    if (LANG === 'es') { try { return v.toLocaleString('es-ES', { maximumFractionDigits: 2 }) + ' ' + cur; } catch (e) {} return v + ' ' + cur; }
    return cur + v;
  }

  /* =========================================================================
   * 7b. SKILLS — three opt-in engines, all rule-based (no LLM), all visitor-driven:
   *     Forms      "change my phone to …"  → find field → read back → yes/no → fill → verify. Never password/payment, never submits.
   *     Memory     consent-gated, this device only (localStorage). Name, visit count, recent pages, notes the visitor asks for.
   *     Knowledge  answers from the site's OWN text, always naming the section it came from. No match = "I don't know".
   * ========================================================================= */
  const SENS_FIELD = /pass(word|code|wd|phrase)|\bpass\b|passwd|\bpwd\b|cvv|cvc|cvn|\bcard|credit|debit|\biban\b|\bswift\b|routing|account ?(no|num)|\bssn\b|social ?sec|security ?code|one ?time|\botp\b|\bpin\b|\bsecret\b|contrasena|\bclave\b|tarjeta|cuenta bancaria|seguro social|codigo de seguridad/;
  const SENS_TEXT = /pass(word|code|wd|phrase)|\bpin\b|\bcvv\b|\bcvc\b|\bcard\b|credit|debit|\biban\b|\bssn\b|social security|diagnos|medicat|prescri|\bdose\b|\bdosage\b|\bmg\b|insulin|glucose|blood|pressure|allerg|pregnan|cancer|diabet|\bhiv\b|depress|anxiety|therapy|surgery|symptom|contrasena|\bclave\b|tarjeta|diagnostic|medicacion|receta|dosis|presion|glucosa|alergia|embaraz|depresion|ansiedad|terapia|cirugia|sintoma/;
  const NUMW = { zero: 0, oh: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, cero: 0, uno: 1, una: 1, dos: 2, tres: 3, cuatro: 4, cinco: 5, seis: 6, siete: 7, ocho: 8, nueve: 9 };

  /** accent-folded lowercase copy of `raw` that remembers where every character came from, so a spoken VALUE keeps its original case/accents */
  function fold(raw) {
    const str = clean(raw); let s = ''; const map = [];
    for (let i = 0; i < str.length; i++) {
      const ch = str[i]; if (ch === '\'' || ch === '\u2019') continue;
      const b = ch.normalize('NFD').replace(/\p{M}+/gu, '').toLowerCase();
      for (let j = 0; j < b.length; j++) { s += b[j]; map.push(i); }
    }
    return { s: s, map: map, raw: str };
  }
  function sliceOf(f, start, len) { if (!len || f.map[start] == null) return ''; const a = f.map[start], b = f.map[Math.min(f.map.length - 1, start + len - 1)]; return clean(f.raw.slice(a, b + 1)).replace(/[\s.!?¿¡]+$/, ''); }

  /** the grammar for the three skills; returns an intent or null (language comes from the active pack) */
  function parseSkills(raw) {
    const G = I.sg; if (!G) return null;
    const f = fold(raw), s = f.s;
    const sn = s.replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
    let tn = sn; for (let i = 0; i < 3; i++) tn = tn.replace(G.pre, '');
    tn = tn.replace(/\s+(please|thanks|thank you|por favor|gracias)$/, '').trim();
    let m;
    // ---- memory ----
    if (G.mem.enable.test(tn)) return { type: 'mem', act: 'enable', raw: raw };
    if (G.mem.pause.test(tn)) return { type: 'mem', act: 'pause', raw: raw };
    if (G.mem.recall.test(tn)) return { type: 'mem', act: 'recall', raw: raw };
    if (G.mem.forgetName.test(tn)) return { type: 'mem', act: 'forgetname', raw: raw };
    if (G.mem.forget.test(tn)) return { type: 'mem', act: 'forget', raw: raw };
    if (Memory.enabled()) {
      if ((m = s.match(G.mem.name)) && !G.notName.test(m[1])) { const v = sliceOf(f, s.lastIndexOf(m[1]), m[1].length).replace(/\s+(please|thanks|thank you|por favor|gracias)$/i, ''); return { type: 'mem', act: 'name', val: v, raw: raw }; }
      if ((m = s.match(G.mem.fact))) { const v = sliceOf(f, s.lastIndexOf(m[1]), m[1].length); return { type: 'mem', act: 'fact', val: v, raw: raw }; }
    }
    // ---- forms ----
    if (CONFIG.forms) {
      if (G.undo.test(tn)) return { type: 'formundo', raw: raw };
      for (let i = 0; i < G.formset.length; i++) {
        const rule = G.formset[i]; m = s.match(rule.re); if (!m) continue;
        const fld = norm(m[rule.f]), val = m[rule.v];
        if (!fld || !val || G.notField.test(fld)) continue;
        const start = rule.v > rule.f ? s.lastIndexOf(val) : s.indexOf(val, m.index);
        return { type: 'formset', field: fld, value: sliceOf(f, start, val.length), soft: !!rule.soft, raw: raw };
      }
    }
    return null;
  }

  /* ------------------------------------------------------------------ FORMS */
  const FSYN = [
    [/\b(e mail address|email address|mail address|direccion de correo|correo electronico|e mail|correo|email|mail)\b/g, 'email'],
    [/\b(phone number|telephone number|cell phone number|mobile number|cell number|cellphone|cell phone|telephone|mobile phone|numero de telefono|numero de movil|numero de celular|telefono|movil|celular|mobile|cell|tel)\b/g, 'phone'],
    [/\b(street address|home address|mailing address|direccion postal|direccion|domicilio)\b/g, 'address'],
    [/\b(zip code|postal code|post code|codigo postal|zip)\b/g, 'zip']
  ];
  function fnorm(s) { let t = norm(s); FSYN.forEach(function (r) { t = t.replace(r[0], r[1]); }); return t.replace(/\s+/g, ' ').trim(); }

  /** an element of THIS page (a node parsed from another page's HTML reports isConnected too, so check the document) */
  function liveEl(el) { return !!(el && el.isConnected && el.ownerDocument === document); }

  const Forms = {
    last: null,
    enabled: function () { return !!CONFIG.forms; },
    labelsOf: function (el) {
      const out = [], add = function (t) { t = clean(t).replace(/[*:]+$/, '').trim(); if (t && t.length < 90 && out.indexOf(t) < 0) out.push(t); };
      try { if (el.id) qsa('label[for="' + (window.CSS && CSS.escape ? CSS.escape(el.id) : el.id) + '"]').forEach(function (l) { add(l.textContent); }); } catch (e) {}
      const w = el.closest('label');
      if (w) { const c = w.cloneNode(true); qsa('input,select,textarea,option', c).forEach(function (x) { x.remove(); }); add(c.textContent); }
      add(el.getAttribute('aria-label'));
      const lb = el.getAttribute('aria-labelledby'); if (lb) lb.split(/\s+/).forEach(function (id) { const e = document.getElementById(id); if (e) add(e.textContent); });
      add(el.getAttribute('placeholder')); add(el.getAttribute('title'));
      add((el.getAttribute('name') || '').replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[-_\[\]]+/g, ' '));
      add((el.id || '').replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[-_]+/g, ' '));
      const t = (el.getAttribute('type') || '').toLowerCase();
      if (t === 'tel') add('phone'); if (t === 'email') add('email');
      return out;
    },
    kindOf: function (el, labels) {
      const tag = el.tagName, t = (el.getAttribute('type') || 'text').toLowerCase();
      if (tag === 'SELECT') return 'select';
      if (tag === 'TEXTAREA') return 'textarea';
      if (t === 'password') return 'password';
      if (/^(checkbox)$/.test(t)) return 'checkbox'; if (t === 'radio') return 'radio'; if (t === 'file') return 'file'; if (t === 'range') return 'range'; if (t === 'color') return 'color';
      if (/^(date|time|datetime-local|month|week)$/.test(t)) return 'date';
      const h = labels.map(fnorm).join(' ');
      if (t === 'tel' || /\bphone\b/.test(h)) return 'phone';
      if (t === 'email' || /\bemail\b/.test(h)) return 'email';
      if (t === 'url') return 'url';
      if (t === 'number') return 'number';
      return 'text';
    },
    blockedReason: function (el, labels, kind) {
      if (kind === 'password') return 'password';
      if (el.closest('[data-vl-nofill]')) return 'owner';
      const ac = (el.getAttribute('autocomplete') || '').toLowerCase();
      if (/^(cc-|current-password|new-password|one-time-code)/.test(ac)) return 'payment';
      const hay = (labels.join(' ') + ' ' + (el.getAttribute('name') || '') + ' ' + (el.id || '')).toLowerCase().replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[-_]+/g, ' ');
      if (SENS_FIELD.test(hay)) return 'sensitive';
      return '';                      // blocking is per FIELD: a phone number on a profile page is fine. Submit/Pay buttons on payment forms stay guarded by doClick.
    },
    /** the visitor said a value for a sensitive field: never echo it into the transcript or the command event */
    redact: function (text) {
      try {
        if (!CONFIG.forms) return text;
        const it = parseSkills(text); if (!it || it.type !== 'formset' || !it.value) return text;
        let hidden = SENS_FIELD.test(it.field);
        if (!hidden) { const c = this.fields(), h = this.match(c, it.field)[0]; hidden = !!(h && h.card.blocked); }
        if (!hidden) return text;
        const i = String(text).toLowerCase().lastIndexOf(String(it.value).toLowerCase());
        return i < 0 ? String(text).replace(/\S+$/, '••••') : String(text).slice(0, i) + '••••' + String(text).slice(i + it.value.length);
      } catch (e) { return text; }
    },
    describe: function (el) {
      const labels = this.labelsOf(el), kind = this.kindOf(el, labels);
      return { el: el, labels: labels, label: labels[0] || (el.getAttribute('type') || el.tagName.toLowerCase()), kind: kind, blocked: this.blockedReason(el, labels, kind), readonly: !!(el.readOnly || isDisabled(el)) };
    },
    fields: function () {
      const self = this;
      return qsa('input, textarea, select').filter(function (el) {
        if (el.closest(SKIP_SEL)) return false;
        const t = (el.getAttribute('type') || 'text').toLowerCase();
        if (el.tagName === 'INPUT' && /^(hidden|submit|button|reset|image)$/.test(t)) return false;
        return isVisible(el);
      }).map(function (el) { return self.describe(el); });
    },
    match: function (cards, q) {
      const fq = fnorm(q), out = [];
      cards.forEach(function (c) {
        let best = 0; c.labels.forEach(function (l) { best = Math.max(best, score(fq, fnorm(l))); });
        if (best >= 0.6) out.push({ card: c, score: best });
      });
      return out.sort(function (a, b) { return b.score - a.score; });
    },
    /** spoken value → what goes into the field, or {err: key} */
    normalize: function (card, v) {
      v = clean(v).replace(/^["“”'‘’]+|["“”'‘’]+$/g, '');
      const el = card.el; if (!v) return { err: 'pattern' };
      let out = v;
      switch (card.kind) {
        case 'email': {
          out = v.toLowerCase().replace(/\s+(at|arroba)\s+/g, '@').replace(/\s+(dot|punto)\s+/g, '.').replace(/\s+(underscore|guion bajo)\s+/g, '_').replace(/\s+(dash|hyphen|guion)\s+/g, '-').replace(/\s+/g, '');
          if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(out)) return { err: 'email' };
          break;
        }
        case 'phone': {
          if (/^[\d\s\-().+]+$/.test(v)) out = v;
          else {
            const toks = v.toLowerCase().replace(/[,.\-()]/g, ' ').split(/\s+/).filter(Boolean); let d = '', plus = false, dbl = 1;
            for (let i = 0; i < toks.length; i++) {
              const k = toks[i];
              if (k === 'plus' || k === 'mas') { plus = true; continue; }
              if (k === 'double' || k === 'doble') { dbl = 2; continue; } if (k === 'triple') { dbl = 3; continue; }
              if (/^\d+$/.test(k)) { d += k; dbl = 1; continue; }
              if (NUMW[k] != null) { d += String(NUMW[k]).repeat(dbl); dbl = 1; continue; }
              return { err: 'phone' };
            }
            out = (plus ? '+' : '') + d;
          }
          const n = out.replace(/\D/g, '').length; if (n < 7 || n > 15) return { err: 'phone' };
          break;
        }
        case 'number': {
          const mm = v.replace(/\s+/g, '').match(/^-?\d+(?:[.,]\d+)?$/); if (!mm) return { err: 'number' };
          out = mm[0].replace(',', '.');
          const lo = el.min !== '' ? parseFloat(el.min) : null, hi = el.max !== '' ? parseFloat(el.max) : null, nv = parseFloat(out);
          if ((lo != null && !isNaN(lo) && nv < lo) || (hi != null && !isNaN(hi) && nv > hi)) return { err: 'range' };
          break;
        }
        case 'url': {
          out = v.toLowerCase().replace(/\s+(dot|punto)\s+/g, '.').replace(/\s+(slash|barra)\s+/g, '/').replace(/\s+/g, '');
          if (!/^(https?:\/\/)?[\w-]+(\.[\w-]+)+(\/\S*)?$/.test(out)) return { err: 'url' };
          break;
        }
        case 'select': {
          const opts = qsa('option', el).filter(function (o) { return !o.disabled && (o.value !== '' || clean(o.textContent)); });
          const hits = rank(opts, v, 0.7, function (o) { return clean(o.textContent) + ' ' + o.value; });
          if (!hits.length || (hits.length > 1 && hits[0].score - hits[1].score < 0.1 && hits[0].score < 0.99)) return { err: 'option' };
          return { value: hits[0].item.value, optionText: clean(hits[0].item.textContent), option: hits[0].item };
        }
        default: out = v;
      }
      const max = el.maxLength > 0 ? el.maxLength : (card.kind === 'textarea' ? 500 : 200);
      if (out.length > max) return { err: 'length' };
      if (el.pattern) { try { if (!new RegExp('^(?:' + el.pattern + ')$').test(out)) return { err: 'pattern' }; } catch (e) {} }
      return { value: out };
    },
    /** is this field still safe to touch right now? returns '' or a reason */
    recheck: function (card) {
      const el = card.el;
      if (!el.isConnected || !isVisible(el)) return 'gone';
      if (el.readOnly || isDisabled(el)) return 'readonly';
      if (this.blockedReason(el, this.labelsOf(el), this.kindOf(el, this.labelsOf(el)))) return 'blocked';
      return '';
    },
    setValue: function (el, v) {
      try { el.focus({ preventScroll: true }); } catch (e) {}
      const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : el.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
      const d = Object.getOwnPropertyDescriptor(proto, 'value');
      if (d && d.set) d.set.call(el, v); else el.value = v;                      // the native setter, so React/Vue-style frameworks see the change
      let ev; try { ev = new InputEvent('input', { bubbles: true, inputType: 'insertReplacementText', data: v }); } catch (e) { ev = new Event('input', { bubbles: true }); }
      el.dispatchEvent(ev); el.dispatchEvent(new Event('change', { bubbles: true }));
      try { el.blur(); } catch (e) {}
    },
    same: function (card, want, got) {
      got = String(got == null ? '' : got);
      if (card.kind === 'phone') return got.replace(/\D/g, '') === String(want).replace(/\D/g, '');
      if (card.kind === 'email') return clean(got).toLowerCase() === String(want).toLowerCase();
      if (card.kind === 'number') return parseFloat(got) === parseFloat(want);
      return clean(got) === clean(want);
    },
    /** how the value is read aloud: digits one by one, e-mail as "name at site dot com" */
    speak: function (v, kind) {
      v = String(v == null ? '' : v);
      if (/@/.test(v) || kind === 'email') return v.replace(/@/g, ' ' + (LANG === 'es' ? 'arroba' : 'at') + ' ').replace(/\./g, ' ' + (LANG === 'es' ? 'punto' : 'dot') + ' ').replace(/_/g, ' ' + (LANG === 'es' ? 'guion bajo' : 'underscore') + ' ').replace(/-/g, ' ' + (LANG === 'es' ? 'guion' : 'dash') + ' ').replace(/\s+/g, ' ').trim();
      if (kind === 'phone') return v.replace(/\+/g, (LANG === 'es' ? 'más ' : 'plus ')).replace(/\d/g, function (d) { return d + ' '; }).replace(/[^\d\sa-z]/gi, ' ').replace(/\s+/g, ' ').trim();
      return v;
    }
  };

  /* ------------------------------------------------------------------ MEMORY */
  const Memory = {
    cfg: null, d: null, sessName: '',
    enabled: function () { return !!this.cfg; },
    init: function () {
      const c = CONFIG.memory; if (!c) { this.cfg = null; return; }
      this.cfg = Object.assign({ ttlDays: 180, maxPages: 8, maxFacts: 10, pages: true, skipPaths: [] }, typeof c === 'object' ? c : {});
      this.load(); this.visit();
    },
    blank: function () { return { v: 1, consent: false, paused: false, name: '', visits: 0, firstAt: 0, lastAt: 0, pages: [], facts: [] }; },
    load: function () {
      let d = null; try { d = JSON.parse(store.get(KEYS.mem) || 'null'); } catch (e) { d = null; }
      if (d && d.v === 1 && d.consent && d.lastAt && Date.now() - d.lastAt > this.cfg.ttlDays * 864e5) { store.set(KEYS.mem, null); d = null; }    // expired = deleted
      this.d = d && d.v === 1 ? d : null;
    },
    has: function () { return !!(this.d && this.d.consent); },
    active: function () { return this.has() && !this.d.paused; },
    write: function () { if (!this.d) return false; this.d.lastAt = Date.now(); const s = JSON.stringify(this.d); store.set(KEYS.mem, s); return store.get(KEYS.mem) === s; },
    emit: function (type) { try { window.dispatchEvent(new CustomEvent('voicelayer:memory', { detail: { type: type } })); } catch (e) {} },
    grant: function () {
      if (!this.d) this.d = this.blank();
      this.d.consent = true; this.d.paused = false; if (!this.d.firstAt) this.d.firstAt = Date.now();
      if (!this.d.visits) { this.d.visits = 1; store.sset(KEYS.memVisit, String(Date.now())); }
      this.recordPage(); const ok = this.write(); this.emit('consent'); return ok;
    },
    visit: function () {
      if (!this.active()) return;
      if (!store.sget(KEYS.memVisit)) { store.sset(KEYS.memVisit, String(Date.now())); this.d.visits = (this.d.visits || 0) + 1; }   // a "visit" = one browser session
      this.recordPage(); this.write();
    },
    sessionStart: function () { return parseInt(store.sget(KEYS.memVisit) || '0', 10) || Date.now(); },
    recordPage: function () {
      if (!this.d || this.cfg.pages === false) return;
      const p = location.pathname || '/', title = short(document.title || '', 60);
      if ((this.cfg.skipPaths || []).some(function (x) { return p.indexOf(x) === 0; })) return;
      if (!title || SENS_TEXT.test(norm(title))) return;                      // never keep a page title that looks health/payment related
      const last = this.d.pages[this.d.pages.length - 1];
      if (last && last.p === p && last.at >= this.sessionStart()) { last.t = title; last.at = Date.now(); return; }      // same page, same visit = update; same page on a LATER visit = a new entry
      this.d.pages.push({ p: p, t: title, at: Date.now() });
      while (this.d.pages.length > this.cfg.maxPages) this.d.pages.shift();
    },
    name: function () { return (this.active() && this.d.name) || this.sessName || ''; },
    setName: function (n) { if (!this.d) return false; this.d.name = n; const ok = this.write() && JSON.parse(store.get(KEYS.mem)).name === n; if (ok) this.emit('saved'); return ok; },
    addFact: function (t) { if (!this.d) return false; this.d.facts.push({ t: t, at: Date.now() }); while (this.d.facts.length > this.cfg.maxFacts) this.d.facts.shift(); const ok = this.write(); if (ok) this.emit('saved'); return ok; },
    snapshot: function () { return this.has() ? JSON.parse(JSON.stringify(this.d)) : null; },
    forgetName: function () { if (!this.d) return true; this.d.name = ''; this.sessName = ''; this.write(); const ok = !JSON.parse(store.get(KEYS.mem) || '{}').name; this.emit('forgot'); return ok; },
    wipe: function () { store.set(KEYS.mem, null); store.sset(KEYS.memVisit, null); this.d = null; this.sessName = ''; const ok = store.get(KEYS.mem) === null; this.emit('forgot'); return ok; },
    /** a RETURNING visitor (second session or later) → { name, last } ; otherwise null. `last` = a page title from an EARLIER visit, never this one */
    ret: function () {
      if (!this.active() || (this.d.visits || 0) < 2) return null;
      const ss = this.sessionStart(), prev = this.d.pages.filter(function (p) { return p.at < ss; }).pop();
      return { name: this.d.name || '', last: prev ? prev.t : '' };
    }
  };

  /* ------------------------------------------------------------------ KNOWLEDGE */
  const QSTOP = new Set(('what whats how do does did is are was were can could would should will your you my me our we the a an to of for in on at and or about tell please i it this that there any have has get be with from if when where who which why mine site website here their its ' +
    'que cual cuales como cuando donde quien por para es son era fue puedo puede pueden podria tengo tiene tienen hay del los las una uno unos unas con sin sobre mi mis tu tus su sus nos este esta esto estos estas ese esa eso muy mas pero como cuanto cuanta cuantos cuantas').split(' '));
  function stem(w) {
    w = String(w || '').toLowerCase(); if (w.length < 4 || /^\d+$/.test(w)) return w;
    if (LANG === 'es') { if (/[^aeiou]es$/.test(w)) w = w.slice(0, -2); else if (/s$/.test(w)) w = w.slice(0, -1); return w; }
    if (/ies$/.test(w)) w = w.slice(0, -3) + 'y'; else if (/(sses|xes|ches|shes)$/.test(w)) w = w.slice(0, -2); else if (/[^s]s$/.test(w)) w = w.slice(0, -1);
    if (w.length > 5 && /(ing|ed)$/.test(w)) w = w.replace(/(ing|ed)$/, '');
    if (w.length > 4 && /e$/.test(w)) w = w.slice(0, -1);
    if (/([^aeiou])\1$/.test(w) && w.length > 3 && !/(ss|ll)$/.test(w)) w = w.slice(0, -1);
    return w;
  }
  function stems(text) { const o = {}; norm(text).split(' ').forEach(function (t) { if (t.length >= 3 || /^\d+$/.test(t)) o[stem(t)] = 1; }); return o; }

  const Knowledge = {
    cfg: null, cache: {}, extraTried: false, extraErrors: [],
    emit: function (type, extra) { try { window.dispatchEvent(new CustomEvent('voicelayer:knowledge', { detail: Object.assign({ type: type }, extra || {}) })); } catch (e) {} },
    enabled: function () { return !!this.cfg; },
    init: function () {
      const c = CONFIG.knowledge; if (!c) { this.cfg = null; return; }
      this.cfg = Object.assign({ pages: [], autoNav: false, facts: [], minScore: 0.55 }, typeof c === 'object' ? c : {});
    },
    pageTitle: function (t) { return clean(String(t || '').split(/\s[|\u2013\u2014-]\s/)[0]); },
    /** pull Q&A-shaped passages out of a DOM tree: <details>, <dl>, and "heading + the content under it" */
    extract: function (root, page, url) {
      const out = [], self = this;
      const skip = function (el) { return !!el.closest(SKIP_SEL + ', nav, [role="navigation"], [aria-hidden="true"], [hidden]'); };
      const push = function (q, a, el, id) {
        q = clean(q); a = clean(a).slice(0, 900);
        if (!q || a.length < 20) return;
        out.push({ q: q, a: a, el: el || null, page: page, url: url || '', id: id || '' });
      };
      qsa('details', root).forEach(function (d) {
        const s = d.querySelector('summary'); if (!s || skip(d)) return;
        const c = d.cloneNode(true), cs = c.querySelector('summary'); if (cs) cs.remove();
        push(s.textContent, c.textContent, d, d.id);
      });
      qsa('dl', root).forEach(function (dl) {
        if (skip(dl)) return; let cur = null;
        Array.prototype.slice.call(dl.children).forEach(function (ch) {
          if (ch.tagName === 'DT') { if (cur) push(cur.q, cur.a, cur.el, cur.id); cur = { q: ch.textContent, a: '', el: ch, id: ch.id }; }
          else if (ch.tagName === 'DD' && cur) cur.a += ' ' + ch.textContent;
        });
        if (cur) push(cur.q, cur.a, cur.el, cur.id);
      });
      qsa('h1,h2,h3,h4,h5', root).forEach(function (h) {
        if (skip(h) || h.closest('summary, dt')) return;
        const L = +h.tagName[1]; let a = '', n = h.nextElementSibling;
        while (n && a.length < 900) {
          if (/^H[1-6]$/.test(n.tagName) && +n.tagName[1] <= L) break;
          if (n.querySelector && n.querySelector('h1,h2,h3,h4,h5')) break;           // a wrapper with its own sub-headings: those become their own passages
          if (!/^(SCRIPT|STYLE|NAV|FORM|BUTTON|SELECT)$/.test(n.tagName) && !skip(n)) a += ' ' + n.textContent;
          n = n.nextElementSibling;
        }
        push(h.textContent, a, h, h.id);
      });
      return out;
    },
    ownFacts: function () {
      return (this.cfg.facts || []).filter(function (f) { return f && f.q && f.a; }).map(function (f) {
        const q = typeof f.q === 'object' ? (f.q[LANG] || f.q.en || '') : f.q, a = typeof f.a === 'object' ? (f.a[LANG] || f.a.en || '') : f.a;
        return { q: clean(q), a: clean(a), el: null, page: '', url: f.url || '', id: '', owner: true, source: f.source ? (typeof f.source === 'object' ? f.source[LANG] || f.source.en : f.source) : '', kw: clean(f.keywords || '') };
      });
    },
    loadExtra: async function () {
      if (this.extraTried) return; this.extraTried = true;
      if (location.protocol === 'file:') return;
      const urls = (this.cfg.pages || []).slice();
      if (this.cfg.autoNav && Scanner.map) Scanner.map.nav.forEach(function (n) { if (n.href) urls.push(n.href); });
      const seen = {}, here = location.href.split('#')[0].replace(/\/$/, '');
      const list = [];
      urls.forEach(function (u) { try { const a = new URL(u, location.href); a.hash = ''; const k = a.href.replace(/\/$/, ''); if (a.origin === location.origin && k !== here && !seen[k]) { seen[k] = 1; list.push(a.href); } } catch (e) {} });
      const self = this;
      await Promise.all(list.slice(0, 6).map(async function (u) {
        try {
          const ctl = typeof AbortController !== 'undefined' ? new AbortController() : null, tm = setTimeout(function () { if (ctl) ctl.abort(); }, 6000);
          const r = await fetch(u, { credentials: 'same-origin', signal: ctl ? ctl.signal : undefined }); clearTimeout(tm);
          if (!r.ok || !/html/i.test(r.headers.get('content-type') || '')) throw new Error('status ' + r.status);
          const doc = new DOMParser().parseFromString(await r.text(), 'text/html');
          self.cache[u] = self.extract(doc.body, self.pageTitle(doc.title) || u, u);
        } catch (e) { self.extraErrors.push(u); log('knowledge: could not read', u, e && e.message); }
      }));
    },
    passages: function () {
      let all = this.ownFacts().concat(this.extract(document.body, '', location.href.split('#')[0]));
      Object.keys(this.cache).forEach(function (k) { all = all.concat(Knowledge.cache[k]); });
      all.forEach(function (p) { p.qs = stems(p.q + ' ' + (p.kw || '')); p.as = stems(p.q + ' ' + p.a + ' ' + (p.kw || '')); });     // stems depend on the ACTIVE language, so they are computed per question
      return all;
    },
    keywords: function (q) {
      const out = []; norm(q).split(' ').forEach(function (t) { if (!t || QSTOP.has(t) || STOPWORDS.has(t)) return; if (t.length >= 3 || /^\d+$/.test(t)) { const s = stem(t); if (out.indexOf(s) < 0) out.push(s); } });
      return out;
    },
    pick: function (p, K) {
      if (p.a.length <= 320) return p.a;
      const sents = p.a.match(/[^.!?]+[.!?]+(?:\s|$)|[^.!?]+$/g) || [p.a]; let best = 0, bs = -1;
      sents.forEach(function (s, i) { const st = stems(s); const sc = K.filter(function (k) { return st[k]; }).length; if (sc > bs) { bs = sc; best = i; } });
      const lo = Math.max(0, Math.min(best, sents.length - 2)), take = sents.slice(lo, lo + 2).join('').trim();
      return take.length > 420 ? sents[best].trim() : take;
    },
    ask: async function (q) {
      await this.loadExtra();
      const K = this.keywords(q); if (!K.length) return { found: false, K: K };
      let best = null;
      this.passages().forEach(function (p) {
        const hc = K.filter(function (k) { return p.qs[k]; }).length / K.length, bc = K.filter(function (k) { return p.as[k]; }).length / K.length;
        const s = 0.6 * hc + 0.4 * bc + (p.owner ? 0.03 : 0);
        if (!best || s > best.s) best = { p: p, s: s };
      });
      if (!best || best.s < this.cfg.minScore) return { found: false, K: K, best: best ? best.s : 0 };
      const p = best.p;
      return { found: true, K: K, score: Math.round(best.s * 100) / 100, p: p, text: this.pick(p, K), source: this.sourceOf(p), medical: !p.owner && I.sg.medText.test(norm(p.a)) };
    },
    sourceOf: function (p) {
      if (p.owner && p.source) return p.source;
      return I.sk.k.srcSec(short(p.q, 70), p.page);
    }
  };
  /** health-ADVICE questions ("should I take…", "do I have…"): never answered from the site, routed to a professional.
 *  Business questions that merely contain a health word ("can I return the vitamins?") are NOT blocked, unless they are explicit. */
  function isMedAdvice(t) { const G = I.sg; if (!G) return false; if (G.medExplicit.test(t)) return true; return G.medAdvice.test(t) && G.medTerms.test(t) && !G.medBiz.test(t); }

  /* =========================================================================
   * 8. CONTROLLER — state machine, command execution, and honest receipts
   * ========================================================================= */
  const CART_WORDS = /\b(cart|bag|basket|carrito|cesta|bolsa|carro|canasta)\b/;
  function sensitiveRe() {
    const all = SUPPORTED.map(function (c) { return PACKS[c].confirmWords; });
    if (CONFIG.confirmBeforeClick) all.push(norm(CONFIG.confirmBeforeClick).replace(/ /g, ' '));
    return new RegExp('\\b(' + all.join('|') + ')\\b');
  }

  const VL = {
    token: 0, busy: false, muted: false, speechStarted: false, pending: null, findState: null,
    introDone: false, receipts: [], lastSpeechEnd: 0, lastSpoken: '', state: 'idle', _interrupt: null,
    mode: 'on', killed: false, touched: false, _bubbleT: 0, _bubbleHide: 0, woke: false,

    init: function () {
      const self = this;
      // ---- language + visitor/owner switches (decided BEFORE anything is drawn) ----
      const L = resolveLang(); setLang(L.code, L.full, false);
      const q = (function () { try { return new URLSearchParams(location.search).get('voicelayer'); } catch (e) { return null; } })();
      if (q === 'on') { store.set(KEYS.off, null); store.set(KEYS.min, null); }
      if (q === 'off') store.set(KEYS.off, '1');
      this.mode = store.get(KEYS.off) === '1' ? 'off' : (store.get(KEYS.min) === '1' && CONFIG.allowMinimize ? 'min' : 'on');
      this.muted = store.get(KEYS.speak) === 'off';
      Companion.init(); Memory.init(); Knowledge.init();

      UI.build({
        onOrb: function () { self.touched = true; Voice.unlock(); self.onOrb(); },
        onCircle: function () { self.touched = true; Voice.unlock(); self.onCircle(); },
        onPause: function () { self.touched = true; self.goToSleep(); },
        onAct: function (k) { self.touched = true; Voice.unlock(); self.handleUtterance(I.cp.act[k], 'text'); },
        onMic: function () { self.touched = true; Voice.unlock(); self.toggleListening(); },
        onStop: function () { self.stop(true); },
        onClose: function () { self.close(); },
        onMinimize: function () { self.minimize(); },
        onTurnOff: function () { self.turnOff(); },
        onRestore: function () { self.restore(false); },
        onBubble: function () { self.touched = true; Voice.unlock(); UI.hideBubble(); self.open(false); },   // opens the panel only — the mic starts on an explicit mic/orb tap
        onBubbleDismiss: function () { UI.hideBubble(); },
        onLang: function (c) { Voice.unlock(); self.changeLanguage(c, true); },
        onSubmit: function (v) { Voice.unlock(); self.handleUtterance(v, 'text'); },
        onMute: function () { self.setMuted(!self.muted); },
        onForce: function (s) { UI.force(s); self.refresh(); }
      });
      UI.root.setAttribute('data-mode', 'pending');          // hidden until the owner flag + engine are known (≤2.5s, fail-open)
      UI.setMuteUI(this.muted);
      UI.setMicUI(false, Voice.supportsRecognition(), Voice.supportsRecognition() ? '' : UI.T.micUnavailable);

      Voice.onStart = function () { self.refresh(); };
      Voice.onFinal = function (t) { self.handleUtterance(t, 'voice'); };
      Voice.onInterim = function (t) { UI.setInterim(Voice.isSpeaking() ? '' : t); };
      Voice.onEnd = function () { UI.setMicUI(false, Voice.supportsRecognition()); UI.setInterim(''); UI.wave && UI.wave.setAnalyser(null); self.refresh(); };
      Voice.onAudioLevelReady = function (an) { UI.wave && UI.wave.setAnalyser(an); };
      Voice.onOutAnalyser = function (an) { UI.wave && UI.wave.setOutAnalyser(an); };
      Voice.onError = function (code) { self.onVoiceError(code); };
      Voice.onNotice = function (k) {
        if (k === 'dgFallback') { UI.setEngine('browser'); UI.addLine('sys', M.dgFallback); UI.setMicUI(Voice.isListening(), Voice.supportsRecognition()); }
      };
      Voice.onSpeakStart = function () { self.speechStarted = true; self.refresh(); };
      Voice.onSpeakEnd = function () { self.speechStarted = false; self.lastSpeechEnd = performance.now(); self.refresh(); };
      Voice.onBoundary = function () { UI.wave && UI.wave.kick(1); };

      // ---- global safety nets + visitor controls ----
      ['pointerdown', 'keydown', 'wheel', 'touchstart'].forEach(function (ev) {   // visitor is already busy on the page → never nudge
        document.addEventListener(ev, function (e) { if (!self.touched && e.isTrusted) self.touched = true; }, { capture: true, passive: true });
      });
      document.addEventListener('keydown', function (e) {
        if (self.killed) return;
        if (e.key === 'Escape') { if (self.busy || Voice.isSpeaking() || self._acting) self.stop(true); else if (UI.open) self.close(); }
        if (CONFIG.hotkey && self.hotkeyMatch(e)) { e.preventDefault(); self.touched = true; self.hotkey(); }
      }, true);
      document.addEventListener('click', function (e) {              // host-page links: <a href="#" data-voicelayer-open>Voice help</a>
        const t = e.target && e.target.closest && e.target.closest('[data-voicelayer-open]');
        if (t && !self.killed) { e.preventDefault(); self.touched = true; self.restore(true); }
      }, true);
      window.addEventListener('pagehide', function () { Voice.stop(); Voice.cancelSpeech(); });

      // ---- scan once the DOM is ready, then keep the map fresh (not while turned off) ----
      const boot = function () { if (self.mode !== 'off') { Scanner.scan(); Scanner.watch(); } };
      if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
      window.addEventListener('load', function () { if (self.mode !== 'off') Scanner.scan(); });

      // ---- owner flag + engine, then reveal ----
      this.setup().then(function () {
        if (self.killed) return;
        self.applyMode(self.mode, true);
        self.afterReveal();
      });
      if (CONFIG.debug) log('debug mode on — use the force-state buttons in the panel');
    },

    /** ask the server: is the widget switched off by the owner? is Deepgram available? Never blocks longer than ~2.5s; fails open. */
    setup: async function () {
      let cfg = null;
      if (CONFIG.apiBase && (CONFIG.remoteConfig || CONFIG.provider !== 'browser')) {
        try { cfg = await Net.config(); } catch (e) { log('config unavailable →', e && e.message); }
      }
      if (cfg && cfg.enabled === false) { this.kill('owner'); return; }
      Voice.dgOk = !!(cfg && cfg.deepgram);
      if (cfg && cfg.voices) CONFIG.dgVoices = Object.assign({}, cfg.voices, CONFIG.dgVoices || {});
      Voice.engine = (CONFIG.provider !== 'browser' && Voice.dgOk) ? 'deepgram' : 'browser';
      if (CONFIG.provider === 'deepgram' && !Voice.dgOk) log('provider=deepgram requested but the server has no Deepgram key → browser voice');
      UI.setEngine(Voice.engine);
      UI.setMicUI(false, Voice.supportsRecognition(), Voice.supportsRecognition() ? '' : UI.T.micUnavailable);
      log('voice engine:', Voice.engine);
    },

    /** owner kill switch: remove the widget completely (no UI, no listeners that act, mic released) */
    kill: function (why) {
      this.killed = true; this.mode = 'killed';
      try { Voice.stop(); Voice.cancelSpeech(); } catch (e) {}
      Scanner.unwatch();
      try { UI.host && UI.host.remove(); } catch (e) {}
      try { window.dispatchEvent(new CustomEvent('voicelayer:state', { detail: { state: 'disabled', reason: why } })); } catch (e) {}
      log('widget disabled by', why);
    },
    checkRemote: async function () {
      if (!CONFIG.apiBase || !CONFIG.remoteConfig || this.killed) return;
      try { const c = await Net.config(); if (c && c.enabled === false) this.kill('owner'); } catch (e) { /* fail open */ }
    },

    /* ---------- visitor mode: on / min / off ---------- */
    applyMode: function (mode, initial) {
      this.mode = mode; UI.setMode(mode);
      if (mode === 'on') { Scanner.watch(); if (!initial) Scanner.scan(); }
      if (mode === 'off') Scanner.unwatch();
      else if (initial && mode === 'min') Scanner.watch();
    },
    sleepUI: function () { this.woke = false; UI.setAwake(false); },
    minimize: function () {
      this.stop(false); this.sleepUI(); UI.setOpen(false); UI.setInterim('');
      store.set(KEYS.min, '1'); this.applyMode('min');
      try { UI.tab.focus({ preventScroll: true }); } catch (e) {}
      this.refresh();
    },
    turnOff: function () {
      this.stop(false); this.sleepUI(); UI.setOpen(false); UI.setInterim('');
      store.set(KEYS.off, '1'); this.applyMode('off');
      UI.flash(M.offNote(CONFIG.hotkey || '—', !!document.querySelector('[data-voicelayer-open]')), 9000);
      this.refresh();
    },
    /** bring the assistant back (from minimized or off). openPanel=true also opens it (never starts the mic) */
    restore: function (openPanel) {
      store.set(KEYS.off, null); store.set(KEYS.min, null);
      this.applyMode('on');
      if (openPanel) this.open(false);
      else { try { UI.orb.focus({ preventScroll: true }); } catch (e) {} }
      this.refresh();
    },
    hotkeyMatch: function (e) {
      const parts = String(CONFIG.hotkey).toLowerCase().split('+').map(function (s) { return s.trim(); });
      const key = parts[parts.length - 1];
      const want = { alt: parts.indexOf('alt') >= 0, shift: parts.indexOf('shift') >= 0, ctrl: parts.indexOf('ctrl') >= 0 || parts.indexOf('control') >= 0, meta: parts.indexOf('meta') >= 0 || parts.indexOf('cmd') >= 0 };
      if (e.altKey !== want.alt || e.shiftKey !== want.shift || e.ctrlKey !== want.ctrl || e.metaKey !== want.meta) return false;
      const code = (e.code || '').toLowerCase();
      return (e.key || '').toLowerCase() === key || code === 'key' + key || code === 'digit' + key;
    },
    hotkey: function () {
      if (this.mode !== 'on') return this.restore(true);
      if (UI.open) this.close(); else this.open(false);
    },

    /* ---------- proactive hint (silent, once per session, dismissible) ---------- */
    afterReveal: function () {
      const self = this;
      if (CONFIG.mode === 'glass' && this.mode === 'on' && CONFIG.glass.autoOpen !== false && !store.sget(KEYS.gdismiss)) { UI.setOpen(true, true); UI.setAwake(false); this.refresh(); }   // asleep: no mic, no speech until the visitor taps
      if (CONFIG.mode !== 'glass' && this.mode === 'on' && CONFIG.bubble && !store.sget(KEYS.bubble)) {
        this._bubbleT = setTimeout(function () { self.maybeBubble(); }, CONFIG.bubbleDelayMs);
      }
      // continue after an assistant-triggered navigation (panel re-opens; mic stays OFF)
      if (CONFIG.resumeAfterNavigation && store.sget(KEYS.resume) && this.mode !== 'off') {
        store.sset(KEYS.resume, null);
        const resume = function () {
          if (self.mode !== 'on') self.restore(false);
          self.open(false);
          self.say(M.resume(document.title), { silent: true });
        };
        if (document.readyState === 'complete') setTimeout(resume, 50); else window.addEventListener('load', function () { setTimeout(resume, 50); });
      }
    },
    bubbleContext: function () {
      const m = Scanner.map || Scanner.scan();
      const pref = /ship|envio|pric|preci|faq|contact|returns|devol/i;
      const nav = uniq(m.nav.map(function (n) { return n.text; }).filter(function (t) { return t && t.length < 26; }));
      const pick = nav.find(function (t) { return pref.test(norm(t)); }) || nav[1] || nav[0] || '';
      const prod = m.products[0] ? short(m.products[0].name, 28) : '';
      return { nav: pick, product: prod };
    },
    maybeBubble: function () {
      if (CONFIG.mode === 'glass') return;
      if (this.killed || this.mode !== 'on' || UI.open || this.touched || store.sget(KEYS.bubble)) return;
      store.sset(KEYS.bubble, '1');                                   // once per browser session, whatever happens next
      UI.showBubble(M.bubble(this.bubbleContext()));
      const self = this; clearTimeout(this._bubbleHide);
      this._bubbleHide = setTimeout(function () { UI.hideBubble(); }, CONFIG.bubbleMaxMs);
    },

    /* ---------- language ---------- */
    changeLanguage: async function (code, persist) {
      if (!PACKS[code] || code === LANG) return;
      const wasListening = Voice.isListening();
      this.stop(false);
      setLang(code, null, persist);
      Voice.resetVoice();
      UI.applyText();
      this.pending = null; this.findState = null;
      try { Companion.onLang(); } catch (e) {}
      try { window.dispatchEvent(new CustomEvent('voicelayer:language', { detail: { language: code } })); } catch (e) {}
      if (UI.bubbleShown()) UI.showBubble(M.bubble(this.bubbleContext()));
      this.say(M.langChanged);
      if (wasListening) { await sleep(60); this.startListening(); }   // the language click is the user's gesture
    },

    /* ---------- open / close / listening ---------- */
    open: function (listen) {
      if (this.mode !== 'on') { store.set(KEYS.off, null); store.set(KEYS.min, null); this.applyMode('on'); }
      if (CONFIG.mode === 'glass') {                              // glass opens asleep: the circle tap is the only thing that wakes it
        UI.setOpen(true); UI.setAwake(this.woke); store.sset(KEYS.gdismiss, null); this.checkRemote(); this.refresh(); this.glassEvent('open'); return;
      }
      UI.setOpen(true);
      this.checkRemote();
      if (!this.introDone) {
        this.introDone = true;
        if (!Voice.supportsRecognition()) UI.addLine('sys', M.noRec);
        if (!Voice.supportsSpeech()) UI.addLine('sys', M.noTTS);
        this.say(greetingText(), { silent: !CONFIG.speakGreeting });
      }
      if (listen && CONFIG.listenOnOpen && Voice.supportsRecognition()) this.startListening();
      this.refresh();
    },
    close: function () {
      this.stop(false); this.sleepUI();
      UI.setOpen(false); UI.setInterim('');
      if (CONFIG.mode === 'glass') { store.sset(KEYS.gdismiss, '1'); this.glassEvent('closed'); }
      this.refresh();
    },
    glassEvent: function (s) { try { window.dispatchEvent(new CustomEvent('voicelayer:glass', { detail: { state: s } })); } catch (e) {} },

    /** WAKE — the one tap that lets the assistant speak first. Greeting (+ first question) is spoken, THEN the mic opens. */
    wake: async function () {
      if (this.killed || this.mode !== 'on' || CONFIG.mode !== 'glass') return;
      if (!UI.open) UI.setOpen(true);
      this.woke = true; this.touched = true; this.introDone = true; Voice.unlock(); UI.setAwake(true);
      store.sset(KEYS.gdismiss, null);
      const tok = ++this.token, alive = function () { return tok === VL.token && VL.woke; };
      this.busy = false; this.glassEvent('awake');
      try {
        if (!Voice.supportsRecognition()) UI.addLine('sys', M.noRec);
        if (Companion.enabled()) await Companion.begin(alive);
        else await this.say(this.plainOpening());
        if (alive() && UI.open && Voice.supportsRecognition() && !Voice.isListening()) await this.startListening();   // mic opens AFTER the opening line, never over it
      } catch (e) { console.error('[VoiceLayer]', e); }
      this.refresh();
    },
    /** PAUSE — back to "tap to start": speech cancelled, mic released, glass stays visible */
    goToSleep: function () {
      this.stop(false); this.sleepUI(); UI.setInterim(''); this.glassEvent('asleep'); this.refresh();
    },
    /** the circle: asleep → wake · speaking → interrupt and listen · listening → pause the mic · otherwise → listen */
    onCircle: function () {
      if (!this.woke) return this.wake();
      if (Voice.isSpeaking()) {                                    // barge-in: drop the rest of what I was going to say
        this.token++; this.busy = false; this.speechStarted = false; Voice.cancelSpeech();
        return this.startListening();
      }
      if (this.busy) { this.stop(false); return; }
      this.toggleListening();
    },
    onOrb: function () {
      if (CONFIG.mode === 'glass') { if (!UI.open) this.open(false); return this.wake(); }   // the orb is an explicit "start" control
      if (!UI.open) return this.open(true);                       // tap = open + (consent gesture) start mic
      if (Voice.isSpeaking()) { Voice.cancelSpeech(); this.refresh(); return; }   // barge-in
      this.toggleListening();
    },
    toggleListening: function () { Voice.isListening() ? this.stopListening() : this.startListening(); },
    startListening: async function () {
      if (!Voice.supportsRecognition()) { this.say(M.noRecSay); return; }
      Voice.cancelSpeech();
      UI.setMicUI(true, true);
      const ok = await Voice.start();           // browser permission prompt happens here, inside the user's tap
      if (!ok) UI.setMicUI(false, true);
      this.refresh();
    },
    stopListening: function () { Voice.stop(); this.refresh(); },
    setMuted: function (m) {
      this.muted = !!m; store.set(KEYS.speak, m ? 'off' : 'on'); UI.setMuteUI(m);
      if (m) Voice.cancelSpeech();
      this.refresh();
    },
    onVoiceError: function (code) {
      UI.setMicUI(false, code !== 'unsupported');
      this.say(M.err(code, SPEECH_LANG), { silent: code !== 'idle-timeout' && code !== 'not-allowed' ? false : true });
      this.refresh();
    },
    stop: function (announce) {
      this.token++; this._acting = false;
      Voice.cancelSpeech(); Voice.stop();
      this.pending = null; this.busy = false; this.speechStarted = false;
      UI.clearRings(); UI.setInterim('');
      if (this._interrupt) this._interrupt();
      if (announce) UI.addLine('sys', M.stopped);
      this.refresh();
    },

    /* ---------- state ---------- */
    refresh: function () {
      if (this.killed) return;
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
    canSpeak: function () { return CONFIG.speak && !this.muted && Voice.supportsSpeech() && UI.open && (CONFIG.mode !== 'glass' || this.woke); },
    /** show a caption and (unless silent/muted) speak it. Interrupts anything currently being spoken. */
    say: function (text, o) {
      o = o || {};
      UI.addLine(o.kind || 'bot', text, { verified: o.verified });
      if (o.silent || !this.canSpeak()) { this.refresh(); return Promise.resolve(false); }
      this.lastSpoken = o.spoken || text;                     // `spoken` lets digits be read one by one while the caption stays readable
      return Voice.speak(o.spoken || text);
    },

    /* ---------- input ---------- */
    handleUtterance: function (text, source) {
      text = clean(text); if (!text) return;
      this.touched = true;
      if (source === 'voice') {
        const t = norm(text);
        if (Voice.isSpeaking()) {
          // we are talking: the mic may be hearing our own voice. Only an explicit stop word gets through.
          if (I.stopNow.test(t)) return this.stop(true);
          return;
        }
        // just finished talking: drop it ONLY if it looks like an echo of what we said (never drop a real command)
        if (performance.now() - this.lastSpeechEnd < 2500 && this.lastSpoken && t.split(' ').length >= 4) {
          const said = norm(this.lastSpoken);
          const words = t.split(' '), hit = words.filter(function (w) { return said.indexOf(w) >= 0; }).length;
          if (said.indexOf(t) >= 0 || hit / words.length >= 0.85) { log('ignored echo of own speech:', t); return; }
        }
      }
      UI.addLine('user', Forms.redact(text));
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
        let intent, viaPending = false;
        const pend = this.pending, t = norm(text);
        if ((CONFIG.mode === 'glass' || Companion.enabled()) && I.cp.crisisRe.test(t)) { await Companion.crisis(); return; }     // safety first: nothing else runs
        if (pend && performance.now() < pend.until) {
          const r = this.resolvePending(pend, t);
          if (r) { this.pending = null; intent = r; viaPending = true; }
          else if (pend.strict) this.pending = null;          // a skill's yes/no question lapses the moment the visitor says anything else
        } else this.pending = null;
        intent = intent || parse(text);
        if (!viaPending && intent.type === 'unknown') { const sk = parseSkills(text); if (sk) intent = sk; }
        try { window.dispatchEvent(new CustomEvent('voicelayer:command', { detail: { text: Forms.redact(text), intent: intent.type, arg: intent.type === 'formset' || intent.type === 'mem' ? '' : (intent.arg || ''), language: LANG } })); } catch (e) {}
        log('intent', intent);
        await sleep(CONFIG.thinkingMs);
        if (!alive()) return;
        if (!viaPending && CONFIG.mode === 'glass' && this.woke) {
          if (await this.glassCommand(t, alive)) return;
          if (Companion.engaged() && await Companion.intercept(text, intent, tok, alive)) return;
        }
        if (!viaPending && Knowledge.enabled() && await this.knowledge(text, intent, tok, alive)) return;
        if (intent.type === 'unknown' && typeof CONFIG.aiAnswer === 'function' && !(CONFIG.mode === 'glass' && Companion.engaged() && this.woke)) {
          if (await this.aiAnswerFlow(text, alive)) return;
        }
        if (!Scanner.map || Date.now() - Scanner.map.scannedAt > 1500) Scanner.scan();
        await this.exec(intent, tok, alive);
      } catch (e) {
        console.error('[VoiceLayer]', e);
        if (alive()) await this.say(M.error);
      } finally {
        if (alive()) this.setBusy(false);
      }
    },

    /** voice control of the glass itself (works in both languages) */
    aiAnswerFlow: async function (text, alive) {
      // Host-supplied brain (CONFIG.aiAnswer): answers open questions the rule
      // companion can't. Guardrails still apply — the reply is linted against
      // CP_LINT (no diagnose/treat/directive wording), truncated, attributed
      // as the host AI, and announced with a 'voicelayer:companion' event so
      // host analytics can record it.
      let reply = null;
      try {
        const r = await Promise.race([
          Promise.resolve().then(() => CONFIG.aiAnswer(text, { language: LANG })),
          new Promise((res) => setTimeout(() => res(null), 12000)),
        ]);
        reply = r && typeof r === 'object' ? (r.text || '') : (typeof r === 'string' ? r : '');
      } catch (e) { log('aiAnswer failed:', e && e.message); }
      reply = String(reply || '').trim();
      if (!reply || !alive()) return false;
      const fallback = LANG === 'es'
        ? 'Puedo compartir información general, pero para lo personal me limito a tus propios datos. Pregúntame por tus lecturas.'
        : 'I can share general information here, but for anything personal I stick to your own data — ask me about your readings.';
      const safe = CP_LINT.test(reply) ? fallback : reply.slice(0, 600);
      try { window.dispatchEvent(new CustomEvent('voicelayer:companion', { detail: { type: 'ai_answer', chars: safe.length, linted: safe !== reply.slice(0, 600) } })); } catch (e) {}
      await this.say(safe);
      return true;
    },

    /** voice control of the glass itself (works in both languages) */
    glassCommand: async function (t, alive) {
      const P = I.cp; let m;
      if (P.cmdMute.test(t)) { this.setMuted(true); await this.say(P.ackMute); return true; }
      if (P.cmdUnmute.test(t)) { this.setMuted(false); await this.say(P.ackUnmute); return true; }
      if (P.cmdSleep.test(t)) { await this.say(P.ackSleep); if (alive()) this.goToSleep(); return true; }
      if (P.cmdOff.test(t) && CONFIG.allowTurnOff) { this.turnOff(); return true; }
      if (P.cmdMin.test(t)) { this.close(); return true; }
      if ((m = t.match(P.cmdLang)) && P.langMap[m[1]] && (CONFIG.languages || []).indexOf(P.langMap[m[1]]) >= 0) { await this.changeLanguage(P.langMap[m[1]], true); return true; }
      return false;
    },
    resolvePending: function (pend, t) {
      if (pend.kind === 'confirm') {
        if (I.yes.test(t)) return { type: '_confirmed', run: pend.run };
        if (I.no.test(t)) return { type: '_declined', what: pend.label, onNo: pend.onNo };
        return null;                          // anything else = a new command; pending is dropped
      }
      if (pend.kind === 'choose') {
        if (I.no.test(t)) return { type: '_declined', what: M.that };
        const m = t.match(I.choose);
        if (m) {
          let n = I.ord[m[1]]; if (n === -1) n = pend.options.length;
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
      return this.say(M.chooseList(intro, list));
    },

    /* ---------- command execution ---------- */
    exec: async function (it, tok, alive) {
      switch (it.type) {
        case 'empty': return this.say(M.empty);
        case 'stop': return this.stop(true);
        case 'close': return this.close();
        case '_declined': UI.clearRings(); if (it.onNo) return it.onNo(tok, alive); return this.say(M.declined(it.what));
        case '_badchoice': return this.say(M.badChoice(it.max));
        case '_confirmed': return it.run(tok, alive);
        case '_chosen': UI.clearRings(); return it.option.run(tok, alive);
        case 'help': return this.say(M.help + (CONFIG.forms ? I.sk.help.forms : '') + (Memory.enabled() ? I.sk.help.memory : '') + (Knowledge.enabled() ? I.sk.help.knowledge : ''));
        case 'formset': return this.cmdFormSet(it, tok, alive);
        case 'formundo': return this.cmdFormUndo();
        case 'mem': return this.cmdMem(it, tok, alive);
        case 'about': return this.cmdAbout();
        case 'read': return this.cmdRead(it, tok, alive);
        case 'find': return this.cmdFind(it, tok, alive);
        case 'step': return this.cmdStep(it, tok, alive);
        case 'go': return this.cmdGo(it, tok, alive);
        case 'click': return this.cmdClick(it, tok, alive);
        case 'scrollto': {
          await this.say(it.where === 'top' ? M.toTop : M.toBottom);
          const y = it.where === 'top' ? 0 : document.documentElement.scrollHeight;
          try { window.scrollTo({ top: y, behavior: prefersReduced() ? 'auto' : 'smooth' }); } catch (e) { window.scrollTo(0, y); }
          return;
        }
        case 'scrollby': {
          const d = (it.dir === 'down' ? 1 : -1) * Math.round(window.innerHeight * 0.8);
          try { window.scrollBy({ top: d, behavior: prefersReduced() ? 'auto' : 'smooth' }); } catch (e) { window.scrollBy(0, d); }
          return this.say(M.scrolling(M.dir[it.dir]));
        }
        case 'history': {
          if (history.length <= 1) return this.say(M.noHistory);
          store.sset(KEYS.resume, '1'); history.back(); return this.say(M.goingBack);
        }
        default: return this.cmdUnknown(it);
      }
    },

    cmdAbout: function () {
      const m = Scanner.scan();
      const h1 = m.headings.find(function (h) { return h.level === 1; });
      const parts = [];
      parts.push(M.aboutThis(m.title || (h1 && h1.text) || M.aboutPage));
      if (m.description) parts.push(m.description.replace(/\s+/g, ' ').replace(/\.?$/, '.'));
      else if (h1 && m.title !== h1.text) parts.push(M.aboutHeading(h1.text));
      const secs = uniq(m.headings.filter(function (h) { return h.level === 2; }).map(function (h) { return h.text; })).slice(0, 6);
      if (secs.length) parts.push(M.aboutSections(secs.length, andList(secs)));
      if (m.products.length) {
        const vals = m.products.map(function (p) { return p.value; }).filter(Boolean).sort(function (a, b) { return a - b; });
        const cur = (m.products[0].price.match(/[$€£¥]/) || [LANG === 'es' ? '€' : '$'])[0];
        parts.push(M.aboutProducts(m.products.length, vals.length ? fmtPrice(vals[0], cur) : '', vals.length ? fmtPrice(vals[vals.length - 1], cur) : ''));
      }
      const btn = uniq(m.buttons.filter(function (b) { return !b.disabled; }).map(function (b) { return b.text; })).slice(0, 4);
      if (btn.length) parts.push(M.aboutButtons(andList(btn.map(function (b) { return '“' + b + '”'; }))));
      return this.say(parts.join(' '));
    },

    cmdRead: async function (it, tok, alive) {
      let root = mainEl(), label = M.onScreen;
      let blocks;
      if (it.arg) {
        const cands = goCandidates().filter(function (c) { return c.kind === 'section'; });
        const hits = rank(cands, it.arg, 0.6);
        if (!hits.length) return this.say(M.readNoSection(it.arg));
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
      if (!blocks.length) return this.say(M.readNothing);
      let text = '';
      for (let i = 0; i < blocks.length && text.length < CONFIG.maxReadChars; i++) {
        let s = clean(blocks[i].innerText); if (!s) continue;
        if (!/[.!?:;]$/.test(s)) s += '.';
        text += s + ' ';
      }
      text = text.trim();
      if (text.length > CONFIG.maxReadChars) text = text.slice(0, CONFIG.maxReadChars).replace(/\s+\S*$/, '') + '…';
      UI.addLine('sys', M.reading(label));
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
        return this.say(M.findNone(q, alt.length ? orList(alt) : ''));
      }
      this.findState = { q: q, els: els, i: 0 };
      return this.showFind(tok, alive, true, fuzzy);
    },
    showFind: async function (tok, alive, first, fuzzy) {
      const f = this.findState, el = f.els[f.i];
      const shown = f.els.slice(0, 8);
      UI.showRings(shown.map(function (e, i) { return { n: i + 1, getRect: rectOf(e) }; }), CONFIG.highlightMs);
      const ok = await scrollToEl(el, 'center', tok, alive); if (!ok || !alive()) return;
      const ctx = contextOf(el), n = f.els.length;
      const snippet = short(el.innerText || el.textContent, 80);
      return this.say(first ? M.findFirst(n, fuzzy, f.q, ctx, snippet) : M.findNext(f.i + 1, n, ctx, snippet));
    },
    cmdStep: async function (it, tok, alive) {
      const f = this.findState;
      if (!f || !f.els.length) return this.say(M.stepNothing);
      f.els = f.els.filter(function (e) { return e.isConnected; });
      if (!f.els.length) { this.findState = null; return this.say(M.stepGone); }
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
        return this.say(M.goNoMatch(q, opts.length ? orList(opts) : ''));
      }
      const top = hits[0];
      const close = hits.filter(function (h) { return h.score >= top.score - 0.1; });
      const clear = close.length === 1 || (top.score >= 0.99 && close.filter(function (h) { return h.score >= 0.99; }).length === 1);
      if (!clear) {
        const opts = close.slice(0, 4).map(function (h) {
          return { label: h.item.label + (h.item.kind === 'page' ? M.anotherPage : ''), pick: h.item.label, el: h.item.el.isConnected ? h.item.el : h.item.link,
            run: function (t, a) { return VL.goTo(h.item, t, a); } };
        });
        return this.askChoose(M.goChoose(close.length, q), opts, tok);
      }
      return this.goTo(top.item, tok, alive);
    },
    goTo: async function (c, tok, alive) {
      if (c.kind === 'page') {
        this.say(M.taking(c.label));
        await sleep(CONFIG.preClickDelayMs * 0.6); if (!alive()) return;
        UI.showRings([{ getRect: rectOf(c.link) }], 1500);
        await sleep(400); if (!alive()) return;
        this.markNavigating();
        this.receipt({ action: 'navigate', label: c.label, status: 'succeeded', verification: 'none', detail: 'page change cannot be verified before unload' });
        this.fireClick(c.link);
        return;
      }
      const el = c.el;
      this.say(M.going(c.label));
      const ok = await scrollToEl(el, 'top', tok, alive); if (!ok || !alive()) return;
      UI.showRings([{ getRect: rectOf(el.querySelector('h1,h2,h3,h4') || el) }], CONFIG.highlightMs);
      // read-back: is the target actually near the top of the viewport now?
      const r = el.getBoundingClientRect(), landed = r.top < window.innerHeight * 0.6 && r.bottom > 0;
      this.receipt({ action: 'scroll_to', label: c.label, status: landed ? 'succeeded' : 'unknown', verification: landed ? 'read_back' : 'none' });
      if (!landed) this.say(M.notInView(c.label));
    },
    markNavigating: function () {
      if (!CONFIG.resumeAfterNavigation) return;
      store.sset(KEYS.resume, '1'); setTimeout(function () { store.sset(KEYS.resume, null); }, 2500);  // cleared if no page change happened
    },

    cmdClick: async function (it, tok, alive) {
      const q = it.arg;
      const all = clickCandidates();
      const scoreOf = function (c) { return Math.max(score(q, c.text), c.ctx ? score(q, c.ctx + ' ' + c.text) : 0, c.ctx ? score(q, c.text + ' ' + c.ctx) : 0); };
      let hits = all.map(function (c) { return { item: c, score: scoreOf(c) }; }).filter(function (h) { return h.score >= 0.6; })
        .sort(function (a, b) { return b.score - a.score; });
      if (!hits.length) {
        const alt = uniq(all.filter(function (c) { return !c.disabled; }).sort(function (a, b) { return scoreOf(b) - scoreOf(a); }).filter(function (c) { return scoreOf(c) >= 0.3; }).map(describe)).slice(0, 4);
        const fb = alt.length ? alt : uniq(all.filter(function (c) { return c.kind === 'button' && !c.disabled; }).map(function (c) { return c.text; })).slice(0, 5);
        return this.say(M.clickNone(q, fb.length ? andList(fb) : ''));
      }
      const top = hits[0];
      const close = hits.filter(function (h) { return h.score >= top.score - 0.1; });
      if (close.length > 1) {
        const opts = close.slice(0, 5).map(function (h) {
          const c = h.item;
          return { label: describe(c), pick: c.ctx || c.text, el: c.el, run: function (t, a) { return VL.doClick(c, t, a, {}); } };
        });
        return this.askChoose(M.clickChoose(close.length, q), opts, tok);
      }
      return this.doClick(top.item, tok, alive, {});
    },

    /** The full click pipeline: guards → confirm → ring → pause (cancellable) → real events → read-back receipt */
    doClick: async function (c, tok, alive, o) {
      const label = describe(c);
      if (!c.el.isConnected || !isVisible(c.el)) return this.say(M.notVisible(label));
      if (isDisabled(c.el)) return this.say(M.disabled(label));
      // never touch payment / password forms
      const form = c.el.form || c.el.closest('form');
      if (form && form.querySelector('input[type="password"], input[autocomplete^="cc-"], input[name*="card" i], input[name*="cvv" i]'))
        return this.say(M.paymentForm);
      // sensitive action → explicit yes (word lists of ALL shipped languages, so a Spanish button on an English page is still caught)
      if (!o.confirmed && sensitiveRe().test(norm(c.text))) {
        UI.showRings([{ getRect: rectOf(c.el) }], 20000);
        this.pending = {
          kind: 'confirm', label: M.clickWhat(c.text), until: performance.now() + 20000,
          run: function (t, a) { return VL.doClick(c, t, a, { confirmed: true }); }
        };
        return this.say(M.confirmAsk(label));
      }
      // announce + highlight + scroll
      this._acting = true;
      try {
        this.say(M.clicking(label));
        const ok = await scrollToEl(c.el, 'center', tok, alive); if (!ok || !alive()) return;
        UI.showRings([{ getRect: rectOf(c.el) }], CONFIG.highlightMs);
        // cancellable pause: any real mouse/key input on the page means "the visitor wants control" → abort
        const proceed = await this.pause(CONFIG.preClickDelayMs, alive);
        if (!proceed || !alive()) { UI.clearRings(); this.say(M.stoppedBefore); return; }
        if (!c.el.isConnected || !isVisible(c.el) || isDisabled(c.el)) { UI.clearRings(); return this.say(M.pageChanged(label)); }

        // ---- read-back baseline ----
        const cartEl = document.querySelector(CONFIG.cartCountSelector);
        const isCartAction = !!cartEl && CART_WORDS.test(norm(c.text + ' ' + (c.el.getAttribute('aria-label') || '')));
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
            return this.say(M.doneCart(label, before, after), { verified: true });
          }
          this.receipt({ action: 'click', label: label, status: 'unknown', verification: 'none', before: before, after: after });
          return this.say(M.cartSame(label, after));
        }
        if (location.href !== url0) {
          this.receipt({ action: 'click', label: label, status: 'succeeded', verification: 'none', detail: 'url changed' });
          return this.say(M.urlChanged(label));
        }
        this.receipt({ action: 'click', label: label, status: 'unknown', verification: 'none', detail: mutations ? 'page updated' : 'no observable change' });
        return this.say(mutations ? M.updated(label) : M.noChange(label));
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


    /* ------------------------------------------------------------ skills: opening line */
    plainOpening: function () {
      const rt = Memory.ret(), base = CONFIG.greeting ? greetingText() : I.cp.plainGreet;
      if (rt) return I.sk.m.welcome(rt.name, rt.last) + ' ' + base;
      if (Memory.enabled() && !Memory.has() && !store.sget('voicelayer.memhint')) { store.sset('voicelayer.memhint', '1'); return base + ' ' + I.sk.m.hint; }
      return base;
    },
    /** ask a yes/no question that lapses on anything but an answer */
    ask: function (text, label, run, onNo, o) {
      this.pending = { kind: 'confirm', strict: true, label: label, until: performance.now() + 25000, run: run, onNo: onNo };
      return this.say(text, o);
    },

    /* ------------------------------------------------------------ skills: forms */
    cmdFormSet: async function (it, tok, alive) {
      const S = I.sk.f;
      if (!Forms.enabled()) return this.cmdUnknown(it);
      const cards = Forms.fields();
      if (!cards.length) return it.soft ? this.cmdUnknown(it) : this.say(S.noFields);
      if (SENS_FIELD.test(fnorm(it.field)) || SENS_FIELD.test(norm(it.field))) {       // the visitor NAMED a password/payment/ID field: refuse outright, whatever labels this page uses
        this.receipt({ action: 'fill_field', label: short(it.field, 40), status: 'refused', verification: 'none', detail: 'sensitive field requested by name' });
        return this.say(S.blocked(short(it.field, 40)));
      }
      const hits = Forms.match(cards, it.field);
      if (!hits.length) {
        if (it.soft) return this.cmdUnknown(it);
        const names = uniq(cards.filter(function (c) { return !c.blocked; }).map(function (c) { return c.label; })).slice(0, 5);
        return this.say(S.noField(it.field, names.length ? andList(names) : ''));
      }
      const top = hits[0], close = hits.filter(function (h) { return h.score >= top.score - 0.1; });
      if (close.length > 1) {
        const uniqEls = close.filter(function (h, i) { return close.findIndex(function (x) { return x.card.el === h.card.el; }) === i; });
        if (uniqEls.length > 1) {
          const opts = uniqEls.slice(0, 5).map(function (h) { return { label: h.card.label, pick: h.card.label, el: h.card.el, run: function (t, a) { return VL.formPrepare(h.card, it.value, t, a); } }; });
          return this.askChoose(S.which(uniqEls.length, it.field), opts, tok);
        }
      }
      return this.formPrepare(top.card, it.value, tok, alive);
    },
    formPrepare: async function (card, rawVal, tok, alive) {
      const S = I.sk.f, label = card.label;
      UI.clearRings();
      if (card.blocked) { this.receipt({ action: 'fill_field', label: label, status: 'refused', verification: 'none', detail: 'sensitive field (' + card.blocked + ')' }); return this.say(S.blocked(label)); }
      if (card.readonly) return this.say(S.readonly(label));
      if (/^(checkbox|radio|file|range|color|date)$/.test(card.kind)) return this.say(S.unsupported(label, S.kinds[card.kind] || S.kinds.other));
      const n = Forms.normalize(card, rawVal);
      if (n.err) return this.say(S.invalid(label, S.why[n.err] || S.why.pattern));
      const shown = n.optionText || n.value;
      const ok = await scrollToEl(card.el, 'center', tok, alive); if (!ok || !alive()) return;
      UI.showRings([{ getRect: rectOf(card.el) }], 25000);
      const spoken = Forms.speak(shown, card.kind);
      return this.ask(S.confirm(label, shown), S.what, function (t, a) { return VL.formApply(card, n, shown, t, a); }, function () { UI.clearRings(); return VL.say(M.declined(S.what)); }, { spoken: S.confirm(label, spoken) });
    },
    formApply: async function (card, n, shown, tok, alive) {
      const S = I.sk.f, label = card.label, el = card.el;
      const why = Forms.recheck(card);
      if (why === 'gone') { UI.clearRings(); return this.say(S.gone(label)); }
      if (why === 'readonly') { UI.clearRings(); return this.say(S.readonly(label)); }
      if (why) { UI.clearRings(); return this.say(S.blocked(label)); }
      this._acting = true;
      try {
        this.say(S.doing(label));
        UI.showRings([{ getRect: rectOf(el) }], CONFIG.highlightMs);
        const proceed = await this.pause(Math.min(CONFIG.preClickDelayMs, 700), alive);                 // a short, cancellable beat: touching the page cancels the change
        if (!proceed || !alive()) { UI.clearRings(); return this.say(S.stopped); }
        if (Forms.recheck(card)) { UI.clearRings(); return this.say(S.gone(label)); }
        const before = el.value;
        Forms.setValue(el, n.value);
        await sleep(160);                                                                              // let the page's own handlers (and any framework re-render) finish
        UI.clearRings();
        if (!alive()) return;
        const got = el.tagName === 'SELECT' ? (el.value === n.value ? shown : (el.options[el.selectedIndex] ? clean(el.options[el.selectedIndex].textContent) : '')) : el.value;
        const same = el.tagName === 'SELECT' ? el.value === n.value : Forms.same(card, n.value, got);
        if (same) {
          Forms.last = { el: el, before: before, label: label, kind: card.kind, after: n.value };
          this.receipt({ action: 'fill_field', label: label, status: 'succeeded', verification: 'read_back', detail: 'the field now holds the requested value' });
          return this.say(S.done(label, got), { verified: true, spoken: S.done(label, Forms.speak(got, card.kind)) });
        }
        this.receipt({ action: 'fill_field', label: label, status: 'unknown', verification: 'none', detail: 'the field does not hold the requested value after entry' });
        return this.say(S.mismatch(label, got));
      } finally { this._acting = false; }
    },
    cmdFormUndo: async function () {
      const S = I.sk.f, u = Forms.last;
      if (!u || !u.el.isConnected) { Forms.last = null; return this.say(S.undoNone); }
      if (Forms.blockedReason(u.el, Forms.labelsOf(u.el), Forms.kindOf(u.el, Forms.labelsOf(u.el)))) return this.say(S.blocked(u.label));
      Forms.setValue(u.el, u.before); await sleep(120);
      const ok = u.el.value === u.before; Forms.last = null;
      this.receipt({ action: 'undo_fill', label: u.label, status: ok ? 'succeeded' : 'unknown', verification: ok ? 'read_back' : 'none' });
      return this.say(ok ? S.undone(u.label) : S.undoFail(u.label), { verified: ok });
    },

    /* ------------------------------------------------------------ skills: memory */
    cmdMem: async function (it, tok, alive) {
      const S = I.sk.m;
      if (!Memory.enabled()) return this.say(S.off);
      const grantThen = async function (after) {
        const ok = Memory.grant();
        if (!ok) { Memory.d = null; if (after && after.sess) { Memory.sessName = after.sess; } return VL.say(S.noStore); }
        VL.receipt({ action: 'memory_consent', label: 'remember on this device', status: 'succeeded', verification: 'read_back', detail: 'saved and re-read from device storage' });
        if (after && after.name) { const k = Memory.setName(after.name); return VL.say(k ? S.savedName(after.name) : S.noStore); }
        if (after && after.fact) { const k = Memory.addFact(after.fact); return VL.say(k ? S.savedFact : S.noStore); }
        return VL.say(S.consentOk);
      };
      switch (it.act) {
        case 'enable':
          if (Memory.has() && Memory.d.paused) { Memory.d.paused = false; Memory.write(); return this.say(S.resumed); }
          if (Memory.has()) return this.say(S.alreadyOn);
          return this.ask(S.consentAsk, S.that, function () { return grantThen(); });
        case 'pause':
          if (!Memory.has()) return this.say(S.nothing);
          Memory.d.paused = true; Memory.write(); return this.say(S.paused);
        case 'name': {
          const v = clean(it.val).replace(/[.!?,;]+$/, '');
          if (!/^[\p{L}][\p{L}'’.\- ]{0,29}$/u.test(v) || v.split(' ').length > 3 || SENS_TEXT.test(norm(v))) return this.say(S.badName);
          const nm = v.replace(/(^|[\s-])(\p{L})/gu, function (a, p, c) { return p + c.toUpperCase(); }).replace(/^(\p{Lu})(\p{Lu}+)$/u, function (a, c, r) { return c + r.toLowerCase(); });
          if (Memory.active()) { const k = Memory.setName(nm); return this.say(k ? S.savedName(nm) : S.noStore); }
          if (Memory.has() && Memory.d.paused) { Memory.sessName = nm; return this.say(S.sessionName(nm)); }
          return this.ask(S.consentAskName(nm), S.that, function () { return grantThen({ name: nm, sess: nm }); }, function () { Memory.sessName = nm; return VL.say(S.sessionName(nm)); });
        }
        case 'fact': {
          const v = clean(it.val).replace(/[.!?]+$/, '');
          if (!v || v.length > 140) return this.say(S.badName);
          if (SENS_TEXT.test(norm(v)) || /\d{6,}/.test(v.replace(/\D+/g, ' ').replace(/\s/g, ''))) return this.say(S.refuse);
          if (Memory.active()) { const k = Memory.addFact(v); return this.say(k ? S.savedFact : S.noStore); }
          if (Memory.has() && Memory.d.paused) return this.say(S.paused);
          return this.ask(S.consentAskFact, S.that, function () { return grantThen({ fact: v }); });
        }
        case 'recall': {
          if (!Memory.has()) return this.say(S.recallNone);
          const d = Memory.d, parts = [];
          if (d.name) parts.push(S.rName(d.name));
          if (d.visits) parts.push(S.rVisits(d.visits));
          if (d.pages.length) parts.push(S.rPages(andList(uniq(d.pages.slice(-4).map(function (p) { return '“' + p.t + '”'; })))));
          if (d.facts.length) parts.push(S.rNotes(d.facts.map(function (f) { return f.t; })));
          if (!parts.length) return this.say(S.recallNone);
          return this.say(S.recall(andList(parts)));
        }
        case 'forgetname':
          if (!Memory.has() || !Memory.d.name) return this.say(S.nothing);
          return this.ask(S.forgetNameAsk, S.that, function () {
            const ok = Memory.forgetName();
            VL.receipt({ action: 'forget_name', label: 'name', status: ok ? 'succeeded' : 'unknown', verification: ok ? 'read_back' : 'none' });
            return VL.say(ok ? S.forgotName : S.forgotFail, { verified: ok });
          });
        case 'forget':
          if (!Memory.has() && !store.get(KEYS.mem) && !Memory.sessName) return this.say(S.nothing);
          return this.ask(S.forgetAsk, S.that, function () {
            const ok = Memory.wipe() && !store.get(KEYS.mem);
            VL.receipt({ action: 'forget_me', label: 'everything remembered', status: ok ? 'succeeded' : 'unknown', verification: ok ? 'read_back' : 'none', detail: ok ? 'device storage re-read: empty' : 'could not confirm' });
            return VL.say(ok ? S.forgot : S.forgotFail, { verified: ok });
          });
      }
    },

    /* ------------------------------------------------------------ skills: knowledge */
    knowledge: async function (text, intent, tok, alive) {
      const G = I.sg, K = I.sk.k, t = norm(text);
      if (!G || intent.type === 'empty' || intent.type === '_declined') return false;
      const question = G.q.test(t) || /\?\s*$/.test(String(text));
      const eligible = intent.type === 'unknown';                                  // never hijack a command the normal grammar already understood ("where is pricing", "go to faq")
      if (!eligible) return false;
      if (question && isMedAdvice(t)) {                                           // health ADVICE is never answered from a website
        let tail = '';
        const c = rank(goCandidates(), G.contactQ, 0.6)[0];
        if (c) { this.pending = { kind: 'confirm', strict: true, label: K.that, until: performance.now() + 25000, run: function (a, b) { return VL.goTo(c.item, a, b); } }; tail = K.medicalGo(c.item.label); }
        Knowledge.emit('medical_routed');
        await this.say(K.medical + tail); return true;
      }
      const res = await Knowledge.ask(text); if (!alive()) return true;
      if (!res.found || (!question && res.score < 0.75)) {
        if (!question) return false;                                              // not a question and no strong match: let the normal "didn't understand" path run
        Knowledge.emit('no_answer');
        const near = rank(goCandidates(), res.K.join(' '), 0.6)[0];
        if (near) { this.pending = { kind: 'confirm', strict: true, label: K.that, until: performance.now() + 25000, run: function (a, b) { return VL.goTo(near.item, a, b); } }; await this.say(K.none + K.noneSuggest(near.item.label)); }
        else await this.say(K.none + K.noneTip);
        return true;
      }
      const p = res.p; Knowledge.emit('answered', { source: p.owner ? 'owner' : (p.page || 'this page') });
      if (res.medical) { await this.say(K.medText(short(p.q, 60))); return true; }
      const cut = p.a.length > res.text.length + 25, away = !p.owner && p.url && p.url.split('#')[0] !== location.href.split('#')[0];
      const src = K.from(res.source);
      const canGo = (!p.owner && liveEl(p.el)) || away || (p.owner && p.url);
      const body = res.text.replace(/\s*$/, '');
      this.receipt({ action: 'answer_from_site', label: short(p.q, 60), status: 'succeeded', verification: 'none', detail: 'answered from ' + (p.owner ? 'owner notes' : 'page text') + '; match ' + res.score });
      if (canGo && (cut || away)) {
        this.pending = { kind: 'confirm', strict: true, label: K.that, until: performance.now() + 25000, run: function (a, b) { return VL.knowledgeGo(p, a, b); } };
        await this.say(body + ' ' + src + ' ' + K.goAsk);
      } else await this.say(body + ' ' + src);
      return true;
    },
    knowledgeGo: async function (p, tok, alive) {
      if (liveEl(p.el) && !(p.url && p.url.split('#')[0] !== location.href.split('#')[0])) {
        const ok = await scrollToEl(p.el, 'top', tok, alive); if (!ok || !alive()) return;
        UI.showRings([{ getRect: rectOf(p.el) }], CONFIG.highlightMs);
        return this.say(M.going(short(p.q, 60)));
      }
      if (p.url) {
        this.say(M.taking(short(p.q, 60))); await sleep(500); if (!alive()) return;
        this.markNavigating();
        this.receipt({ action: 'navigate', label: short(p.q, 60), status: 'succeeded', verification: 'none', detail: 'page change cannot be verified before unload' });
        location.href = p.url + (p.id ? '#' + p.id : '');
      }
    },

    cmdUnknown: function (it) {
      // a near-miss on a nav label / button is still helpful: offer it instead of failing silently
      const gc = rank(goCandidates(), it.arg, 0.7);
      const cc = rank(clickCandidates(), it.arg, 0.8, function (c) { return c.text; });
      if (gc.length) return this.say(M.unkGo(gc[0].item.label));
      if (cc.length) return this.say(M.unkClick(cc[0].item.text));
      return this.say(M.unknown(short(it.raw, 60)));
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
    /** visitor-control API (same as the panel buttons) */
    minimize: function () { VL.minimize(); },
    turnOff: function () { VL.turnOff(); },
    show: function () { VL.restore(true); },
    /** glass mode: wake (speak first, then listen) / pause. Wake only works from inside a user gesture (browser rule). */
    wake: function () { return VL.wake(); },
    pause: function () { VL.goToSleep(); },
    get awake() { return !!VL.woke; },
    /** feed the Companion fresh data: VoiceLayer.setSignals({ metrics:{…}, tasks:[…] }) */
    setSignals: function (s) { Companion.setSignals(s); },
    companion: {
      get enabled() { return Companion.enabled(); },
      get preset() { return Companion.cfg ? Companion.cfg.preset : null; },
      get stage() { return Companion.stage; },
      get insights() { return Companion.insights.map(function (x) { return { rule: x.rule, kind: x.kind, text: x.text, offer: x.offer ? x.offer.id : null, rx: x.rx ? x.rx.id : null }; }); },
      get rules() { return Companion.rules ? Companion.rules.map(function (r) { return r.id; }) : []; }
    },
    memory: {
      get enabled() { return Memory.enabled(); },
      get consented() { return Memory.has(); },
      get data() { return Memory.snapshot(); },
      forget: function () { return Memory.wipe(); }
    },
    knowledge: {
      get enabled() { return Knowledge.enabled(); },
      ask: async function (q) { const r = await Knowledge.ask(q); return r.found ? { found: true, text: r.text, source: r.source, score: r.score, medical: r.medical } : { found: false }; },
      get passages() { return Knowledge.enabled() ? Knowledge.passages().map(function (p) { return { q: p.q, page: p.page || '', owner: !!p.owner }; }) : []; }
    },
    forms: {
      get enabled() { return Forms.enabled(); },
      fields: function () { return Forms.fields().map(function (c) { return { label: c.label, kind: c.kind, blocked: c.blocked, readonly: c.readonly }; }); }
    },
    setLanguage: function (c) { return VL.changeLanguage(String(c || '').toLowerCase().split('-')[0], true); },
    get language() { return LANG; },
    get mode() { return VL.mode; },
    get engine() { return Voice.engine; },
    getSiteMap: function () { return Scanner.json(); },
    rescan: function () { Scanner.scan(); return Scanner.json(); },
    get receipts() { return VL.receipts.slice(); },
    get state() { return VL.state; },
    /** debug helpers (CONFIG.debug) — force any visual state without a mic */
    debug: {
      force: function (s) { UI.force(s); VL.refresh(); },
      level: function () { return UI.wave ? UI.wave.lastLevel : 0; },
      lite: function () { return !!(UI.radial && UI.radial.lite); },
      radius: function () { return UI.radial ? UI.radial.R : 0; },
      hasAnalyser: function () { return !!(UI.wave && UI.wave.analyser); },
      hasOutAnalyser: function () { return !!(UI.wave && UI.wave.outAnalyser); },
      parse: parse,
      parseSkills: parseSkills,
      pickVoice: function () { const v = Voice.pickVoice(); return v ? v.name : null; },
      parseLang: function (code, raw) { return (code === 'es' ? parseES : parseEN)(raw); },
      bubble: function () { return VL.maybeBubble(); },
      transport: function () { return Voice._dgTransport; }
    }
  };

  VL.init();
})();
