/* The optional photo drop.
 *
 * "Show us the space" — a second input mode beside the scent textarea. This
 * file owns the whole control: picking, dropping, pasting, decoding,
 * compressing, previewing, removing.
 *
 * THE ORIGINAL FILE NEVER LEAVES THE DEVICE. A modern phone photo is 3-8MB and
 * 4000px wide; sending that is how photo uploads historically failed here. So
 * every image is re-encoded on a canvas first — long edge <= 1568px, JPEG,
 * quality stepped down until the result fits under ~1MB — and only that
 * re-encoded copy is turned into a data URL and posted as a normal JSON field.
 * One route, one content type, one code path on the server.
 *
 * Exposes window.VibinPhoto.attach(); public/js/home.js reads the compressed
 * data URL from the returned controller at submit time.
 */
(function () {
  /* 1568px is the long edge the vision model reasons at — larger costs image
   * tokens and buys nothing. (claude-sonnet-5 accepts up to 2576px; the design
   * doc fixes 1568 and a room's light, materials and texture read fine there.) */
  var MAX_EDGE = 1568;

  /* Hard output cap. Base64 inflates by 4/3, so ~1MB of JPEG is ~1.4MB on the
   * wire — inside the route's 4MB body limit with room to spare. */
  var MAX_BYTES = 1000000;

  /* Stepped down in order until one fits. 0.8 is the target; a photo that
   * still will not fit at 0.45 gets shrunk instead of degraded further. */
  var QUALITIES = [0.8, 0.72, 0.64, 0.55, 0.45];
  var SHRINK_ROUNDS = 3;
  var SHRINK_FACTOR = 0.75;

  var NOTES = {
    unreadable:
      'that image wouldn’t open here. a JPEG or PNG works — HEIC photos often need converting first.',
    heic:
      'this browser can’t open HEIC photos. share it as a JPEG (on iPhone: Settings → Camera → Formats → Most Compatible) and try again.',
    not_image: 'that wasn’t an image. drop a photo of the room.',
    too_large: 'that photo wouldn’t compress small enough. try a smaller one.',
  };

  function readable(bytes) {
    return bytes >= 1000000
      ? (bytes / 1048576).toFixed(1) + ' MB'
      : Math.round(bytes / 1024) + ' KB';
  }

  /* ---------------------------------------------------------------- decoding
   *
   * EXIF orientation is the classic silent bug: a portrait phone photo carries
   * "rotate 90°" as metadata, and a canvas draws the raw pixels, so the room
   * arrives on its side.
   *
   * Preferred path: createImageBitmap(file, {imageOrientation: 'from-image'}),
   * which applies the EXIF rotation during decode. Fallback path: an <img>
   * element — since Chrome 81 / Firefox 77 / Safari 13.1 the CSS
   * `image-orientation` initial value is `from-image`, so an <img> is already
   * oriented correctly and drawImage inherits that. We set the property
   * explicitly rather than relying on the default.
   *
   * The fallback also covers formats createImageBitmap rejects and engines that
   * reject the options bag itself; a format no decoder can read (HEIC on
   * Chrome/Firefox) fails both and surfaces a friendly note. */
  function decodeViaImg(file) {
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(file);
      var img = new Image();
      img.style.imageOrientation = 'from-image';
      img.onload = function () {
        URL.revokeObjectURL(url);
        resolve(img);
      };
      img.onerror = function () {
        URL.revokeObjectURL(url);
        reject(new Error('undecodable'));
      };
      img.src = url;
    });
  }

  function decode(file) {
    return new Promise(function (resolve, reject) {
      if (!window.createImageBitmap) {
        decodeViaImg(file).then(resolve, reject);
        return;
      }
      var attempt;
      try {
        attempt = window.createImageBitmap(file, { imageOrientation: 'from-image' });
      } catch (error) {
        decodeViaImg(file).then(resolve, reject);
        return;
      }
      attempt.then(resolve, function () {
        decodeViaImg(file).then(resolve, reject);
      });
    });
  }

  /* ------------------------------------------------------------- compressing */

  function drawTo(source, width, height) {
    var canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(width));
    canvas.height = Math.max(1, Math.round(height));
    var ctx = canvas.getContext('2d');
    // A JPEG has no alpha; without a white ground a transparent PNG would
    // re-encode with black behind it.
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
    return canvas;
  }

  function encode(canvas, quality) {
    return new Promise(function (resolve, reject) {
      if (canvas.toBlob) {
        canvas.toBlob(
          function (blob) {
            blob ? resolve(blob) : reject(new Error('encode failed'));
          },
          'image/jpeg',
          quality,
        );
        return;
      }
      // Ancient fallback: measure the data URL directly.
      try {
        var url = canvas.toDataURL('image/jpeg', quality);
        resolve({ size: Math.floor((url.length - url.indexOf(',') - 1) * 0.75), dataUrl: url });
      } catch (error) {
        reject(error);
      }
    });
  }

  function toDataUrl(blob) {
    if (blob.dataUrl) return Promise.resolve(blob.dataUrl);
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onload = function () {
        resolve(String(reader.result));
      };
      reader.onerror = function () {
        reject(new Error('read failed'));
      };
      reader.readAsDataURL(blob);
    });
  }

  /**
   * Decode -> fit the long edge -> encode, stepping quality down and then
   * dimensions down until the result is under the cap.
   * @returns {Promise<{dataUrl: string, bytes: number, width: number, height: number,
   *                    quality: number}>}
   */
  function compress(file) {
    return decode(file).then(function (source) {
      var width = source.width || source.naturalWidth;
      var height = source.height || source.naturalHeight;
      if (!width || !height) throw new Error('undecodable');

      var scale = Math.min(1, MAX_EDGE / Math.max(width, height));

      function round(remaining, best) {
        var canvas = drawTo(source, width * scale, height * scale);

        function tryQuality(index) {
          if (index >= QUALITIES.length) {
            if (remaining <= 1) return best;
            scale *= SHRINK_FACTOR;
            return round(remaining - 1, best);
          }
          return encode(canvas, QUALITIES[index]).then(function (blob) {
            var candidate = {
              blob: blob,
              bytes: blob.size,
              width: canvas.width,
              height: canvas.height,
              quality: QUALITIES[index],
            };
            if (blob.size <= MAX_BYTES) return candidate;
            // Keep the smallest we have seen, so a stubborn image still
            // produces the best available attempt rather than nothing.
            if (!best || blob.size < best.bytes) best = candidate;
            return tryQuality(index + 1);
          });
        }

        return tryQuality(0);
      }

      return round(SHRINK_ROUNDS, null).then(function (result) {
        if (!result) throw new Error('encode failed');
        if (result.bytes > MAX_BYTES) {
          var overCap = new Error('over cap');
          overCap.note = 'too_large';
          throw overCap;
        }
        return toDataUrl(result.blob).then(function (dataUrl) {
          return {
            dataUrl: dataUrl,
            bytes: result.bytes,
            width: result.width,
            height: result.height,
            quality: result.quality,
          };
        });
      });
    });
  }

  /* ------------------------------------------------------------------- UI */

  function looksHeic(file) {
    return /heic|heif/i.test(file.type || '') || /\.hei[cf]$/i.test(file.name || '');
  }

  function attach() {
    var field = document.getElementById('photo-field');
    var input = document.getElementById('photo');
    var drop = document.getElementById('photo-drop');
    var preview = document.getElementById('photo-preview');
    var thumb = document.getElementById('photo-thumb');
    var meta = document.getElementById('photo-meta');
    var remove = document.getElementById('photo-remove');
    var note = document.getElementById('photo-note');
    if (!field || !input || !drop || !preview || !thumb || !meta || !remove || !note) return null;

    var current = null; // {dataUrl, bytes, width, height, quality}
    var busy = false;
    var disabled = false;
    var listeners = [];

    function announce() {
      for (var i = 0; i < listeners.length; i++) listeners[i]();
    }

    function setNote(key) {
      if (!key) {
        note.hidden = true;
        note.textContent = '';
        return;
      }
      note.textContent = NOTES[key] || NOTES.unreadable;
      note.hidden = false;
    }

    function render() {
      field.classList.toggle('is-loaded', Boolean(current));
      field.classList.toggle('is-busy', busy);
      drop.hidden = Boolean(current) || busy;
      preview.hidden = !current && !busy;

      // Cleared unconditionally first: leaving a stale thumbnail or a stale
      // `data-bytes` behind after a remove would let anything watching this
      // element (a browser check, a future consumer) read the previous photo's
      // size as the current one.
      thumb.removeAttribute('src');
      preview.removeAttribute('data-bytes');

      if (busy) {
        meta.textContent = 'taking it in…';
        return;
      }
      if (current) {
        thumb.src = current.dataUrl;
        meta.textContent =
          'photo ready · ' + current.width + '×' + current.height + ' · ' + readable(current.bytes);
        // Read by the browser check and by anyone auditing what we send.
        preview.setAttribute('data-bytes', String(current.bytes));
        return;
      }
      meta.textContent = '';
    }

    function clear(quiet) {
      current = null;
      input.value = '';
      if (!quiet) setNote(null);
      render();
      announce();
    }

    function accept(file) {
      if (disabled || busy || !file) return;
      if (file.type && file.type.indexOf('image/') !== 0 && !looksHeic(file)) {
        setNote('not_image');
        return;
      }
      setNote(null);
      busy = true;
      current = null;
      render();
      announce();

      compress(file).then(
        function (result) {
          busy = false;
          current = result;
          render();
          announce();
          if (window.console && console.info) {
            console.info(
              '[photo] compressed to ' +
                readable(result.bytes) +
                ' (' +
                result.bytes +
                ' bytes) at ' +
                result.width +
                '×' +
                result.height +
                ', q=' +
                result.quality,
            );
          }
        },
        function (error) {
          busy = false;
          current = null;
          input.value = '';
          render();
          announce();
          setNote(error && error.note ? error.note : looksHeic(file) ? 'heic' : 'unreadable');
        },
      );
    }

    input.addEventListener('change', function () {
      accept(input.files && input.files[0]);
    });

    remove.addEventListener('click', function () {
      clear();
      // Focus has to land somewhere sensible when the button it was on leaves.
      input.focus();
    });

    /* Drag and drop, on the zone only. */
    ['dragenter', 'dragover'].forEach(function (name) {
      drop.addEventListener(name, function (event) {
        event.preventDefault();
        if (disabled || busy) return;
        drop.classList.add('is-over');
      });
    });
    ['dragleave', 'dragend'].forEach(function (name) {
      drop.addEventListener(name, function () {
        drop.classList.remove('is-over');
      });
    });
    drop.addEventListener('drop', function (event) {
      event.preventDefault();
      drop.classList.remove('is-over');
      var files = event.dataTransfer && event.dataTransfer.files;
      accept(files && files[0]);
    });

    /* A miss outside the zone would otherwise navigate away and take the
     * visitor's half-written description with it. */
    ['dragover', 'drop'].forEach(function (name) {
      document.addEventListener(name, function (event) {
        if (!drop.contains(event.target)) event.preventDefault();
      });
    });

    /* Paste — the fastest path from a screenshot to a score. */
    document.addEventListener('paste', function (event) {
      if (disabled || busy) return;
      var items = event.clipboardData && event.clipboardData.items;
      if (!items) return;
      for (var i = 0; i < items.length; i++) {
        if (items[i].kind === 'file') {
          var file = items[i].getAsFile();
          if (file && (file.type.indexOf('image/') === 0 || looksHeic(file))) {
            event.preventDefault();
            accept(file);
            return;
          }
        }
      }
    });

    render();

    return {
      dataUrl: function () {
        return current ? current.dataUrl : null;
      },
      bytes: function () {
        return current ? current.bytes : 0;
      },
      busy: function () {
        return busy;
      },
      clear: clear,
      setDisabled: function (value) {
        disabled = Boolean(value);
        input.disabled = disabled;
        remove.disabled = disabled;
      },
      onChange: function (fn) {
        listeners.push(fn);
      },
      setNote: setNote,
    };
  }

  window.VibinPhoto = { attach: attach, compress: compress, MAX_BYTES: MAX_BYTES, MAX_EDGE: MAX_EDGE };
})();
