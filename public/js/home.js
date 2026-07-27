/* Home page behaviour. No framework, no build step.
 * Navigate-don't-inject: POST returns a slug, we go to the score page — the
 * same URL a stranger opening a shared link gets. One render path. */
(function () {
  var form = document.getElementById('score-form');
  if (!form) return;

  var textarea = document.getElementById('scent');
  var submit = document.getElementById('submit');
  var loading = document.getElementById('loading');
  var loadingWait = loading.querySelector('.loading-wait');
  var loadingStep = loading.querySelector('.loading-step');
  var errorBox = document.getElementById('error');

  var MESSAGES = {
    cooldown:
      'The still is cooling down — we can only distill so many scents an hour. Try again a little later.',
    refused: 'This one’s not for us. Try describing a smell.',
    generation_failed:
      'That didn’t distill. Your description is still here — give it another go.',
    invalid_input: 'Give us a scent to work with — a few notes is plenty.',
    offline: 'No connection to the still. Check your network and try again.',
    timeout:
      'That one never came back. Your description is still here — try again, or ask for a shorter score.',
  };

  /* ---------------------------------------------------------------------
   * The wait
   *
   * Measured generation latency (2026-07-27 eval): ~18s for a 30-minute
   * score, ~50s for 60 minutes, up to ~2min for 90 minutes or deep cuts —
   * output size scales with the track quota, and deep cuts spend longer
   * being verified. Nobody waits two minutes politely for a page that only
   * says "distilling"; the honest number goes on screen before the request
   * leaves, rounded up so the estimate is a floor and not a promise.
   * ------------------------------------------------------------------- */

  var WAITS = {
    short: 'about half a minute — a short score is a short search.',
    medium: 'about a minute. an hour of music is a lot of records to pull.',
    long: 'up to two minutes — this one’s a proper dig through the crates.',
  };

  /* What is actually happening, in the order it happens: one model call reads
   * the description and shapes the arc, then every track it named is looked up
   * on Spotify and checked for being a real recording. These are cues, not
   * progress — if a stage runs long the line simply stays put, and the last
   * line holds until the answer arrives. */
  var STEPS = [
    'taking the scent apart.',
    'sorting it into top, heart, base.',
    'pulling records for each phase.',
    'making sure every track is real.',
  ];

  /* When to move to STEPS[1..3], per tier. Sized off the measured split: the
   * model call is most of the wait, resolution is the tail. */
  var STEP_AT = {
    short: [6000, 12000, 16000],
    medium: [17000, 34000, 44000],
    long: [38000, 75000, 96000],
  };

  var FADE_MS = 220;

  /* A backstop, not a deadline. lib/generateScore.js budgets itself 240s and
   * returns a friendly error of its own; this fires 30s later so the server's
   * answer always wins the race, and the client only steps in when nothing is
   * coming back at all. */
  var TIMEOUT_MS = 270000;

  function tierFor(duration, discovery) {
    if (duration === 90 || discovery === 'deepcuts') return 'long';
    if (duration === 60) return 'medium';
    return 'short';
  }

  /* Read live rather than cached: a visitor can change the setting mid-wait. */
  function prefersReducedMotion() {
    return !!(
      window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches
    );
  }

  var stepTimers = [];

  function clearStepTimers() {
    for (var i = 0; i < stepTimers.length; i++) window.clearTimeout(stepTimers[i]);
    stepTimers = [];
  }

  function showStep(text) {
    if (prefersReducedMotion()) {
      loadingStep.textContent = text;
      return;
    }
    loadingStep.classList.add('is-fading');
    stepTimers.push(
      window.setTimeout(function () {
        loadingStep.textContent = text;
        loadingStep.classList.remove('is-fading');
      }, FADE_MS),
    );
  }

  /* Called before the fetch, so the expectation is on screen from the first
   * frame of the wait and gets announced with the rest of the live region. */
  function beginWait(tier) {
    clearStepTimers();
    loadingWait.textContent = WAITS[tier];
    loadingStep.classList.remove('is-fading');
    loadingStep.textContent = STEPS[0];

    STEP_AT[tier].forEach(function (at, index) {
      stepTimers.push(
        window.setTimeout(function () {
          showStep(STEPS[index + 1]);
        }, at),
      );
    });
  }

  function endWait() {
    clearStepTimers();
    loadingStep.classList.remove('is-fading');
    loadingWait.textContent = '';
    loadingStep.textContent = '';
  }

  function showError(code) {
    errorBox.textContent = MESSAGES[code] || MESSAGES.generation_failed;
    errorBox.hidden = false;
  }

  function setBusy(busy) {
    loading.hidden = !busy;
    submit.disabled = busy;
    textarea.readOnly = busy;
    Array.prototype.forEach.call(form.querySelectorAll('input'), function (input) {
      input.disabled = busy;
    });
    if (!busy) endWait();
  }

  form.addEventListener('submit', function (event) {
    event.preventDefault();
    errorBox.hidden = true;

    var data = new FormData(form);
    var payload = {
      input: String(data.get('input') || ''),
      duration: Number(data.get('duration')),
      discovery: String(data.get('discovery') || 'balanced'),
    };
    if (!payload.input.trim()) {
      showError('invalid_input');
      return;
    }

    beginWait(tierFor(payload.duration, payload.discovery));
    setBusy(true);

    var controller = window.AbortController ? new window.AbortController() : null;
    var timedOut = false;
    var timeoutId = window.setTimeout(function () {
      timedOut = true;
      if (controller) controller.abort();
    }, TIMEOUT_MS);

    fetch('/api/score', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller ? controller.signal : undefined,
    })
      .then(function (response) {
        window.clearTimeout(timeoutId);
        return response.json().catch(function () {
          return { error: 'generation_failed' };
        });
      })
      .then(function (body) {
        // The input is never cleared, so a retry costs the visitor nothing.
        if (body && body.slug) {
          window.location.href = '/score/' + body.slug;
          return;
        }
        setBusy(false);
        showError(body && body.error);
      })
      .catch(function () {
        window.clearTimeout(timeoutId);
        setBusy(false);
        // An abort we asked for is a timeout; anything else is the network.
        showError(timedOut ? 'timeout' : 'offline');
      });
  });
})();
