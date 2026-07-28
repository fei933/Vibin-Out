/* The drydown scroll — one of the two permitted motions (.impeccable.md §5).
 *
 * As the reader moves from top notes to base notes, the page's accent settles
 * the way the scent does. In v2.1 that journey is TONAL DEPTH, not hue: in
 * mist it darkens vapour → stone → char; in slate it runs the other way, the
 * scent emerging out of the dark. Two custom properties carry it:
 *
 *   --accent       the raw tone, for graphics only (the arc's baseline rule).
 *                  The wordmark is deliberately NOT on this ramp — see the
 *                  note beside .wordmark .drop in app.css.
 *   --accent-text  the AA-safe twin, for anything a reader has to actually
 *                  read (link underlines, phase eyebrows, track numbers)
 *
 * The stops are NOT hardcoded here. They are read off the six --ramp-* tokens
 * in app.css, which is the single source of truth for the palette in both
 * themes — so a theme flip is a re-read, not a second copy of the colours.
 * Both ramps move monotonically in luminance, so every interpolated value
 * between two AA-safe stops is itself AA-safe.
 *
 * Reduced motion: no scroll listener at all. An IntersectionObserver snaps the
 * accent to the phase in view and CSS transitions crossfade it.
 */
(function () {
  var root = document.documentElement;
  var phases = Array.prototype.slice.call(document.querySelectorAll('.phase'));
  var segments = Array.prototype.slice.call(document.querySelectorAll('.arc-segment'));
  if (phases.length < 2) return;

  var NAMES = ['top', 'heart', 'base'];

  /* --- the ramps, read from CSS ------------------------------------------- */

  function parseColor(value) {
    var s = String(value).trim();
    var m = s.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
    if (m) {
      var h = m[1];
      if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
      return [
        parseInt(h.slice(0, 2), 16),
        parseInt(h.slice(2, 4), 16),
        parseInt(h.slice(4, 6), 16),
      ];
    }
    var n = s.match(/-?[\d.]+/g);
    if (n && n.length >= 3) return [Number(n[0]), Number(n[1]), Number(n[2])];
    return null;
  }

  var GRAPHIC = [];
  var TEXT = [];

  function readRamps() {
    var style = window.getComputedStyle(root);
    var graphic = [];
    var text = [];
    for (var i = 0; i < 3; i += 1) {
      var g = parseColor(style.getPropertyValue('--ramp-graphic-' + i));
      var t = parseColor(style.getPropertyValue('--ramp-text-' + i));
      if (!g || !t) return false;
      graphic.push(g);
      text.push(t);
    }
    GRAPHIC = graphic;
    TEXT = text;
    return true;
  }

  /* If the tokens cannot be read (very old browser, blocked stylesheet), leave
     --accent alone: the CSS defaults already point at the opening note, so the
     page is correct, just not scroll-linked. */
  if (!readRamps()) return;

  function rgb(c) {
    return 'rgb(' + c[0] + ',' + c[1] + ',' + c[2] + ')';
  }

  function mix(ramp, p) {
    var i = Math.max(0, Math.min(ramp.length - 2, Math.floor(p)));
    var t = Math.max(0, Math.min(1, p - i));
    var a = ramp[i];
    var b = ramp[i + 1];
    return rgb([
      Math.round(a[0] + (b[0] - a[0]) * t),
      Math.round(a[1] + (b[1] - a[1]) * t),
      Math.round(a[2] + (b[2] - a[2]) * t),
    ]);
  }

  var lastActive = -1;
  var lastProgress = 0;

  function apply(p) {
    lastProgress = p;
    root.style.setProperty('--accent', mix(GRAPHIC, p));
    root.style.setProperty('--accent-text', mix(TEXT, p));

    // floor, not round: the marker names the phase you are *inside*, so it
    // only advances once the next phase heading has actually come up.
    var active = Math.max(0, Math.min(segments.length - 1, Math.floor(p)));
    if (active === lastActive) return;
    lastActive = active;
    root.setAttribute('data-phase', NAMES[active] || 'top');
    for (var i = 0; i < segments.length; i += 1) {
      if (i === active) segments[i].setAttribute('data-active', '');
      else segments[i].removeAttribute('data-active');
    }
  }

  /* The ramp inverts between themes, and --accent is an inline style that
     would otherwise keep the old room's tone after a flip. */
  window.addEventListener('vibin:themechange', function () {
    if (readRamps()) apply(lastProgress);
  });

  /* --- scroll-linked (default) -------------------------------------------- */

  function progress() {
    // Measured live off the layout, so lazy embeds and font swaps can't
    // desynchronise the accent from what is actually on screen.
    var probe = window.innerHeight * 0.42;
    var tops = phases.map(function (el) {
      return el.getBoundingClientRect().top;
    });
    if (probe <= tops[0]) return 0;
    for (var i = 0; i < tops.length - 1; i += 1) {
      if (probe < tops[i + 1]) {
        var span = tops[i + 1] - tops[i];
        return i + (span > 0 ? (probe - tops[i]) / span : 0);
      }
    }
    return tops.length - 1;
  }

  function scrollLinked() {
    var queued = false;
    function frame() {
      queued = false;
      apply(progress());
    }
    function onScroll() {
      if (queued) return;
      queued = true;
      window.requestAnimationFrame(frame);
    }
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll, { passive: true });
    frame();
  }

  /* --- crossfade (prefers-reduced-motion) ---------------------------------- */

  function crossfade() {
    if (!('IntersectionObserver' in window)) {
      apply(0);
      return;
    }
    var observer = new IntersectionObserver(
      function (entries) {
        var best = null;
        entries.forEach(function (entry) {
          if (entry.isIntersecting) best = entry.target;
        });
        if (!best) return;
        apply(phases.indexOf(best));
      },
      { rootMargin: '-40% 0px -55% 0px', threshold: 0 },
    );
    phases.forEach(function (el) {
      observer.observe(el);
    });
    apply(0);
  }

  var reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
  if (reduced.matches) crossfade();
  else scrollLinked();
})();
