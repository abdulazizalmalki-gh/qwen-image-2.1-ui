/* Qwen-Image-2.1 test console — plain JS, no build step. */
'use strict';

const $ = (id) => document.getElementById(id);
const state = { config: null, refs: [], chatRefs: [], gallery: [], seq: 0, lastEdit: null, editView: 'edited', viewer: { items: [], index: -1 } };

/* Size presets. Both dimensions MUST be multiples of 32 — the model's VAE is a 16x
   autoencoder and vLLM-Omni floors each side otherwise (measured: 1280x720 renders
   1280x704, 1000x1000 renders 992x992). The 'floored' entries below are the classic
   names shipped as the size the server would actually produce. `heavy` marks presets
   above ~1 MP, which need more VRAM than a 24 GB card comfortably has. */
const PRESETS = [
  { group: '1:1 square', sizes: [
    { value: '512x512', label: '512 x 512' },
    { value: '640x640', label: '640 x 640' },
    { value: '768x768', label: '768 x 768' },
    { value: '896x896', label: '896 x 896' },
    { value: '1024x1024', label: '1024 x 1024' },
    { value: '1152x1152', label: '1152 x 1152', heavy: true },
    { value: '1280x1280', label: '1280 x 1280', heavy: true },
    { value: '1536x1536', label: '1536 x 1536', heavy: true },
    { value: '2048x2048', label: '2048 x 2048', heavy: true },
  ]},
  { group: '16:9 landscape', sizes: [
    { value: '512x288', label: '512 x 288' },
    { value: '1024x576', label: '1024 x 576' },
    { value: '1536x864', label: '1536 x 864', heavy: true },
    { value: '2048x1152', label: '2048 x 1152', heavy: true },
    { value: '1280x704', label: '1280 x 704 (720p)' },
    { value: '1920x1056', label: '1920 x 1056 (1080p)', heavy: true },
  ]},
  { group: '9:16 portrait', sizes: [
    { value: '288x512', label: '288 x 512' },
    { value: '576x1024', label: '576 x 1024' },
    { value: '864x1536', label: '864 x 1536', heavy: true },
    { value: '1152x2048', label: '1152 x 2048', heavy: true },
    { value: '704x1280', label: '704 x 1280 (portrait)' },
  ]},
  { group: '4:3 landscape', sizes: [
    { value: '512x384', label: '512 x 384' },
    { value: '640x480', label: '640 x 480' },
    { value: '768x576', label: '768 x 576' },
    { value: '1024x768', label: '1024 x 768' },
    { value: '1152x864', label: '1152 x 864' },
    { value: '1280x960', label: '1280 x 960', heavy: true },
    { value: '1536x1152', label: '1536 x 1152', heavy: true },
    { value: '2048x1536', label: '2048 x 1536', heavy: true },
  ]},
  { group: '3:4 portrait', sizes: [
    { value: '384x512', label: '384 x 512' },
    { value: '480x640', label: '480 x 640' },
    { value: '576x768', label: '576 x 768' },
    { value: '768x1024', label: '768 x 1024' },
    { value: '864x1152', label: '864 x 1152' },
    { value: '960x1280', label: '960 x 1280', heavy: true },
    { value: '1152x1536', label: '1152 x 1536', heavy: true },
    { value: '1536x2048', label: '1536 x 2048', heavy: true },
  ]},
  { group: '3:2 landscape', sizes: [
    { value: '480x320', label: '480 x 320' },
    { value: '768x512', label: '768 x 512' },
    { value: '1152x768', label: '1152 x 768' },
    { value: '1536x1024', label: '1536 x 1024', heavy: true },
    { value: '2016x1344', label: '2016 x 1344', heavy: true },
  ]},
  { group: '2:3 portrait', sizes: [
    { value: '320x480', label: '320 x 480' },
    { value: '512x768', label: '512 x 768' },
    { value: '768x1152', label: '768 x 1152' },
    { value: '1024x1536', label: '1024 x 1536', heavy: true },
    { value: '1344x2016', label: '1344 x 2016', heavy: true },
  ]},
  { group: '16:10 landscape', sizes: [
    { value: '512x320', label: '512 x 320' },
    { value: '768x480', label: '768 x 480' },
    { value: '1024x640', label: '1024 x 640' },
    { value: '1280x800', label: '1280 x 800' },
    { value: '1536x960', label: '1536 x 960', heavy: true },
    { value: '2048x1280', label: '2048 x 1280', heavy: true },
  ]},
  { group: '21:9 ultrawide', sizes: [
    { value: '672x288', label: '672 x 288' },
    { value: '1344x576', label: '1344 x 576' },
    { value: '2016x864', label: '2016 x 864', heavy: true },
  ]},
];

/* ---------------------------------------------------------------- helpers */

function num(v) { const n = parseFloat(v); return Number.isFinite(n) ? n : null; }
function int(v) { const n = parseInt(v, 10); return Number.isFinite(n) ? n : null; }

function sizeOk(size) {
  const m = /^(\d+)\s*x\s*(\d+)$/i.exec(String(size || '').trim());
  if (!m) return { ok: false, why: 'size must look like 1024x1024' };
  const w = +m[1], h = +m[2];
  const sw = w - (w % 32), sh = h - (h % 32);          // what the server will do
  const snapped = sw !== w || sh !== h;
  if (Math.min(sw, sh) < 256) return { ok: false, why: 'the smallest sensible size is 256x256' };
  if (Math.max(sw, sh) > 2048) return { ok: false, why: 'a side above 2048 exceeds this setup\'s VRAM budget' };
  return {
    ok: true,
    value: `${sw}x${sh}`,
    snapped,
    why: snapped ? `${w}x${h} is not a multiple of 32 (VAE requirement) — the server floors each side, so this uses ${sw}x${sh}` : '',
  };
}

function renderSizeSelects() {
  // t2i: presets + custom. edit: presets + the two reference-driven modes + custom.
  // chat: presets + custom (its size rides in extra_body, so no reference mode).
  const hasReferenceModes = (id) => id === 'edit-size';
  ['t2i-size', 'edit-size', 'chat-size'].forEach((id) => {
    const sel = $(id);
    const keep = sel.value;
    sel.innerHTML = '';
    PRESETS.forEach((grp) => {
      const og = document.createElement('optgroup');
      og.label = grp.group;
      grp.sizes.forEach((sz) => {
        const o = document.createElement('option');
        o.value = sz.value;
        o.textContent = sz.label + (sz.heavy ? ' *' : '');   // '*' = heavy, see the hint
        o.dataset.heavy = sz.heavy ? '1' : '';
        og.appendChild(o);
      });
      sel.appendChild(og);
    });
    const special = document.createElement('optgroup');
    special.label = hasReferenceModes(id) ? 'from the reference image' : 'other';
    if (hasReferenceModes(id)) {
      const ref = document.createElement('option');
      ref.value = 'reference';
      ref.id = 'edit-size-reference-option';
      ref.textContent = 'reference size';
      special.appendChild(ref);
      const auto = document.createElement('option');
      auto.value = 'auto';
      auto.textContent = 'server decides (same as reference)';
      special.appendChild(auto);
    }
    const custom = document.createElement('option');
    custom.value = 'custom';
    custom.textContent = 'custom…';
    special.appendChild(custom);
    sel.appendChild(special);
    sel.value = keep || '1024x1024';
    if (!sel.value) sel.value = '1024x1024';
  });
  refreshReferenceSizeOption();
}

/* Label the "same size as the reference" option with the pixels we will send. */
function refreshReferenceSizeOption() {
  const opt = $('edit-size-reference-option');
  if (!opt) return;
  const item = state.refs[state.refs.length - 1];
  if (item && item.w) {
    const fitted = sizeOk(`${item.w}x${item.h}`);
    opt.textContent = 'reference size';
    if ($('edit-size-hint')) {
      $('edit-size-hint').textContent = fitted.ok
        ? `output ${fitted.value} — the size of the picture you upload`
        : `${item.w}x${item.h} is outside the usable range (256–2048, multiples of 32)`;
    }
  } else {
    opt.textContent = 'reference size';
  }
}

/* Read a picture's pixel size so "same size as reference" can be exact. */
function attachDims(item) {
  const img = new window.Image();
  img.onload = () => {
    item.w = img.naturalWidth;
    item.h = img.naturalHeight;
    refreshReferenceSizeOption();
    updateEditSizeHint();
  };
  img.src = item.url;
}

/* Resolve a size select (+ optional custom input) into the value to send. */
function selectedSize(selId, customId) {
  const v = $(selId).value;
  if (v === 'auto') return { ok: true, value: '', omit: true, why: '' };
  if (v === 'reference') {
    const item = state.refs[state.refs.length - 1];
    if (!item || !item.w) return { ok: false, why: 'the reference image has not finished loading yet — try again in a moment' };
    const fitted = sizeOk(`${item.w}x${item.h}`);
    if (fitted.ok && fitted.snapped) fitted.why = `the ${item.w}x${item.h} reference is not on the 32 grid — using ${fitted.value}`;
    return fitted;
  }
  const raw = v === 'custom' && customId ? $(customId).value : v;
  return sizeOk(raw);
}

function updateEditSizeHint() {
  const el = $('edit-size-hint');
  if (!el) return;
  const mode = $('edit-size').value;
  if (mode === 'reference') {
    const item = state.refs[state.refs.length - 1];
    if (!item) { el.textContent = 'renders at the size of the picture you upload'; return; }
    if (!item.w) { el.textContent = 'reading the reference size…'; return; }
    const fitted = sizeOk(`${item.w}x${item.h}`);
    el.textContent = fitted.ok
      ? `output ${fitted.value} — the size of the picture you upload${fitted.snapped ? ' (floored to the 32 grid)' : ''}`
      : `${item.w}x${item.h} is outside the usable range (256–2048, multiples of 32)`;
  } else if (mode === 'auto') {
    el.textContent = 'no size sent — measured behaviour is the reference image\'s size';
  } else if (mode === 'custom') {
    el.textContent = 'any WxH; floored to a multiple of 32 like the server does';
  } else {
    el.textContent = presetHeavy($('edit-size'))
      ? 'above ~1 MP — heavy, may exceed 24 GB VRAM'
      : 'every value keeps both sides a multiple of 32';
  }
}

function syncCustomInput(selId, customId) {
  const custom = $(selId).value === 'custom';
  if ($(customId)) $(customId).style.display = custom ? 'block' : 'none';
  return custom;
}

function presetHeavy(sel) {
  const o = sel.options[sel.selectedIndex];
  return !!(o && o.dataset.heavy);
}

function banner(el, kind, html) {
  el.innerHTML = '';
  if (!html) return;
  const d = document.createElement('div');
  d.className = 'banner ' + kind;
  d.innerHTML = html;
  el.appendChild(d);
}

function busy(btn, on, label) {
  btn.disabled = on;
  if (on) { btn.dataset.label = btn.textContent; btn.innerHTML = '<span class="spinner"></span> ' + label; }
  else if (btn.dataset.label) { btn.textContent = btn.dataset.label; }
}

/* Long-running progress goes in its own slot so a warning banner is not
   overwritten by the spinner (e.g. "CFG without a negative prompt"). */
function progress(el, html) {
  el.innerHTML = html || '';
  if (html) el.firstElementChild.classList.add('banner', 'busy');
}

function elapsedTicker(node) {
  const t0 = Date.now();
  node.textContent = '0 s elapsed';
  return setInterval(() => { node.textContent = `${Math.round((Date.now() - t0) / 1000)} s elapsed`; }, 1000);
}

function metricsHtml(resp, wallSec) {
  const m = (resp && resp.metrics) || {};
  const sd = m.stage_durations || {};
  const bits = [];
  if (wallSec != null) bits.push(`wall ${wallSec.toFixed(1)} s`);
  if (sd.stage_0_gen_ms != null) bits.push(`generate ${(sd.stage_0_gen_ms / 1000).toFixed(1)} s`);
  if (sd.queue_wait_ms != null) bits.push(`queue ${sd.queue_wait_ms.toFixed(0)} ms`);
  if (m.peak_memory_mb != null) bits.push(`peak VRAM ${(m.peak_memory_mb / 1024).toFixed(1)} GiB`);
  if (resp && resp.size) bits.push(resp.size);
  if (resp && resp.output_format) bits.push(resp.output_format);
  return bits.map((b) => `<span>${b}</span>`).join('');
}

function showImage(frame, metaEl, dataUrl, metaHtml, alt) {
  frame.innerHTML = '';
  const img = document.createElement('img');
  img.src = dataUrl;
  img.alt = alt || 'generated image';
  frame.appendChild(img);
  if (metaEl) metaEl.innerHTML = metaHtml || '';
}

function showEditView(view) {
  const pair = state.lastEdit;
  if (!pair) return;
  state.editView = view;
  $('edit-view-original').classList.toggle('active', view === 'original');
  $('edit-view-edited').classList.toggle('active', view === 'edited');
  const url = view === 'original' ? pair.referenceUrl : pair.resultUrl;
  const label = view === 'original' ? pair.referenceLabel : 'edited';
  showImage($('edit-frame'), $('edit-meta'),
    url,
    `<span>${label}</span>` + (view === 'original' ? '' : metricsHtml(pair.resp, pair.wall)),
    view === 'original' ? 'reference image that was edited' : 'edited result');
}

function setEditPair(pair) {
  state.lastEdit = pair;
  $('edit-compare').hidden = false;
  $('edit-view-original').innerHTML = pair.referenceCount > 1
    ? `Original <small>(ref ${pair.referenceCount})</small>`
    : 'Original';
  showEditView('edited');
}

function makeBannerNode(container) { const d = document.createElement('div'); container.appendChild(d); return d; }

function download(dataUrl, name) {
  const a = document.createElement('a');
  a.href = dataUrl;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

function saveParams(obj) { try { localStorage.setItem('qwen-ui-params', JSON.stringify(obj)); } catch (e) {} }
function loadParams() { try { return JSON.parse(localStorage.getItem('qwen-ui-params') || '{}'); } catch (e) { return {}; } }

function addToGallery(entry) {
  state.gallery.push(entry);
  const wrap = $('gallery');
  const el = document.createElement('div');
  el.className = 'thumb';
  el.tabIndex = 0;
  el.dataset.index = String(state.gallery.length - 1);
  el.setAttribute('role', 'button');
  el.setAttribute('aria-label', `${entry.kind} result — open larger`);
  el.innerHTML = `<img src="${entry.dataUrl}" alt="${entry.kind} result" />`;
  const open = () => openViewer(collectGalleryItems(), Number(el.dataset.index));
  el.onclick = open;
  el.onkeydown = (ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); open(); } };
  wrap.prepend(el);
  $('gallery-count').textContent = `(${state.gallery.length})`;
}

/* ---- viewer (gallery results and reference images) ------------------------- */

/* anything openable is normalised to { dataUrl, label, ..., entry? } */
function collectGalleryItems() {
  return state.gallery.map((e) => ({
    dataUrl: e.dataUrl, label: e.kind, resp: e.resp, wall: e.wall, prompt: e.prompt, entry: e,
  }));
}

function collectRefItems(kind) {
  const list = kind === 'chat' ? state.chatRefs : state.refs;
  return list.map((r) => ({ dataUrl: r.url, label: 'reference image', w: r.w, h: r.h, name: r.name }));
}

function itemSize(item) {
  if ((item.resp || {}).size) return item.resp.size;
  if (item.w && item.h) return `${item.w}x${item.h}`;
  const img = $('lb-img');
  if (img && img.naturalWidth) return `${img.naturalWidth}x${img.naturalHeight}`;
  return '';
}

function renderViewer() {
  const { items, index } = state.viewer;
  const item = items[index];
  if (!item) return closeViewer();

  $('lb-img').src = item.dataUrl;
  const bits = [item.label, itemSize(item), item.name];
  const sd = ((item.resp || {}).metrics || {}).stage_durations || {};
  if (sd.stage_0_gen_ms != null) bits.push(`generate ${(sd.stage_0_gen_ms / 1000).toFixed(1)} s`);
  if (item.wall != null) bits.push(`wall ${item.wall.toFixed(1)} s`);
  if (item.prompt) bits.push(`“${item.prompt}”`);
  $('lb-meta').textContent = bits.filter(Boolean).join(' · ');

  $('lb-open').hidden = !item.entry;            // only gallery results can go back to a tab
  $('lb-prev').disabled = index <= 0;
  $('lb-next').disabled = index >= items.length - 1;
}

function openViewer(items, index) {
  if (!items || !items[index]) return;
  state.viewer = { items, index };
  renderViewer();
  $('lightbox').hidden = false;
  document.body.style.overflow = 'hidden';
  $('lb-close').focus();
}

function closeViewer() {
  state.viewer = { items: [], index: -1 };
  $('lightbox').hidden = true;
  document.body.style.overflow = '';
}

function stepViewer(delta) {
  const next = state.viewer.index + delta;
  if (state.viewer.items[next]) openViewer(state.viewer.items, next);
}

/* put a gallery entry back into the tab it came from, and show that tab */
function openEntryInItsTab(entry) {
  if (!entry) return;
  closeViewer();
  const resp = entry.resp;
  if (entry.kind === 'edit') {
    showImage($('edit-frame'), $('edit-meta'), entry.dataUrl, metricsHtml(resp, entry.wall), entry.prompt);
    $('edit-download').disabled = false; $('edit-json').disabled = false; $('edit-jsonpre').textContent = JSON.stringify(resp, null, 2);
    showTab('edit');
  } else if (entry.kind === 'chat') {
    showImage($('chat-frame'), $('chat-meta'), entry.dataUrl, metricsHtml(resp, entry.wall), entry.prompt);
    $('chat-download').disabled = false; $('chat-json').disabled = false; $('chat-jsonpre').textContent = JSON.stringify(resp, null, 2);
    showTab('chat');
  } else {
    showImage($('t2i-frame'), $('t2i-meta'), entry.dataUrl, metricsHtml(resp, entry.wall), entry.prompt);
    state.lastT2i = entry.dataUrl;
    $('t2i-download').disabled = false; $('t2i-to-edit').disabled = false; $('t2i-json').disabled = false;
    $('t2i-jsonpre').textContent = JSON.stringify(resp, null, 2);
    showTab('t2i');
  }
}

/* ---------------------------------------------------------------- refs */

function refBox(kind) {
  const isEdit = kind === 'edit';
  const list = isEdit ? state.refs : state.chatRefs;
  const holder = $(isEdit ? 'edit-thumbs' : 'chat-thumbs');
  holder.innerHTML = '';
  list.forEach((item, i) => {
    const d = document.createElement('div');
    d.className = 'thumb';
    d.tabIndex = 0;
    d.setAttribute('role', 'button');
    d.setAttribute('aria-label', 'reference image — open larger');
    d.innerHTML = `<img src="${item.url}" alt="reference image" /><button title="remove">×</button>`;
    // clicking the picture opens the viewer; the × still only removes
    const openSelf = () => openViewer(collectRefItems(kind), i);
    d.onclick = (ev) => { if (ev.target.tagName !== 'BUTTON') openSelf(); };
    d.onkeydown = (ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); openSelf(); } };
    const rm = d.querySelector('button');
    rm.onclick = (ev) => { ev.stopPropagation(); list.splice(i, 1); refBox(kind); };
    holder.appendChild(d);
  });
}

function readFiles(files, kind) {
  const isEdit = kind === 'edit';
  const list = isEdit ? state.refs : state.chatRefs;
  const cap = 4;
  [...files].forEach((f) => {
    if (!f.type.startsWith('image/')) return;
    if (list.length >= cap) return;
    const reader = new FileReader();
    reader.onload = () => {
      const item = { url: reader.result, name: f.name };
      list.push(item);
      attachDims(item);
      refBox(kind);
    };
    reader.readAsDataURL(f);
  });
  if (list.length >= cap) banner($(isEdit ? 'edit-banner' : 'chat-banner'), 'busy', 'Reference limit is 4 images — the model rejects a fifth.');
}

function wireDrop(kind) {
  const isEdit = kind === 'edit';
  const zone = $(isEdit ? 'drop' : 'chat-drop');
  const input = $(isEdit ? 'edit-files' : 'chat-files');
  zone.onclick = () => input.click();
  input.onchange = () => { readFiles(input.files, kind); input.value = ''; };
  ['dragenter', 'dragover'].forEach((ev) => zone.addEventListener(ev, (e) => { e.preventDefault(); zone.classList.add('over'); }));
  ['dragleave', 'drop'].forEach((ev) => zone.addEventListener(ev, (e) => { e.preventDefault(); zone.classList.remove('over'); }));
  zone.addEventListener('drop', (e) => readFiles(e.dataTransfer.files, kind));
  window.addEventListener('paste', (e) => {
    const active = document.querySelector('.tabpane.active');
    if (!active || active.id !== (isEdit ? 'edit' : 'chat')) return;
    const items = [...((e.clipboardData && e.clipboardData.files) || [])];
    if (items.length) readFiles(items, kind);
  });
}

/* ---------------------------------------------------------------- server */

async function refreshConfig() {
  const dot = $('dot');
  dot.className = 'dot';
  try {
    const r = await fetch('/api/config');
    const c = await r.json();
    state.config = c;
    $('api-pill').textContent = `api: ${c.api_base}`;
    $('model-name').textContent = c.model || 'no model id';
    if ($('footer-model')) $('footer-model').textContent = c.model || 'no model id';
    dot.className = 'dot ' + (c.upstream_reachable && c.model ? 'ok' : 'bad');
    $('diag-upstream').textContent = c.upstream_reachable ? 'upstream reachable' : `upstream unreachable: ${c.detail || ''}`;
    $('diag-docs').href = c.api_base + '/docs';
    if (c.defaults) {
      const saved = loadParams();
      if (!saved.steps) { $('t2i-steps').value = c.defaults.steps; $('edit-steps').value = c.defaults.steps; $('chat-steps').value = c.defaults.steps; }
      if (!saved.size) $('t2i-size').value = c.defaults.size;
    }
  } catch (e) {
    dot.className = 'dot bad';
    $('model-name').textContent = 'UI backend error';
  }
}

/* ---------------------------------------------------------------- t2i */

async function runT2I() {
  const btn = $('t2i-run');
  const prompt = $('t2i-prompt').value.trim();
  if (!prompt) { banner($('t2i-banner'), 'err', 'Prompt is required.'); return; }

  const size = selectedSize('t2i-size', 't2i-size-custom');
  if (!size.ok) { banner($('t2i-banner'), 'err', size.why); return; }
  const warnings = [];
  if (size.snapped) warnings.push(size.why);
  if (presetHeavy($('t2i-size'))) warnings.push('this preset is above ~1 MP: expect a long run and possible CUDA OOM on a 24 GB card');

  const steps = int($('t2i-steps').value) || 40;
  const cfg = num($('t2i-cfg').value) || 1.0;
  const seed = $('t2i-seed').value.trim();
  const payload = { prompt, size: size.value, num_inference_steps: steps, true_cfg_scale: cfg };
  if (seed) payload.seed = int(seed);
  if (cfg > 1) {
    const neg = $('t2i-negative').value.trim();
    if (neg) payload.negative_prompt = neg;
    else warnings.push(`CFG ${cfg} without a negative prompt: guidance still applies at 4.0 upstream and roughly doubles compute. Add a negative prompt or set CFG back to 1.0.`);
  }
  banner($('t2i-banner'), warnings.length ? 'busy' : '', warnings.map((w) => `• ${w}`).join('<br>'));

  progress($('t2i-progress'), '<div><span class="spinner"></span> generating… <span id="t2i-tick"></span></div>');
  const tick = elapsedTicker($('t2i-tick'));
  busy(btn, true, 'Generating');
  const t0 = Date.now();
  try {
    const r = await fetch('/api/generate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    const data = await r.json();
    if (!r.ok) throw new Error(typeof data.detail === 'string' ? data.detail : JSON.stringify(data.detail));
    const b64 = data.data && data.data[0] && data.data[0].b64_json;
    if (!b64) throw new Error('reply carried no .data[0].b64_json');
    const url = 'data:image/png;base64,' + b64;
    const wall = (Date.now() - t0) / 1000;
    state.lastT2i = url;
    showImage($('t2i-frame'), $('t2i-meta'), url, metricsHtml(data, wall), prompt);
    $('t2i-download').disabled = false; $('t2i-to-edit').disabled = false; $('t2i-json').disabled = false;
    $('t2i-jsonpre').textContent = JSON.stringify(data, null, 2);
    progress($('t2i-progress'), '');
    addToGallery({ kind: 't2i', dataUrl: url, prompt, resp: data, wall });
    saveParams({ steps, size: size.value, cfg });
  } catch (e) {
    banner($('t2i-banner'), 'err', 'Request failed: ' + e.message);
  } finally {
    clearInterval(tick);
    progress($('t2i-progress'), '');
    busy(btn, false);
  }
}

/* ---------------------------------------------------------------- edit */

async function runEdit() {
  const btn = $('edit-run');
  if (!state.refs.length) { banner($('edit-banner'), 'err', 'Add at least one reference image.'); return; }
  const prompt = $('edit-prompt').value.trim();
  if (!prompt) { banner($('edit-banner'), 'err', 'An instruction/prompt is required.'); return; }
  updateEditSizeHint();          // keep the readout honest even if the value was set programmatically
  const size = selectedSize('edit-size', 'edit-size-custom');
  if (!size.ok) { banner($('edit-banner'), 'err', size.why); return; }
  const warnings = [];
  if (size.snapped) warnings.push(size.why);
  if (size.omit) warnings.push('no output size sent — measured behaviour is to render at the reference image\'s size');
  if (!size.omit && presetHeavy($('edit-size'))) warnings.push('this size is above ~1 MP: expected to be slow and may OOM on a 24 GB card');
  banner($('edit-banner'), warnings.length ? 'busy' : '', warnings.map((w) => `• ${w}`).join('<br>'));
  $('edit-view-edited').click();

  const fd = new FormData();
  fd.append('prompt', prompt);
  if (!size.omit) fd.append('size', size.value);      // omitted = server derives it
  fd.append('steps', $('edit-steps').value || '40');
  fd.append('cfg', $('edit-cfg').value || '1.0');
  const seed = $('edit-seed').value.trim();
  if (seed) fd.append('seed', seed);
  state.refs.forEach((ref, i) => {
    const blob = dataUrlToBlob(ref.url);
    fd.append('images', blob, ref.name || `reference-${i + 1}.png`);
  });

  progress($('edit-progress'), '<div><span class="spinner"></span> applying edit… <span id="edit-tick"></span></div>');
  const tick = elapsedTicker($('edit-tick'));
  busy(btn, true, 'Applying');
  const t0 = Date.now();
  try {
    const r = await fetch('/api/edit', { method: 'POST', body: fd });
    const data = await r.json();
    if (!r.ok) throw new Error(typeof data.detail === 'string' ? data.detail : JSON.stringify(data.detail));
    const b64 = data.data && data.data[0] && data.data[0].b64_json;
    if (!b64) throw new Error('reply carried no .data[0].b64_json');
    const url = 'data:image/png;base64,' + b64;
    const wall = (Date.now() - t0) / 1000;
    const ref = state.refs[state.refs.length - 1] || {};
    setEditPair({
      referenceUrl: ref.url,
      referenceLabel: ref.w ? `original ${ref.w}x${ref.h}` : 'original',
      referenceCount: state.refs.length,
      resultUrl: url,
      resp: data,
      wall,
    });
    $('edit-download').disabled = false; $('edit-json').disabled = false;
    $('edit-jsonpre').textContent = JSON.stringify(data, null, 2);
    progress($('edit-progress'), '');
    addToGallery({ kind: 'edit', dataUrl: url, prompt, resp: data, wall });
  } catch (e) {
    banner($('edit-banner'), 'err', 'Request failed: ' + e.message);
  } finally {
    clearInterval(tick);
    progress($('edit-progress'), '');
    busy(btn, false);
  }
}

function dataUrlToBlob(dataUrl) {
  const [meta, b64] = dataUrl.split(',');
  const mime = /:(.*?);/.exec(meta)[1];
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}

/* ---------------------------------------------------------------- chat */

async function runChat() {
  const btn = $('chat-run');
  const prompt = $('chat-prompt').value.trim();
  if (!prompt) { banner($('chat-banner'), 'err', 'Prompt is required.'); return; }
  const chatSize = selectedSize('chat-size', 'chat-size-custom');
  if (!chatSize.ok) { banner($('chat-banner'), 'err', chatSize.why); return; }
  const payload = {
    prompt,
    images: state.chatRefs.map((r) => r.url),
    size: chatSize.value,
    steps: $('chat-steps').value || '40',
    cfg: $('chat-cfg').value || '1.0',
    seed: $('chat-seed').value.trim(),
  };

  progress($('chat-progress'), '<div><span class="spinner"></span> waiting for the chat reply… <span id="chat-tick"></span></div>');
  const tick = elapsedTicker($('chat-tick'));
  busy(btn, true, 'Sending');
  const t0 = Date.now();
  try {
    const r = await fetch('/api/chat-image', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    const data = await r.json();
    if (!r.ok) throw new Error(typeof data.detail === 'string' ? data.detail : JSON.stringify(data.detail));
    $('chat-jsonpre').textContent = JSON.stringify(data, null, 2);
    const content = (((data.choices || [])[0] || {}).message || {}).content;
    let url = null;
    if (Array.isArray(content)) {
      const part = content.find((c) => c && c.image_url && c.image_url.url);
      if (part) url = part.image_url.url;
    } else if (typeof content === 'string' && content.startsWith('data:image')) {
      url = content;
    }
    const wall = (Date.now() - t0) / 1000;
    if (!url) {
      $('chat-frame').innerHTML = '<div class="empty">Reply had no image_url content part — see raw JSON</div>';
      $('chat-meta').innerHTML = metricsHtml(data, wall);
      banner($('chat-banner'), 'busy', 'Got a reply but no image part; the raw JSON is below.');
    } else {
      showImage($('chat-frame'), $('chat-meta'), url, metricsHtml(data, wall), prompt);
      $('chat-download').disabled = false;
      addToGallery({ kind: 'chat', dataUrl: url, prompt, resp: data, wall });
      progress($('chat-progress'), '');
    }
    $('chat-json').disabled = false;
  } catch (e) {
    banner($('chat-banner'), 'err', 'Request failed: ' + e.message);
  } finally {
    clearInterval(tick);
    progress($('chat-progress'), '');
    busy(btn, false);
  }
}

/* ---------------------------------------------------------------- diagnostics */

async function loadDiag() {
  $('diag-health').textContent = 'loading…';
  $('diag-metrics').textContent = 'loading…';
  try {
    const h = await (await fetch('/api/health')).json();
    $('diag-health').textContent = JSON.stringify(h, null, 2);
  } catch (e) { $('diag-health').textContent = 'health failed: ' + e.message; }
  try {
    const m = await (await fetch('/api/metrics')).text();
    const lines = m.split('\n');
    $('diag-metrics').textContent = lines.slice(-400).join('\n');
  } catch (e) { $('diag-metrics').textContent = 'metrics failed: ' + e.message; }
}

/* ---------------------------------------------------------------- wiring */

function showTab(name) {
  document.querySelectorAll('nav.tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
  document.querySelectorAll('.tabpane').forEach((p) => p.classList.toggle('active', p.id === name));
  if (name === 'diag') loadDiag();
  // deep-linkable tabs: /#edit opens the edit pane (also handy for screenshots)
  if (window.history && window.history.replaceState) window.history.replaceState(null, '', '#' + name);
}

window.addEventListener('DOMContentLoaded', () => {
  document.querySelectorAll('nav.tabs button').forEach((b) => (b.onclick = () => showTab(b.dataset.tab)));

  renderSizeSelects();
  updateEditSizeHint();
  $('t2i-size').onchange = (e) => {
    syncCustomInput('t2i-size', 't2i-size-custom');
    $('t2i-size-hint').textContent = presetHeavy($('t2i-size'))
      ? 'above ~1 MP — heavy, may exceed 24 GB VRAM'
      : 'every preset keeps both sides a multiple of 32';
  };
  $('t2i-size-hint').textContent = 'every preset keeps both sides a multiple of 32';
  $('edit-size').onchange = () => { syncCustomInput('edit-size', 'edit-size-custom'); updateEditSizeHint(); };
  $('edit-size-custom').oninput = updateEditSizeHint;
  $('chat-size').onchange = () => syncCustomInput('chat-size', 'chat-size-custom');
  $('t2i-random').onclick = () => { $('t2i-seed').value = Math.floor(Math.random() * 1e9); };

  // clear control on the prompt: only shown when there is something to clear
  const promptField = $('t2i-prompt');
  const promptClear = $('t2i-prompt-clear');
  const syncPromptClear = () => { promptClear.hidden = promptField.value.length === 0; };
  promptField.addEventListener('input', syncPromptClear);
  promptClear.onclick = () => {
    promptField.value = '';
    syncPromptClear();
    promptField.focus();
  };
  syncPromptClear();
  $('t2i-cfg').oninput = () => {
    const v = num($('t2i-cfg').value) || 1;
    $('t2i-cfg-hint').className = 'hint' + (v > 1 ? ' warn' : '');
    $('t2i-cfg-hint').textContent = v > 1 ? 'CFG on: needs a negative prompt, ~2x compute' : '1.0 = guidance off (fastest)';
  };
  $('t2i-run').onclick = runT2I;
  $('t2i-download').onclick = () => state.lastT2i && download(state.lastT2i, `qwen-image-2.1-${Date.now()}.png`);
  $('t2i-json').onclick = () => { $('t2i-jsonbox').hidden = !$('t2i-jsonbox').hidden; };
  $('t2i-to-edit').onclick = () => {
    if (!state.lastT2i) return;
    const item = { url: state.lastT2i, name: 'from-text-to-image.png' };
    state.refs = [item];
    attachDims(item);
    refBox('edit');
    showTab('edit');
  };

  wireDrop('edit');
  wireDrop('chat');
  $('edit-clear').onclick = () => { state.refs = []; refBox('edit'); };
  $('edit-run').onclick = runEdit;
  $('edit-download').onclick = () => {
    const img = $('edit-frame').querySelector('img');
    if (!img) return;
    const what = state.editView === 'original' ? 'original' : 'edit';
    download(img.src, `qwen-image-2.1-${what}-${Date.now()}.png`);
  };
  $('edit-view-original').onclick = () => showEditView('original');
  $('edit-view-edited').onclick = () => showEditView('edited');
  $('edit-json').onclick = () => { $('edit-jsonbox').hidden = !$('edit-jsonbox').hidden; };

  $('chat-run').onclick = runChat;
  $('chat-download').onclick = () => {
    const img = $('chat-frame').querySelector('img');
    if (img) download(img.src, `qwen-image-2.1-chat-${Date.now()}.png`);
  };
  $('chat-json').onclick = () => { $('chat-jsonbox').hidden = !$('chat-jsonbox').hidden; };

  $('lb-close').onclick = closeViewer;
  $('lb-prev').onclick = () => stepViewer(-1);
  $('lb-next').onclick = () => stepViewer(1);
  $('lb-download').onclick = () => {
    const cur = state.viewer.items[state.viewer.index];
    if (cur) download(cur.dataUrl, `qwen-image-2.1-${cur.entry ? cur.entry.kind : 'reference'}-${Date.now()}.png`);
  };
  $('lb-open').onclick = () => openEntryInItsTab((state.viewer.items[state.viewer.index] || {}).entry);
  $('lightbox').onclick = (ev) => { if (ev.target === $('lightbox')) closeViewer(); };
  window.addEventListener('keydown', (ev) => {
    if ($('lightbox').hidden) return;
    if (ev.key === 'Escape') closeViewer();
    else if (ev.key === 'ArrowLeft') stepViewer(-1);
    else if (ev.key === 'ArrowRight') stepViewer(1);
  });

  $('diag-reload').onclick = loadDiag;
  $('refresh').onclick = refreshConfig;

  const saved = loadParams();
  if (saved.steps) { $('t2i-steps').value = saved.steps; }
  if (saved.cfg) { $('t2i-cfg').value = saved.cfg; }
  if (saved.size) {
    const opt = [...$('t2i-size').options].find((o) => o.value === saved.size);
    if (opt) $('t2i-size').value = saved.size;
    else { $('t2i-size-custom').value = saved.size; $('t2i-size-custom').style.display = 'block'; $('t2i-size').value = 'custom'; }
  }
  $('t2i-cfg').oninput();
  refreshConfig();

  const wanted = (window.location.hash || '').replace('#', '');
  if (['t2i', 'edit', 'chat', 'diag'].includes(wanted)) showTab(wanted);
  window.addEventListener('hashchange', () => {
    const h = (window.location.hash || '').replace('#', '');
    if (['t2i', 'edit', 'chat', 'diag'].includes(h)) showTab(h);
  });
});
