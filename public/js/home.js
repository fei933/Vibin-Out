/* Home page behaviour. No framework, no build step.
 * Navigate-don't-inject: POST returns a slug, we go to the score page — the
 * same URL a stranger opening a shared link gets. One render path. */
(function () {
  var form = document.getElementById('score-form');
  if (!form) return;

  var textarea = document.getElementById('scent');
  var submit = document.getElementById('submit');
  var loading = document.getElementById('loading');
  var errorBox = document.getElementById('error');

  var MESSAGES = {
    cooldown:
      'The still is cooling down — we can only distil so many scents an hour. Try again a little later.',
    refused: 'This one’s not for us. Try describing a smell.',
    generation_failed:
      'That didn’t distil. Your description is still here — give it another go.',
    invalid_input: 'Give us a scent to work with — a few notes is plenty.',
    offline: 'No connection to the still. Check your network and try again.',
  };

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
  }

  Array.prototype.forEach.call(document.querySelectorAll('.example'), function (button) {
    button.addEventListener('click', function () {
      textarea.value = button.getAttribute('data-scent');
      textarea.focus();
    });
  });

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

    setBusy(true);
    fetch('/api/score', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    })
      .then(function (response) {
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
        setBusy(false);
        showError('offline');
      });
  });
})();
