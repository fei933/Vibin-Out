/* The light/dark toggle — "mist" and "slate".
 *
 * The theme is already on <html> by the time this file runs: the inline script
 * in views/layout.hbs writes data-theme before first paint, which is the whole
 * reason there is no flash of the wrong room. This file only owns the *change*
 * — the click, the persistence, and telling the rest of the page.
 *
 * Contract with the rest of the app:
 *   document.documentElement[data-theme]  'light' | 'dark' — always present
 *   localStorage['vibin-theme']           only written on an explicit choice
 *   window event 'vibin:themechange'      detail: { theme }
 *
 * drydown.js listens for that event because the phase ramp inverts between
 * themes; share.js listens because the share card is composed in the palette
 * of the room you are currently in.
 */
(function () {
  var KEY = 'vibin-theme';
  var root = document.documentElement;
  var toggle = document.getElementById('theme-toggle');

  var BG = { light: '#FAFAF7', dark: '#161614' };
  var LABEL = {
    light: 'Theme: mist. Switch to slate.',
    dark: 'Theme: slate. Switch to mist.',
  };

  function stored() {
    try {
      var v = localStorage.getItem(KEY);
      return v === 'light' || v === 'dark' ? v : null;
    } catch (e) {
      return null;
    }
  }

  function current() {
    return root.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
  }

  /* The two <meta name="theme-color"> tags in the document track the *system*
     preference, which is the right answer until the reader overrides it. Once
     they do, collapse them into one unconditional tag so the browser chrome
     matches the page it is framing. */
  function paintBrowserChrome(theme) {
    var metas = document.querySelectorAll('meta[name="theme-color"]');
    for (var i = 1; i < metas.length; i += 1) metas[i].parentNode.removeChild(metas[i]);
    if (metas[0]) {
      metas[0].removeAttribute('media');
      metas[0].setAttribute('content', BG[theme]);
    }
  }

  function label(theme) {
    if (toggle) toggle.setAttribute('aria-label', LABEL[theme]);
  }

  function apply(theme, persist) {
    root.setAttribute('data-theme', theme);
    // The inline head script wrote this as an element style, which outranks
    // the stylesheet — so it has to move with the attribute or form controls
    // and scrollbars stay in the room the reader just left.
    root.style.colorScheme = theme;
    label(theme);
    if (persist) {
      paintBrowserChrome(theme);
      try {
        localStorage.setItem(KEY, theme);
      } catch (e) {
        /* A reader who cannot store a preference still gets to change it for
           this page; it simply will not survive the next navigation. */
      }
    }
    window.dispatchEvent(new CustomEvent('vibin:themechange', { detail: { theme: theme } }));
  }

  label(current());
  if (stored()) paintBrowserChrome(current());

  if (toggle) {
    toggle.addEventListener('click', function () {
      apply(current() === 'dark' ? 'light' : 'dark', true);
    });
  }

  /* No explicit choice on record → keep following the system if it changes
     mid-session (sunset, a scheduled switch). An explicit choice is final. */
  if (window.matchMedia) {
    var system = window.matchMedia('(prefers-color-scheme: dark)');
    var onSystem = function (event) {
      if (stored()) return;
      apply(event.matches ? 'dark' : 'light', false);
    };
    if (system.addEventListener) system.addEventListener('change', onSystem);
    else if (system.addListener) system.addListener(onSystem);
  }
})();
