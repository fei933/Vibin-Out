/* The drydown scroll — the one signature motion (.impeccable.md §4).
 *
 * As the reader moves from top notes to base notes, the page's accent
 * evaporates the way the scent does: citrine -> terracotta -> resin. It drives
 * two custom properties:
 *
 *   --accent       the raw palette, for graphics only (the wordmark's
 *                  apostrophe, which is logotype and therefore exempt from
 *                  contrast, and the arc's marker)
 *   --accent-text  the same hues darkened until they clear AA 4.5:1 on paper,
 *                  for anything a reader has to actually read (link
 *                  underlines, the phase eyebrows, track numbers)
 *
 * Both ramps darken monotonically, so every interpolated value between two
 * AA-safe stops is itself AA-safe.
 *
 * Reduced motion: no scroll listener at all. An IntersectionObserver snaps the
 * accent to the phase in view and CSS transitions crossfade it.
 */
(function () {
  var root = document.documentElement;
  var phases = Array.prototype.slice.call(document.querySelectorAll('.phase'));
  var segments = Array.prototype.slice.call(document.querySelectorAll('.arc-segment'));
  if (phases.length < 2) return;

  var GRAPHIC = [
    [217, 164, 65], // citrine  #D9A441
    [184, 85, 47], // terracotta #B8552F
    [74, 59, 42], // resin    #4A3B2A
  ];
  var TEXT = [
    [138, 101, 32], // #8A6520 — 4.7:1 on paper
    [160, 72, 31], // #A0481F — 5.4:1
    [107, 78, 46], // #6B4E2E — 6.8:1
  ];
  var NAMES = ['top', 'heart', 'base'];

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

  function apply(p) {
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
  function start() {
    if (reduced.matches) crossfade();
    else scrollLinked();
  }
  start();
})();
