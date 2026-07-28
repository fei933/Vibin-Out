/* The share kit — a QR code of this score's address, and a card you can send.
 *
 * Both are made entirely in the browser. No API, no upload, no tracking, no
 * network call of any kind beyond the album covers the page already loaded:
 * the QR is encoded here (public/js/vendor/qrcode.js, MIT) and the card is
 * composed on an offscreen canvas in the same type and the same tonal palette
 * as the room you are currently standing in.
 *
 * Everything the card needs is read out of the rendered page rather than a
 * second data payload, so the card can never disagree with the score above it.
 *
 * Degradation, in order of how likely it is:
 *   no qrcode global      → the plate stays hidden, the card is composed
 *                           without a code, the button still works
 *   a cover fails CORS    → that cover is dropped, the card keeps its layout
 *   toBlob / share fails  → a plain download; if that fails too, a sentence in
 *                           #action-status. Never a button that does nothing.
 */
(function () {
  var CARD_W = 1080;
  var CARD_H = 1920;
  var MARGIN = 96;

  var article = document.getElementById('score');
  var status = document.getElementById('action-status');
  var plate = document.getElementById('qr-plate');
  var qrCanvas = document.getElementById('qr-canvas');
  var saveButton = document.getElementById('save-card');
  if (!article) return;

  var slug = article.getAttribute('data-slug') || '';
  var url = window.location.origin + '/score/' + slug;

  function say(message) {
    if (!status) return;
    status.textContent = message;
    status.hidden = false;
  }

  function token(name) {
    return window.getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  }

  /* --- QR ------------------------------------------------------------------
   * Type 0 lets the encoder pick the smallest version that fits; correction
   * level M is the usual compromise — enough redundancy to survive a phone
   * camera at an angle without inflating the module count (and the printed
   * size) the way H would.
   */
  var QUIET = 4; // modules; the spec's minimum quiet zone, and non-negotiable

  function encode(text) {
    if (typeof window.qrcode !== 'function') return null;
    try {
      var qr = window.qrcode(0, 'M');
      qr.addData(text);
      qr.make();
      return qr;
    } catch (error) {
      return null;
    }
  }

  /* Draws at a whole number of pixels per module — anything else and the
     modules land between pixels, which is how a QR stops scanning. */
  function paintQr(qr, ctx, x, y, scale, plateColor, inkColor) {
    var count = qr.getModuleCount();
    var side = (count + QUIET * 2) * scale;
    ctx.fillStyle = plateColor;
    ctx.fillRect(x, y, side, side);
    ctx.fillStyle = inkColor;
    for (var r = 0; r < count; r += 1) {
      for (var c = 0; c < count; c += 1) {
        if (!qr.isDark(r, c)) continue;
        ctx.fillRect(x + (c + QUIET) * scale, y + (r + QUIET) * scale, scale, scale);
      }
    }
    return side;
  }

  var pageQr = encode(url);

  if (pageQr && qrCanvas && plate) {
    (function () {
      var dpr = window.devicePixelRatio || 1;
      var count = pageQr.getModuleCount() + QUIET * 2;
      // ~160 CSS px on screen: big enough to scan from another phone across a
      // counter, small enough to sit beside the copy rather than dominate it.
      var scale = Math.max(2, Math.round((160 * dpr) / count));
      var side = count * scale;
      qrCanvas.width = side;
      qrCanvas.height = side;
      qrCanvas.style.width = side / dpr + 'px';
      qrCanvas.style.height = side / dpr + 'px';
      var ctx = qrCanvas.getContext('2d');
      paintQr(pageQr, ctx, 0, 0, scale, token('--qr-plate') || '#F2F2EE', token('--qr-ink') || '#1C1C1A');
      qrCanvas.setAttribute('role', 'img');
      qrCanvas.setAttribute('aria-label', 'QR code for ' + url);
      plate.hidden = false;
    })();
  }

  /* --- reading the page ---------------------------------------------------- */

  function text(node) {
    return node ? node.textContent.replace(/\s+/g, ' ').trim() : '';
  }

  function readScore() {
    var tracks = [];
    var items = article.querySelectorAll('li.track');
    for (var i = 0; i < items.length; i += 1) {
      tracks.push({
        title: text(items[i].querySelector('.track-title')),
        artist: text(items[i].querySelector('.track-artist')),
      });
    }
    var arc = [];
    var segments = article.querySelectorAll('.arc-segment');
    for (var j = 0; j < segments.length; j += 1) {
      arc.push({
        name: segments[j].getAttribute('data-name') || '',
        pct: Number(segments[j].getAttribute('data-pct')) || 0,
      });
    }
    var covers = [];
    var images = document.querySelectorAll('.halo-tile img');
    for (var k = 0; k < images.length && covers.length < 5; k += 1) {
      covers.push(images[k].getAttribute('src'));
    }
    return {
      title: text(article.querySelector('.score-head h1')),
      interpretation: text(article.querySelector('.interpretation')),
      meta: text(article.querySelector('.meta')),
      tracks: tracks,
      arc: arc,
      covers: covers,
    };
  }

  /* --- canvas helpers ------------------------------------------------------ */

  function wrap(ctx, string, maxWidth, maxLines) {
    var words = string.split(' ');
    var lines = [];
    var line = '';
    for (var i = 0; i < words.length; i += 1) {
      var next = line ? line + ' ' + words[i] : words[i];
      if (ctx.measureText(next).width <= maxWidth || !line) {
        line = next;
      } else {
        lines.push(line);
        line = words[i];
        if (lines.length === maxLines) break;
      }
    }
    if (lines.length < maxLines && line) lines.push(line);
    if (lines.length === maxLines) {
      var last = lines[maxLines - 1];
      if (ctx.measureText(last).width > maxWidth) lines[maxLines - 1] = clip(ctx, last, maxWidth);
    }
    return lines;
  }

  function clip(ctx, string, maxWidth) {
    if (ctx.measureText(string).width <= maxWidth) return string;
    var out = string;
    while (out.length > 1 && ctx.measureText(out + '…').width > maxWidth) {
      out = out.slice(0, -1);
    }
    return out.replace(/[\s—–-]+$/, '') + '…';
  }

  /* Covers are loaded with crossOrigin="anonymous". Spotify's image CDN sends
     `access-control-allow-origin: *` (verified 2026-07-27), so the canvas is
     never tainted and toBlob keeps working. If that ever changes the request
     fails outright rather than silently poisoning the canvas — which is why
     this is a probe with a resolve-null failure path and not a try/catch
     around toBlob. */
  function loadCover(src) {
    return new Promise(function (resolve) {
      var image = new Image();
      image.crossOrigin = 'anonymous';
      image.onload = function () {
        resolve(image);
      };
      image.onerror = function () {
        resolve(null);
      };
      image.src = src;
    });
  }

  function loadFonts() {
    if (!document.fonts || !document.fonts.load) return Promise.resolve();
    return Promise.all([
      document.fonts.load('500 88px Fraunces'),
      document.fonts.load('500 36px Fraunces'),
      document.fonts.load('italic 400 40px Newsreader'),
      document.fonts.load('400 26px "IBM Plex Mono"'),
      document.fonts.load('500 26px "IBM Plex Mono"'),
      document.fonts.load('500 22px "IBM Plex Mono"'),
    ]).then(function () {
      return document.fonts.ready;
    });
  }

  /* --- the card ------------------------------------------------------------ */

  function compose(score, covers) {
    var canvas = document.createElement('canvas');
    canvas.width = CARD_W;
    canvas.height = CARD_H;
    var ctx = canvas.getContext('2d');

    var bg = token('--bg');
    var ink = token('--ink');
    var inkSoft = token('--ink-soft');
    var ink2 = token('--ink-2');
    var rule = token('--rule');
    var link = token('--link');
    var ramp = [token('--ramp-graphic-0'), token('--ramp-graphic-1'), token('--ramp-graphic-2')];
    var inner = CARD_W - MARGIN * 2;

    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, CARD_W, CARD_H);
    ctx.textBaseline = 'alphabetic';

    var y = MARGIN + 44;

    // Wordmark — the apostrophe is the one accent, exactly as on the page.
    ctx.font = '500 36px Fraunces, Georgia, serif';
    var mark = 'vibin’ out';
    var cursor = MARGIN;
    for (var m = 0; m < mark.length; m += 1) {
      ctx.fillStyle = mark[m] === '’' ? link : ink;
      ctx.fillText(mark[m], cursor, y);
      cursor += ctx.measureText(mark[m]).width + 8.6;
    }

    y += 74;

    // The covers: the card's only colour, same as the page's only colour.
    if (covers.length) {
      var size = 160;
      var gap = 16;
      var cx = MARGIN;
      for (var c = 0; c < covers.length && cx + size <= CARD_W - MARGIN; c += 1) {
        ctx.drawImage(covers[c], cx, y, size, size);
        ctx.strokeStyle = rule;
        ctx.lineWidth = 2;
        ctx.strokeRect(cx + 1, y + 1, size - 2, size - 2);
        cx += size + gap;
      }
      y += size + 76;
    } else {
      y += 24;
    }

    // Title
    ctx.fillStyle = ink;
    ctx.font = '500 88px Fraunces, Georgia, serif';
    var titleLines = wrap(ctx, score.title, inner, 3);
    for (var t = 0; t < titleLines.length; t += 1) {
      y += 96;
      ctx.fillText(titleLines[t], MARGIN, y);
    }

    // Interpretation
    y += 56;
    ctx.fillStyle = inkSoft;
    ctx.font = 'italic 400 40px Newsreader, Georgia, serif';
    var readLines = wrap(ctx, score.interpretation, inner, 4);
    for (var r = 0; r < readLines.length; r += 1) {
      y += 54;
      ctx.fillText(readLines[r], MARGIN, y);
    }

    // The tonal arc — the same three-act shape, the same tones.
    y += 72;
    var ax = MARGIN;
    for (var a = 0; a < score.arc.length; a += 1) {
      var w = Math.round((inner * score.arc[a].pct) / 100);
      if (a === score.arc.length - 1) w = MARGIN + inner - ax;
      ctx.fillStyle = ramp[Math.min(a, ramp.length - 1)] || ink2;
      ctx.fillRect(ax, y, w, 16);
      ax += w;
    }
    y += 16;
    ctx.fillStyle = rule;
    ctx.fillRect(MARGIN, y, inner, 2);

    y += 40;
    ctx.fillStyle = ink2;
    ctx.font = '500 22px "IBM Plex Mono", monospace';
    var lx = MARGIN;
    for (var s = 0; s < score.arc.length; s += 1) {
      var label = score.arc[s].name.toUpperCase() + ' · ' + score.arc[s].pct + '%';
      ctx.fillText(label, lx, y);
      lx += Math.round((inner * score.arc[s].pct) / 100);
    }

    /* The share block anchors the bottom of the card, so the tracklist gets
       whatever is left — "as many as fits cleanly", counted rather than
       guessed. */
    var qr = encode(url);
    var qrScale = qr ? Math.max(2, Math.floor(216 / (qr.getModuleCount() + QUIET * 2))) : 0;
    var qrSide = qr ? (qr.getModuleCount() + QUIET * 2) * qrScale : 0;
    var footTop = CARD_H - MARGIN - Math.max(qrSide, 120);

    y += 64;
    var lineHeight = 46;
    var available = Math.max(0, Math.floor((footTop - 72 - y) / lineHeight));
    // Everything fits, or the last available line is spent saying how much did
    // not. Never a tracklist that runs under the QR.
    var shown = score.tracks.length <= available ? score.tracks.length : Math.max(0, available - 1);

    for (var i = 0; i < shown; i += 1) {
      y += lineHeight;
      var n = i + 1 < 10 ? '0' + (i + 1) : String(i + 1);
      ctx.fillStyle = ink2;
      ctx.font = '500 26px "IBM Plex Mono", monospace';
      ctx.fillText(n, MARGIN, y);
      ctx.fillStyle = ink;
      ctx.font = '400 26px "IBM Plex Mono", monospace';
      var row = score.tracks[i].title + ' — ' + score.tracks[i].artist;
      ctx.fillText(clip(ctx, row, inner - 64), MARGIN + 64, y);
    }
    if (score.tracks.length - shown > 0) {
      y += lineHeight;
      ctx.fillStyle = ink2;
      ctx.font = '400 26px "IBM Plex Mono", monospace';
      ctx.fillText('+' + (score.tracks.length - shown) + ' more', MARGIN + 64, y);
    }

    // The address, as a code and as words.
    var footY = CARD_H - MARGIN - Math.max(qrSide, 120);
    if (qr) {
      paintQr(qr, ctx, MARGIN, footY, qrScale, token('--qr-plate') || '#F2F2EE', token('--qr-ink') || '#1C1C1A');
    }
    /* Host and path on separate lines. A slug is long, the column beside a QR
       is not, and an address ending in an ellipsis is not an address. */
    var textX = MARGIN + (qr ? qrSide + 40 : 0);
    var textW = inner - (textX - MARGIN);
    var address = url.replace(/^https?:\/\//, '');
    var split = address.indexOf('/');
    var host = split > 0 ? address.slice(0, split) : address;
    var pathname = split > 0 ? address.slice(split) : '';

    ctx.fillStyle = ink;
    ctx.font = '500 26px "IBM Plex Mono", monospace';
    ctx.fillText(clip(ctx, host, textW), textX, footY + 52);
    ctx.fillStyle = ink2;
    ctx.font = '400 24px "IBM Plex Mono", monospace';
    if (pathname) ctx.fillText(clip(ctx, pathname, textW), textX, footY + 92);
    ctx.font = '400 22px "IBM Plex Mono", monospace';
    ctx.fillText(clip(ctx, score.meta, textW), textX, footY + 140);
    ctx.fillText('a scent, read as a playlist', textX, footY + 178);

    return canvas;
  }

  function toBlob(canvas) {
    return new Promise(function (resolve, reject) {
      if (!canvas.toBlob) {
        reject(new Error('no toBlob'));
        return;
      }
      canvas.toBlob(function (blob) {
        if (blob) resolve(blob);
        else reject(new Error('no blob'));
      }, 'image/png');
    });
  }

  function download(blob, name) {
    var href = URL.createObjectURL(blob);
    var link = document.createElement('a');
    link.href = href;
    link.download = name;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    setTimeout(function () {
      URL.revokeObjectURL(href);
    }, 4000);
  }

  if (saveButton) {
    saveButton.addEventListener('click', function () {
      saveButton.disabled = true;
      var original = saveButton.textContent;
      saveButton.textContent = 'Composing…';
      say('Setting the card…');

      var score = readScore();

      Promise.all([loadFonts(), Promise.all(score.covers.map(loadCover))])
        .then(function (results) {
          var covers = results[1].filter(Boolean);
          var canvas = compose(score, covers);
          return toBlob(canvas);
        })
        .then(function (blob) {
          var name = (slug || 'drydown-score') + '.png';
          var file = null;
          try {
            file = new File([blob], name, { type: 'image/png' });
          } catch (error) {
            file = null;
          }
          if (file && navigator.canShare && navigator.canShare({ files: [file] }) && navigator.share) {
            return navigator
              .share({ files: [file], title: score.title, text: url })
              .then(function () {
                say('Sent.');
              })
              .catch(function (error) {
                // A cancelled sheet is not a failure — say nothing further.
                if (error && error.name === 'AbortError') {
                  say('');
                  if (status) status.hidden = true;
                  return;
                }
                download(blob, name);
                say('Card saved.');
              });
          }
          download(blob, name);
          say('Card saved.');
          return undefined;
        })
        .catch(function () {
          say('The card wouldn’t set. The link still works — copy it instead.');
        })
        .then(function () {
          saveButton.disabled = false;
          saveButton.textContent = original;
        });
    });
  }
})();
