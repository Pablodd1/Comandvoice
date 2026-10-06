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

    // ---- voice engine ------------------------------------------------------------------------------------------
    provider: 'auto',                    // 'auto' = Deepgram when apiBase answers and has a key, else browser | 'browser' | 'deepgram'
    apiBase: '',                         // your server's voice routes, e.g. '/api/voice' ('' = browser voice only)
    speak: true,                         // speak replies out loud (visitor can also mute in the panel)
    speechRate: 1,                       // 0.5 – 2   (browser voice only)
    speechPitch: 1,                      // 0 – 2     (browser voice only)
    voiceName: '',                       // exact name of a preferred browser voice, or '' for automatic

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
    }
  })();
  if (!CONFIG.enabled) return;
  CONFIG.apiBase = String(CONFIG.apiBase || '').replace(/\/+$/, '');
  // opened from disk (file://) a relative API path can't work: use browser voice, make no network calls
  if (location.protocol === 'file:' && !/^https?:/i.test(CONFIG.apiBase)) CONFIG.apiBase = '';

  const VERSION = '0.2.0';
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
    off: 'voicelayer.off', min: 'voicelayer.min', bubble: 'voicelayer.bubble' };


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
      return pool.find(function (v) { return /natural|neural|google|samantha|monica|paulina|enhanced/i.test(v.name); }) || pool[0] || null;
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
      root.innerHTML =
        '<div class="vl-layer" id="vl-layer"></div>' +
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

      window.addEventListener('resize', function () { self.placeOrb(); if (self.open) self.positionPanel(); self.wave && self.wave.resize(); self._updateRings(); });
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
      qsa('[data-lang]', this.langBox).forEach(function (b) { b.setAttribute('aria-pressed', String(b.getAttribute('data-lang') === LANG)); });
      this.setState(this._state);
      this.setMuteUI(this._muted);
      this.setMicUI(this._listening, this._micAvail, this._micReason);
      this.setEngine(this._engine);
      if (this.open) this.positionPanel();
    },
    buildLangSwitch: function () {
      const self = this, box = this.langBox;
      box.innerHTML = '';
      const list = (CONFIG.languages || []).filter(function (c) { return PACKS[c]; });
      box.hidden = !(CONFIG.showLangSwitch && list.length > 1);
      list.forEach(function (c) {
        const b = document.createElement('button');
        b.type = 'button'; b.className = 'vl-langbtn'; b.setAttribute('data-lang', c);
        b.textContent = PACKS[c].short; b.title = PACKS[c].name; b.setAttribute('lang', c);
        b.setAttribute('aria-pressed', String(c === LANG));
        b.addEventListener('click', function () { self.h.onLang && self.h.onLang(c); });
        box.appendChild(b);
      });
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
    setOpen: function (on) {
      this.open = !!on;
      this.root.setAttribute('data-open', on ? 'true' : 'false');
      this.orb.setAttribute('aria-expanded', on ? 'true' : 'false');
      if (on) {
        this.hideBubble();
        this.positionPanel();
        this.wave && this.wave.resize();
        const self = this; setTimeout(function () { try { self.panel.focus({ preventScroll: true }); } catch (e) {} }, 30);
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
      this.wave && this.wave.setState(s);
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
    },
    setMuteUI: function (muted) {
      this._muted = !!muted;
      const T = this.T || I.ui;
      this.muteBtn.innerHTML = muted ? ICON.mute : ICON.vol;
      this.muteBtn.setAttribute('aria-pressed', String(!!muted));
      this.muteBtn.setAttribute('aria-label', muted ? T.unmute : T.mute); this.muteBtn.title = muted ? T.unmute : T.mute;
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
    mode: 'on', killed: false, touched: false, _bubbleT: 0, _bubbleHide: 0,

    init: function () {
      const self = this;
      // ---- language + visitor/owner switches (decided BEFORE anything is drawn) ----
      const L = resolveLang(); setLang(L.code, L.full, false);
      const q = (function () { try { return new URLSearchParams(location.search).get('voicelayer'); } catch (e) { return null; } })();
      if (q === 'on') { store.set(KEYS.off, null); store.set(KEYS.min, null); }
      if (q === 'off') store.set(KEYS.off, '1');
      this.mode = store.get(KEYS.off) === '1' ? 'off' : (store.get(KEYS.min) === '1' && CONFIG.allowMinimize ? 'min' : 'on');
      this.muted = store.get(KEYS.speak) === 'off';

      UI.build({
        onOrb: function () { self.touched = true; Voice.unlock(); self.onOrb(); },
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
    minimize: function () {
      this.stop(false); UI.setOpen(false); UI.setInterim('');
      store.set(KEYS.min, '1'); this.applyMode('min');
      try { UI.tab.focus({ preventScroll: true }); } catch (e) {}
      this.refresh();
    },
    turnOff: function () {
      this.stop(false); UI.setOpen(false); UI.setInterim('');
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
      if (this.mode === 'on' && CONFIG.bubble && !store.sget(KEYS.bubble)) {
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
      try { window.dispatchEvent(new CustomEvent('voicelayer:language', { detail: { language: code } })); } catch (e) {}
      if (UI.bubbleShown()) UI.showBubble(M.bubble(this.bubbleContext()));
      this.say(M.langChanged);
      if (wasListening) { await sleep(60); this.startListening(); }   // the language click is the user's gesture
    },

    /* ---------- open / close / listening ---------- */
    open: function (listen) {
      if (this.mode !== 'on') { store.set(KEYS.off, null); store.set(KEYS.min, null); this.applyMode('on'); }
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
        try { window.dispatchEvent(new CustomEvent('voicelayer:command', { detail: { text: text, intent: intent.type, arg: intent.arg || '', language: LANG } })); } catch (e) {}
        log('intent', intent);
        await sleep(CONFIG.thinkingMs);
        if (!alive()) return;
        if (!Scanner.map || Date.now() - Scanner.map.scannedAt > 1500) Scanner.scan();
        await this.exec(intent, tok, alive);
      } catch (e) {
        console.error('[VoiceLayer]', e);
        if (alive()) await this.say(M.error);
      } finally {
        if (alive()) this.setBusy(false);
      }
    },

    resolvePending: function (pend, t) {
      if (pend.kind === 'confirm') {
        if (I.yes.test(t)) return { type: '_confirmed', run: pend.run };
        if (I.no.test(t)) return { type: '_declined', what: pend.label };
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
        case '_declined': UI.clearRings(); return this.say(M.declined(it.what));
        case '_badchoice': return this.say(M.badChoice(it.max));
        case '_confirmed': return it.run(tok, alive);
        case '_chosen': UI.clearRings(); return it.option.run(tok, alive);
        case 'help': return this.say(M.help);
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
      hasAnalyser: function () { return !!(UI.wave && UI.wave.analyser); },
      hasOutAnalyser: function () { return !!(UI.wave && UI.wave.outAnalyser); },
      parse: parse,
      parseLang: function (code, raw) { return (code === 'es' ? parseES : parseEN)(raw); },
      bubble: function () { return VL.maybeBubble(); },
      transport: function () { return Voice._dgTransport; }
    }
  };

  VL.init();
})();
