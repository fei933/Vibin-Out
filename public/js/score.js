/* Score page behaviour: copy the share link, and remix.
 * A remix replays the stored input through the whole pipeline and mints a
 * new slug — it counts against the same rate limits. */
(function () {
  var status = document.getElementById('action-status');
  var copyButton = document.getElementById('copy-link');
  var remixButton = document.getElementById('remix');

  function say(message) {
    if (!status) return;
    status.textContent = message;
    status.hidden = false;
  }

  if (copyButton) {
    copyButton.addEventListener('click', function () {
      var url = window.location.origin + copyButton.getAttribute('data-url');
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(url).then(
          function () {
            say('Link copied.');
          },
          function () {
            say(url);
          },
        );
      } else {
        say(url);
      }
    });
  }

  if (remixButton) {
    remixButton.addEventListener('click', function () {
      remixButton.disabled = true;
      say('distilling your scent…');

      fetch('/api/score', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ remix: remixButton.getAttribute('data-slug') }),
      })
        .then(function (response) {
          return response.json().catch(function () {
            return { error: 'generation_failed' };
          });
        })
        .then(function (body) {
          if (body && body.slug) {
            window.location.href = '/score/' + body.slug;
            return;
          }
          remixButton.disabled = false;
          say(
            body && body.error === 'cooldown'
              ? 'The still is cooling down. Try again a little later.'
              : 'That remix didn’t distill. Try again in a moment.',
          );
        })
        .catch(function () {
          remixButton.disabled = false;
          say('No connection to the still.');
        });
    });
  }
})();
