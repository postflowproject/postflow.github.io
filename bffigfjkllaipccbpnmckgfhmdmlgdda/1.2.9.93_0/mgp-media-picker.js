let selectedFiles = [];

const input     = document.getElementById('fileInput');

// v2026-10-16 · the window in the user's language (tr/pickerLang: mgp-media-picker-i18n.js, loaded first). If that file
// did not load, the keys show instead of words, but picking and uploading still work.
if (typeof tr !== 'function') { globalThis.tr = (k) => k; globalThis.pickerLang = () => 'en'; }
try {
  document.documentElement.lang = pickerLang();
  document.title = tr('headerTitle');
  document.querySelectorAll('[data-i18n]').forEach((el) => { el.textContent = tr(el.getAttribute('data-i18n')); });
} catch (_) {}

// v2026-09-23: opened for a first comment (`?for=comment`) — ONE photo, no video.
// The popup claims the first new image as the comment's photo and deletes anything
// else, so the picker says the same thing up front instead of surprising the user.
const FOR_COMMENT = (() => {
  try { return new URLSearchParams(location.search).get('for') === 'comment'; } catch (_) { return false; }
})();
if (FOR_COMMENT) {
  try {
    input.multiple = false;
    input.accept = 'image/*';
    document.title = tr('commentTitle');
    const h1 = document.querySelector('.header h1, h1');
    if (h1) h1.textContent = tr('commentTitle');
    const sub = h1 && h1.nextElementSibling;
    if (sub) sub.textContent = tr('commentSub');
    const hint = document.querySelector('.dropzone-hint');
    if (hint) hint.textContent = tr('commentHint');
    const formats = document.querySelector('.dropzone-formats');
    if (formats) formats.textContent = 'JPG · PNG · GIF';
  } catch (_) {}
}
const fileList  = document.getElementById('fileList');
const statusMsg = document.getElementById('statusMsg');
const loader    = document.getElementById('loader');
const dropzone  = document.getElementById('dropzone');
const uploadBtn = document.getElementById('uploadBtn');
const closeBtn  = document.getElementById('closeBtn');

// ── helpers (small DOM utilities for the new premium picker.html) ─────────
/** v2026-10-14 · the keys in MediaDB (the store the worker writes the picked files to), or null when it cannot be read. */
function storedMediaKeys() {
  return new Promise((resolve) => {
    try {
      const req = indexedDB.open('MediaDB', 1);
      req.onerror = () => resolve(null);
      req.onupgradeneeded = () => { try { req.transaction.abort(); } catch (_) {} resolve(null); };   // never create it from here
      req.onsuccess = () => {
        const db = req.result;
        try {
          const q = db.transaction('media', 'readonly').objectStore('media').getAllKeys();
          q.onsuccess = () => { resolve(new Set((q.result || []).map(String))); try { db.close(); } catch (_) {} };
          q.onerror = () => { resolve(null); try { db.close(); } catch (_) {} };
        } catch (_) { resolve(null); try { db.close(); } catch (_) {} }
      };
      setTimeout(() => resolve(null), 5000);
    } catch (_) { resolve(null); }
  });
}

function setStatus(text, kind /* 'info' | 'success' | 'error' */) {
  statusMsg.textContent = text || '';
  statusMsg.className = 'status' + (kind && kind !== 'info' ? ' ' + kind : '');
}
function showLoader(text) {
  loader.classList.add('visible');
  // The loader contains a spinner + text node; replace ONLY the text.
  const span = loader.querySelector('span');
  if (span) span.textContent = text || tr('uploading');
}
function hideLoader() { loader.classList.remove('visible'); }

function humanFileSize(bytes) {
  if (!bytes) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  while (bytes >= 1024 && i < u.length - 1) { bytes /= 1024; i++; }
  return `${bytes.toFixed(bytes >= 10 ? 0 : 1)} ${u[i]}`;
}

// ── Drag & drop on the dropzone ────────────────────────────────────────────
if (dropzone) {
  ['dragenter', 'dragover'].forEach((ev) =>
    dropzone.addEventListener(ev, (e) => {
      e.preventDefault();
      dropzone.classList.add('dragover');
    })
  );
  ['dragleave', 'drop'].forEach((ev) =>
    dropzone.addEventListener(ev, (e) => {
      e.preventDefault();
      dropzone.classList.remove('dragover');
    })
  );
  dropzone.addEventListener('drop', (e) => {
    const dt = e.dataTransfer;
    if (!dt?.files?.length) return;
    // Reuse the same change handler by stuffing files into the input.
    const dataTransfer = new DataTransfer();
    Array.from(dt.files).forEach((f) => dataTransfer.items.add(f));
    input.files = dataTransfer.files;
    input.dispatchEvent(new Event('change'));
  });
}

// ── Image Optimization ──────────────────────────────────────────────────────
// Resize to max 1920×1920 and re-encode as JPEG 92% for consistent upload quality.
// Normalizes image payload for reliable delivery.
async function modifyImage(file) {
  return new Promise((resolve) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      const MAX = 1920;
      let w = img.width, h = img.height;
      if (w > MAX || h > MAX) {
        const ratio = Math.min(MAX / w, MAX / h);
        w = Math.round(w * ratio);
        h = Math.round(h * ratio);
      }
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0, w, h);
      URL.revokeObjectURL(url);
      canvas.toBlob(
        blob => {
          // toBlob yields null when the encoder fails. The old code passed that
          // straight into `new File([blob], ...)`, which stringifies null and
          // produces a 4-byte "null" file named .jpg — an upload that can only
          // fail at Facebook. Treat it as undecodable, same as onerror.
          if (!blob) { resolve(null); return; }
          resolve(new File([blob], file.name.replace(/\.[^.]+$/, '.jpg'), { type: 'image/jpeg' }));
        },
        'image/jpeg',
        0.92
      );
    };
    // 2026-08-20: this used to `resolve(file)` — return the ORIGINAL untouched.
    // Every image the browser CAN decode is re-encoded to JPEG above, so that
    // fallback fired only for formats Chrome cannot decode at all (HEIC/HEIF
    // from iPhones being the common one), and handed the undecodable bytes
    // onward in silence. Facebook then rejected them and the user saw a generic
    // posting failure with no hint that the file was the problem. Resolving
    // null makes the caller skip the file and say so.
    img.onerror = () => { URL.revokeObjectURL(url); resolve(null); };
    img.src = url;
  });
}

// ── Format validation ───────────────────────────────────────────────────────
// A DECODE TEST, deliberately — not a MIME check and not a byte-signature sniff.
// The rule we actually care about is "can this browser turn these bytes into
// pixels?", because everything that decodes gets re-encoded to JPEG above and
// is therefore fine for Facebook, and everything that does not is unusable no
// matter what its extension claims. One test covers HEIC, HEIF, un-supported
// AVIF, truncated downloads and renamed files alike, with no format list to
// keep up to date — and it self-corrects if Chrome ever ships HEIC decoding,
// since the probe would simply start succeeding.
function canDecodeImage(file) {
  return new Promise((resolve) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    // Probe only: no canvas, no re-encode. The real conversion still happens in
    // modifyImage at upload time; this is just the cheap "is it readable" gate
    // so the user hears about a bad file while picking, not after Upload.
    const done = (ok) => { URL.revokeObjectURL(url); resolve(ok); };
    img.onload = () => done(true);
    img.onerror = () => done(false);
    img.src = url;
  });
}

// Formats worth naming explicitly. The decode test below already catches ALL of
// these generically — this table exists only so the dialog can say WHY instead
// of a bare "couldn't read it", which is the difference between a user fixing
// the file and a user filing a support ticket.
// v2026-10-16 · a CODE per format; the words are in the user's language (tr('why_<code>')).
const FORMAT_REASONS = [
  [/\.(heic|heif|hif)$/i,                 'heic'],
  [/\.(cr2|cr3|nef|arw|orf|rw2|raf|dng|srw|pef)$/i, 'raw'],
  [/\.(tif|tiff)$/i,                      'tiff'],
  [/\.psd$/i,                             'psd'],
  [/\.(ai|eps|indd)$/i,                   'design'],
  [/\.(jp2|j2k|jpx|jxl)$/i,               'jp2'],
  [/\.svg$/i,                             'svg'],
  [/\.(pdf|doc|docx|txt|zip|rar|7z)$/i,   'notMedia'],
];
function formatCode(name) {
  for (const [re, code] of FORMAT_REASONS) if (re.test(String(name || ''))) return code;
  return null;
}
function formatReason(name, fallback) {
  const code = formatCode(name);
  return code ? tr('why_' + code) : fallback;
}

// The video counterpart of canDecodeImage. Same idea — ask the browser whether
// it can actually read the file — but the CONSEQUENCE is deliberately weaker:
// videos are uploaded to Facebook as raw bytes and Facebook transcodes them
// server-side, so a container Chrome cannot play may still post fine. This
// therefore only ever produces a warning, never a rejection.
function canDecodeVideo(file) {
  return new Promise((resolve) => {
    const v = document.createElement('video');
    const url = URL.createObjectURL(file);
    let settled = false;
    const done = (ok) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      v.removeAttribute('src');
      URL.revokeObjectURL(url);
      resolve(ok);
    };
    // A large video can take a moment to produce metadata, and neither event
    // is guaranteed to fire on an exotic container — without this the picker
    // would hang on the "Checking files…" spinner forever.
    const timer = setTimeout(() => done(true), 4000);
    v.preload = 'metadata';
    v.onloadedmetadata = () => done(true);
    v.onerror = () => done(false);
    v.src = url;
  });
}

// One verdict per file. `block` = cannot possibly work (an image the browser
// cannot decode can never be re-encoded to JPEG, and its raw bytes are exactly
// what Facebook rejected). `warn` = probably a problem, but uploaded anyway —
// we do not refuse a file we are not certain about.
async function classifyMedia(file) {
  const name = String(file?.name || '');
  if (!file || file.size === 0) {
    return { level: 'block', code: 'empty', why: tr('why_empty') };
  }
  if (/\.svg$/i.test(name) || String(file.type || '') === 'image/svg+xml') {
    return { level: 'block', code: 'svg', why: tr('why_svg') };
  }
  if (looksLikeVideo(file)) {
    return (await canDecodeVideo(file))
      ? { level: 'ok' }
      : { level: 'warn', code: 'videoFormat', why: tr('why_videoFormat') };
  }
  return (await canDecodeImage(file))
    ? { level: 'ok' }
    : { level: 'block', code: formatCode(name) || 'unreadable', why: formatReason(name, tr('why_unreadable')) };
}

// iOS hands some files over with an EMPTY `type` string. Those used to fall
// through to `file = origFile` and skip conversion entirely, so a .heic with no
// MIME reached Facebook untouched — the same silent failure by a second route.
// Extension is the only signal available in that case, and it is used ONLY to
// keep videos away from the image decoder (an <img> can never decode a video,
// so probing one would reject a perfectly good upload).
const VIDEO_EXT_RE = /\.(mp4|mov|m4v|avi|webm|mkv|3gp|3g2|mpg|mpeg|wmv|flv)$/i;
function looksLikeVideo(file) {
  return String(file?.type || '').startsWith('video/') || VIDEO_EXT_RE.test(String(file?.name || ''));
}

// v2026-09-23: a comment takes ONE photo and no video. Drag-and-drop skips the input's
// `accept` filter, so this is the real gate — and it says what it dropped. (QA: a dropped
// video used to vanish without a word, and Upload then answered "No files selected.")
function commentPickFilter(files) {
  const notes = [];
  let kept = files.filter((f) => !looksLikeVideo(f));
  if (kept.length < files.length) notes.push(tr('noteCommentNoVideo'));
  if (kept.length > 1) {
    kept = kept.slice(0, 1);
    notes.push(tr('noteCommentOnePhoto'));
  }
  return { files: kept, notes };
}

// ── Video Optimization ──────────────────────────────────────────────────────
// Passthrough — videos are uploaded as-is to Facebook's resumable upload endpoint.
function modifyVideo(file) {
  return file;
}

function renderList() {
  fileList.innerHTML = '';
  selectedFiles.forEach((f, i) => {
    const row = document.createElement('div');
    row.className = 'file-row';

    const iconWrap = document.createElement('div');
    iconWrap.className = 'file-icon';
    iconWrap.textContent = f.type.startsWith('image/') ? '🖼' : '🎬';

    const name = document.createElement('div');
    name.className = 'file-name';
    name.textContent = f.name;

    const size = document.createElement('div');
    size.className = 'file-size';
    size.textContent = humanFileSize(f.size);

    const rm = document.createElement('button');
    rm.className = 'rm';
    rm.type = 'button';
    rm.title = tr('remove');
    rm.setAttribute('aria-label', tr('removeFile'));
    // Phosphor X duotone (inline SVG so we don't need a runtime icon lib).
    rm.innerHTML =
      '<svg width="14" height="14" viewBox="0 0 256 256" fill="currentColor" xmlns="http://www.w3.org/2000/svg">' +
      '<path d="M205.66,194.34a8,8,0,0,1-11.32,11.32L128,139.31,61.66,205.66a8,8,0,0,1-11.32-11.32L116.69,128,50.34,61.66A8,8,0,0,1,61.66,50.34L128,116.69l66.34-66.35a8,8,0,0,1,11.32,11.32L139.31,128Z"/>' +
      '</svg>';
    rm.onclick = () => {
      selectedFiles.splice(i, 1);
      renderList();
    };

    row.append(iconWrap, name, size, rm);
    fileList.appendChild(row);
  });
}

// ── The dialog ──────────────────────────────────────────────────────────────
const fmtOverlay  = document.getElementById('fmtOverlay');
const fmtList     = document.getElementById('fmtList');
const fmtTip      = document.getElementById('fmtTip');
const fmtTitle    = document.getElementById('fmtTitle');
const fmtSubtitle = document.getElementById('fmtSubtitle');
const fmtOkBtn    = document.getElementById('fmtOkBtn');

function hideFormatDialog() { fmtOverlay.classList.remove('visible'); }
if (fmtOkBtn)   fmtOkBtn.addEventListener('click', hideFormatDialog);
if (fmtOverlay) fmtOverlay.addEventListener('click', (e) => { if (e.target === fmtOverlay) hideFormatDialog(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') hideFormatDialog(); });

/** v2026-10-16 · Pure: files over the size limit → the popup's rows (and the files that stay). */
function sizeLimitProblems(files, maxMb) {
  const max = maxMb * 1024 * 1024;
  const problems = files.filter(f => f.size > max).map(f => ({
    name: f.name, level: 'block', code: 'tooBig',
    why: tr('why_tooBig', { max: maxMb, size: Math.round(f.size / 1048576) }),
  }));
  return { files: files.filter(f => f.size <= max), problems };
}
/** v2026-10-16 · Pure: more photos/videos than a post takes → the popup's row, or null. */
function countLimitProblem(haveCount, addCount, maxFiles) {
  const total = haveCount + addCount;
  if (total <= maxFiles) return null;
  return { name: tr('countName', { count: addCount }), level: 'block', code: 'tooMany',
    why: tr('countWhy', { max: maxFiles, total }) };
}

function showFormatDialog(problems) {
  const blocked = problems.filter((p) => p.level === 'block');
  const warned  = problems.filter((p) => p.level === 'warn');

  fmtTitle.textContent = blocked.length
    ? (blocked.length === 1 ? tr('dlgTitleOne') : tr('dlgTitleMany', { count: blocked.length }))
    : tr('dlgCheck');
  fmtSubtitle.textContent = blocked.length
    ? (warned.length ? tr('dlgSubSome') : tr('dlgSubNone'))
    : tr('dlgSubWarn');

  fmtList.textContent = '';
  for (const p of problems) {
    const li = document.createElement('li');
    li.className = 'fmt-item' + (p.level === 'warn' ? ' warn' : '');
    const mark = document.createElement('span');
    mark.className = 'fmt-mark';
    mark.textContent = p.level === 'warn' ? '⚠️' : '⛔';
    const body = document.createElement('div');
    const nm = document.createElement('div');
    nm.className = 'fmt-name';
    // textContent, never innerHTML — a filename is user input and this dialog
    // renders it verbatim.
    nm.textContent = p.name;
    const why = document.createElement('div');
    why.className = 'fmt-why';
    why.textContent = p.why;
    body.appendChild(nm);
    body.appendChild(why);
    li.appendChild(mark);
    li.appendChild(body);
    fmtList.appendChild(li);
  }

  // The fix, not just the diagnosis. On a Mac/iPhone the HEIC case is one
  // Preview/Photos export away, so say that rather than "unsupported format".
  const heic = blocked.some((p) => p.code === 'heic');
  fmtTip.textContent = heic
    ? tr('tipHeic')
    : (blocked.length ? tr('tipBlocked') : tr('tipWarn'));

  fmtOverlay.classList.add('visible');
  try { fmtOkBtn.focus(); } catch (_) {}
}

// Tell the background worker, which attaches the signed-in email before it
// reports — so an affected customer is identifiable from the dashboard instead
// of only being discovered when they write in. File NAMES are never sent; the
// extension and the reason are enough to know what happened.
function reportRejectedFormats(problems) {
  try {
    const exts = problems.map((p) => {
      const m = /\.([A-Za-z0-9]{1,6})$/.exec(String(p.name || ''));
      return (m ? m[1] : 'none').toLowerCase();
    });
    chrome.runtime.sendMessage({
      action: 'media_format_rejected',
      blocked: problems.filter((p) => p.level === 'block').length,
      warned:  problems.filter((p) => p.level === 'warn').length,
      extensions: Array.from(new Set(exts)).slice(0, 8),
      // the reason in ENGLISH whatever the user's language, so one problem is one value in the reports
      reasons: Array.from(new Set(problems.map((p) => (p.code ? tr('why_' + p.code, null, 'en') : p.why)))).slice(0, 4),
    }, () => { void chrome.runtime.lastError; });
  } catch (_) {}
}

input.addEventListener('change', async () => {
  const MAX_MB = 100;
  const MAX_FILES = FOR_COMMENT ? 1 : 10; // Facebook accepts more, but >10 exceeds the recommended attachment limit (matches industry standard). A comment takes one photo.
  let files = Array.from(input.files);

  // The guards below can reject files in the same pick, so they accumulate
  // into one status line instead of each calling setStatus and clobbering the
  // other's message.
  const rejections = [];

  if (FOR_COMMENT) {
    const pick = commentPickFilter(files);
    files = pick.files;
    rejections.push(...pick.notes);
    if (files.length && selectedFiles.length) selectedFiles = [];   // picking again replaces the photo
  }

  // v2026-10-16 · Liran: the limits say so in a popup, not a small red line (the format popup below, one list).
  const sized = sizeLimitProblems(files, MAX_MB);
  const sizeProblems = sized.problems;
  files = sized.files;
  setStatus('', 'info');

  // Classify every file at PICK time, not at upload time. That is the whole
  // point: the user finds out while they can still choose a different file,
  // instead of after a campaign has already gone out without their photos.
  const problems = [];
  if (files.length) {
    showLoader(tr('checking'));
    const checked = [];
    for (const f of files) {
      let verdict;
      try { verdict = await classifyMedia(f); }
      catch (_) { verdict = { level: 'ok' }; }   // fail-open: never lose a file to a bug in here
      if (verdict.level === 'block') {
        problems.push({ name: f.name, why: verdict.why, code: verdict.code, level: 'block' });
      } else {
        if (verdict.level === 'warn') problems.push({ name: f.name, why: verdict.why, code: verdict.code, level: 'warn' });
        checked.push(f);   // warnings are still uploaded — we do not refuse what we are unsure about
      }
    }
    hideLoader();
    files = checked;
  }
  if (problems.length || sizeProblems.length) showFormatDialog([...problems, ...sizeProblems]);
  if (problems.length) reportRejectedFormats(problems);   // (formats only: a size is not a format)
  if (rejections.length) setStatus(rejections.join(' '), 'error');

  // Dedupe by name+size
  const existing = new Set(selectedFiles.map(f => f.name + f.size));
  const newFiles = files.filter(f => !existing.has(f.name + f.size));

  // Count guard — respects Facebook's recommended attachment limit on huge media batches.
  const tooMany = countLimitProblem(selectedFiles.length, newFiles.length, MAX_FILES);
  if (tooMany) {
    setStatus(tooMany.why, 'error');
    showFormatDialog([tooMany]);
    input.value = '';
    return;
  }

  selectedFiles = [...selectedFiles, ...newFiles];
  renderList();
  input.value = '';
});

uploadBtn.addEventListener('click', async () => {
  if (!selectedFiles.length) {
    setStatus(tr('noFiles'), 'error');
    return;
  }

  uploadBtn.disabled = true;
  closeBtn.disabled = true;
  showLoader(tr('uploading'));
  setStatus('', 'info');

  try {
    // Stamp each picked file with a monotonic `order` so the composer shows
    // them in the order the user PICKED them — not IndexedDB key (alphabetical)
    // order. batchTs makes files added in a later picker session sort after
    // earlier ones; +fileIndex preserves pick order within this batch.
    const batchTs = Date.now();
    const skipped = [];
    const notSaved = [];   // v2026-10-13 · files the worker could not store (full disk)
    const sentIds = [];    // v2026-10-14 · every file sent, checked in MediaDB before "Done!"
    for (let fileIndex = 0; fileIndex < selectedFiles.length; fileIndex++) {
      const origFile = selectedFiles[fileIndex];
      const pickOrder = batchTs * 1000 + fileIndex;
      showLoader(tr('processing', { name: origFile.name }));

      // Optimize image (resize + JPEG re-encode); videos pass through.
      // Video is tested FIRST so a file with an empty `type` but a video
      // extension never reaches the image branch. Everything that is not a
      // video goes through modifyImage — including empty-`type` files, which
      // used to fall through untouched and were the second silent route for an
      // iPhone HEIC to reach Facebook.
      let file;
      if (looksLikeVideo(origFile)) {
        file = modifyVideo(origFile);
      } else {
        file = await modifyImage(origFile);
      }
      if (!file) {
        // Belt and braces: the pick-time gate already removed undecodable
        // files, so reaching here means one slipped through (e.g. the encoder
        // failing on a file that decoded fine a moment ago). Skip it rather
        // than upload bytes Facebook will reject.
        skipped.push(origFile.name);
        continue;
      }

      const chunkSize = 1024 * 1024; // 1 MB
      const totalChunks = Math.ceil(file.size / chunkSize);
      const fileId = `${origFile.name}_${origFile.size}_${Date.now()}`;
      sentIds.push({ id: fileId, name: file.name });

      showLoader(tr('uploadingName', { name: file.name }));

      for (let i = 0; i < totalChunks; i++) {
        const blob = file.slice(i * chunkSize, (i + 1) * chunkSize);
        const base64 = await new Promise(res => {
          const reader = new FileReader();
          reader.onload = () => res(reader.result.split(',')[1]);
          reader.readAsDataURL(blob);
        });

        await new Promise(res => {
          chrome.runtime.sendMessage(
            {
              action: 'fileChunk',
              fileId,
              index: i,
              totalChunks,
              name: file.name,
              type: file.type,
              size: file.size,
              data: base64,
              order: pickOrder,
            },
            (resp) => {
              // v2026-10-13 · the last chunk's answer is the save's real outcome (a full disk used to say "Done!").
              if (i === totalChunks - 1 && resp && resp.ok === false) notSaved.push({ name: file.name, diskFull: !!resp.diskFull, storageBroken: !!resp.storageBroken });
              if (chrome.runtime.lastError) {
                console.warn('[picker] chunk error:', chrome.runtime.lastError.message);
                // The promise still resolves below and the UI still says "Done!",
                // so a half-transferred file looked like a successful upload and
                // only surfaced much later as a post without its image.
                try {
                  chrome.runtime.sendMessage({
                    action: 'telemetry_relay', kind: 'breadcrumb',
                    category: 'media-upload-chunk-failed', level: 'warning',
                    data: { bytes: Number(file.size) || 0 },
                  });
                } catch (_) {}
              }
              res();
            }
          );
        });
      }
    }

    // v2026-10-14 (review 2 · B4) · the last chunk's answer can be LOST (the worker stopped after the last chunk, before it
    // answered) — no answer is not "stored". This page shares MediaDB with the worker, so it looks for itself.
    try {
      const present = await storedMediaKeys();
      if (present) {
        for (const f of sentIds) {
          if (!present.has(f.id) && !notSaved.some((x) => x.name === f.name)) notSaved.push({ name: f.name, diskFull: false });
        }
      }
    } catch (_) { /* could not read: the answers above stand */ }

    hideLoader();
    // v2026-10-13 · a photo the computer could not store is never "Done!" — it would fail at posting time as MEDIA LOST.
    if (notSaved.length) {
      const full = notSaved.some((x) => x.diskFull);
      const broken = !full && notSaved.some((x) => x.storageBroken);   // v2026-10-19 · JAVASCRIPT-47: Chrome's storage refused the file
      const one = notSaved.length === 1;
      setStatus(full
        ? (one ? tr('diskFullOne') : tr('diskFullMany', { count: notSaved.length }))
        : broken ? (one ? tr('storageBroken') : tr('storageBrokenMany', { count: notSaved.length }))
        : (one ? tr('notSavedOne') : tr('notSavedMany', { count: notSaved.length })),
        'error');
      uploadBtn.disabled = false;
      closeBtn.disabled = false;
      return;
    }
    if (skipped.length) {
      // Never close on a silent partial result — a user who thinks all their
      // photos uploaded finds out at posting time otherwise, which is exactly
      // the failure this whole change exists to remove.
      const names = skipped.slice(0, 3).join(', ') + (skipped.length > 3 ? ' ' + tr('more', { n: skipped.length - 3 }) : '');
      setStatus(
        skipped.length === 1 ? tr('skippedOne', { names }) : tr('skippedMany', { count: skipped.length, names }),
        'error'
      );
      uploadBtn.disabled = false;
      closeBtn.disabled = false;
      return;
    }
    setStatus(tr('done'), 'success');
    // Files are now stored in MediaDB. Close the picker window; focus returns to
    // the composer popup, which re-reads MediaDB and shows the new media.
    setTimeout(() => window.close(), 900);

  } catch (err) {
    hideLoader();
    setStatus(tr('error', { msg: (err && err.message) || '' }), 'error');
    uploadBtn.disabled = false;
    closeBtn.disabled = false;
  }
});

closeBtn.addEventListener('click', () => window.close());
