/**
 * DOM test for the Qwen-Image-2.1 console: loads the real index.html with the
 * real app.js inside jsdom, stubs fetch, and drives every tab the way a user
 * would. Catches runtime errors and wiring mistakes a syntax check cannot.
 *
 *   npm install
 *   node tests/ui_dom_test.mjs
 */
import fs from 'node:fs';
import { JSDOM } from 'jsdom';

const root = new URL('..', import.meta.url);
const HTML = fs.readFileSync(new URL('app/static/index.html', root), 'utf8');
const APP = fs.readFileSync(new URL('app/static/app.js', root), 'utf8');

const calls = [];
const b64 = Buffer.from('89504e470d0a1a0a' + '00'.repeat(64), 'hex').toString('base64');
const b64Edited = Buffer.from('89504e470d0a1a0a' + '11'.repeat(64), 'hex').toString('base64');

function reply(url, opts) {
  if (url.endsWith('/api/config')) {
    return json({ api_base: 'http://model-box:8000', model: 'Qwen/Qwen-Image-2.1', defaults: { size: '1024x1024', steps: 40, cfg: 1.0 }, upstream_reachable: true, detail: 'ok' });
  }
  if (url.endsWith('/api/health')) return json({ '/health': { status: 200 }, '/v1/models': { status: 200 } });
  if (url.endsWith('/api/metrics')) return new Response('vllm:num_requests_running 0\n', { status: 200, headers: { 'Content-Type': 'text/plain' } });
  if (url.endsWith('/api/generate')) return json({ data: [{ b64_json: b64 }], size: '1024x1024', output_format: 'png', metrics: { stage_durations: { queue_wait_ms: 0.4, stage_0_gen_ms: 65500 }, peak_memory_mb: 23620 } });
  if (url.endsWith('/api/edit')) return json({ data: [{ b64_json: b64Edited }], size: '1024x1024', metrics: { stage_durations: { stage_0_gen_ms: 71000 }, peak_memory_mb: 23600 } });
  if (url.endsWith('/api/chat-image')) return json({ choices: [{ message: { content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,' + b64 } }] } }], metrics: {} });
  return json({}, 404);
}
const json = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { 'Content-Type': 'application/json' } });

const results = [];
const check = (name, ok, detail = '') => { results.push([name, ok, detail]); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`); };

const dom = new JSDOM(HTML.replace('</body>', `<script>${APP}</script></body>`), {
  url: 'http://localhost:8080/',
  runScripts: 'dangerously',
  pretendToBeVisual: true,
  beforeParse(window) {
    window.fetch = async (url, opts = {}) => { calls.push({ url: String(url), opts }); return reply(String(url), opts); };
    window.onerror = (e) => check('no uncaught error', false, String(e));
  },
});

const { window } = dom;
const $ = (id) => window.document.getElementById(id);
const tick = () => new Promise((r) => setTimeout(r, 60));

await tick();
await tick();

check('page has all four tabs', window.document.querySelectorAll('nav.tabs button').length === 4);
check('config applied: model id shown', $('model-name').textContent === 'Qwen/Qwen-Image-2.1', $('model-name').textContent);
check('config applied: api base shown', $('api-pill').textContent.includes('model-box:8000'), $('api-pill').textContent);
check('health dot is green', $('dot').className.includes('ok'), $('dot').className);
check('footer credits the recipe this UI was built for',
  !!$('footer-model') && window.document.querySelector('.footer-note a').href === 'https://recipes.vllm.ai/Qwen/Qwen-Image-2.1',
  window.document.querySelector('.footer-note a').href);
check('footer names the served model', $('footer-model').textContent === 'Qwen/Qwen-Image-2.1', $('footer-model').textContent);

// --- text to image, including the CFG warning path --------------------------
$('t2i-prompt').value = 'a ceramic teapot on a wooden table';
$('t2i-steps').value = '40';
$('t2i-cfg').value = '2.5';
$('t2i-cfg').oninput();                       // warning hint
check('cfg hint warns above 1.0', $('t2i-cfg-hint').textContent.includes('negative prompt'), $('t2i-cfg-hint').textContent);
$('t2i-run').click();
await tick(); await tick();
const genCall = calls.find((c) => c.url.endsWith('/api/generate'));
const genBody = genCall ? JSON.parse(genCall.opts.body) : {};
check('generate posted the model-agnostic payload', genBody.prompt === 'a ceramic teapot on a wooden table' && genBody.num_inference_steps === 40 && genBody.true_cfg_scale === 2.5, JSON.stringify(genBody));
check('negative_prompt NOT sent at cfg>1 without one', !('negative_prompt' in genBody));
check('image rendered in the t2i frame', !!$('t2i-frame').querySelector('img'));
check('metrics shown (gen time + peak VRAM)', $('t2i-meta').textContent.includes('generate 65.5 s') && $('t2i-meta').textContent.includes('peak VRAM 23.1 GiB'), $('t2i-meta').textContent);
check('download + send-to-edit became enabled', !$('t2i-download').disabled && !$('t2i-to-edit').disabled);
check('warning banner survived the run', $('t2i-banner').textContent.includes('negative prompt'), $('t2i-banner').textContent);
check('gallery has 1 item', $('gallery-count').textContent === '(1)', $('gallery-count').textContent);

// --- size presets -----------------------------------------------------------
const presetGroups = [...$('t2i-size').querySelectorAll('optgroup')].map((g) => g.label);
const allPresets = [...$('t2i-size').querySelectorAll('optgroup option')].map((o) => o.value).filter((v) => /^\d+x\d+$/.test(v));
const badPresets = allPresets.filter((v) => {
  const m = /^(\d+)x(\d+)$/.exec(v);
  return !m || (+m[1]) % 32 !== 0 || (+m[2]) % 32 !== 0;
});
check('every preset keeps both sides a multiple of 32', badPresets.length === 0, badPresets.join(', '));
check('preset ladder is complete (>= 50 entries)', allPresets.length >= 50, String(allPresets.length));
check('aspect ratios covered', ['1:1 square', '16:9 landscape', '9:16 portrait', '4:3 landscape', '3:4 portrait', '3:2 landscape', '2:3 portrait', '16:10 landscape', '21:9 ultrawide'].every((g) => presetGroups.includes(g)), presetGroups.join(' | '));
const sixteenNine = [...$('t2i-size').querySelectorAll('optgroup')].find((g) => g.label === '16:9 landscape');
const nineSixteen = [...$('t2i-size').querySelectorAll('optgroup')].find((g) => g.label === '9:16 portrait');
check('16:9 group has exact ratios (512x288 … 2048x1152)', sixteenNine && ['512x288', '1024x576', '1536x864', '2048x1152'].every((v) => [...sixteenNine.querySelectorAll('option')].some((o) => o.value === v)));
check('16:9 group offers the classic 720p/1080p as floored sizes', sixteenNine && ['1280x704', '1920x1056'].every((v) => [...sixteenNine.querySelectorAll('option')].some((o) => o.value === v)));
check('9:16 group is the mirror of 16:9', nineSixteen && ['288x512', '576x1024', '864x1536', '1152x2048'].every((v) => [...nineSixteen.querySelectorAll('option')].some((o) => o.value === v)));
const editOptions = [...$('edit-size').options].map((o) => o.value);
const chatOptions = [...$('chat-size').options].map((o) => o.value);
check('chat tab offers the same ladder (plus custom)', allPresets.every((v) => chatOptions.includes(v)) && chatOptions.length === allPresets.length + 1, String(chatOptions.length));
check('edit tab offers the same ladder plus its two reference modes', allPresets.every((v) => editOptions.includes(v)) && ['reference', 'auto'].every((v) => editOptions.includes(v)) && editOptions.length === allPresets.length + 3, String(editOptions.length));

// --- a preset that used to be broken now runs -----------------------------
$('t2i-size').value = '1280x704';
$('t2i-run').click();
await tick(); await tick();
const lastGen = calls.filter((c) => c.url.endsWith('/api/generate')).pop();
check('the 720p-class preset generates a 16:9 request', JSON.parse(lastGen.opts.body).size === '1280x704', JSON.parse(lastGen.opts.body).size);

// --- custom size that is not a multiple of 32 snaps instead of blocking ----
$('t2i-size').value = 'custom';
$('t2i-size').onchange({ target: { value: 'custom' } });
$('t2i-size-custom').value = '1000x1000';
const before = calls.filter((c) => c.url.endsWith('/api/generate')).length;
$('t2i-run').click();
await tick(); await tick();
const after = calls.filter((c) => c.url.endsWith('/api/generate')).length;
check('custom non-multiple size is not blocked', after === before + 1, `${before} -> ${after}`);
check('snapped size sent to the server', JSON.parse(calls.filter((c) => c.url.endsWith('/api/generate')).pop().opts.body).size === '992x992');
check('the snap is explained in the banner', $('t2i-banner').textContent.includes('multiple of 32') && $('t2i-banner').textContent.includes('992x992'), $('t2i-banner').textContent);

// --- a size beyond the budget is still refused -----------------------------
$('t2i-size-custom').value = '4096x4096';
const before2 = calls.filter((c) => c.url.endsWith('/api/generate')).length;
$('t2i-run').click();
await tick();
check('a 4096x4096 request is refused with a clear reason', calls.filter((c) => c.url.endsWith('/api/generate')).length === before2 && $('t2i-banner').textContent.includes('VRAM'), $('t2i-banner').textContent);

// --- send-to-edit + edit run ------------------------------------------------
$('t2i-to-edit').click();
await tick();
check('send-to-edit fills one reference', window.document.querySelectorAll('#edit-thumbs .thumb').length === 1);
check('edit tab is shown', $('edit').classList.contains('active'));
$('edit-size').value = '1024x1024';
$('edit-prompt').value = 'write FRESH BASIL on the teapot in dark green lettering';
$('edit-steps').value = '40';
$('edit-run').click();
await tick(); await tick();
const editCall = calls.find((c) => c.url.endsWith('/api/edit'));
check('edit posted multipart form data', !!editCall && editCall.opts.body instanceof window.FormData);
check('edit carries 1 image + prompt', editCall && editCall.opts.body.getAll('images').length === 1 && editCall.opts.body.get('prompt').includes('FRESH BASIL'));
check('edit image rendered', !!$('edit-frame').querySelector('img') && $('edit-frame').querySelector('img').src.includes(b64Edited.slice(0, 16)));
check('gallery collected every result', +$('gallery-count').textContent.replace(/\D/g, '') >= 4, $('gallery-count').textContent);

// --- original vs edited toggle on the edit tab ------------------------------
const editImg = () => $('edit-frame').querySelector('img');
check('edit tab shows the Original/Edited toggle after a run', !$('edit-compare').hidden);
check('Edited is the active view by default', $('edit-view-edited').classList.contains('active') && !$('edit-view-original').classList.contains('active'));
const editedSrc = editImg().src;
check('frame shows the edited result', editedSrc.startsWith('data:image/png;base64,'));
$('edit-view-original').click();
await tick();
const originalSrc = editImg().src;
check('Original shows the reference image instead', originalSrc !== editedSrc && originalSrc.startsWith('data:image/'), originalSrc.slice(0, 30));
check('Original is now the active view', $('edit-view-original').classList.contains('active') && !$('edit-view-edited').classList.contains('active'));
check('meta names the original view', $('edit-meta').textContent.includes('original'), $('edit-meta').textContent);
$('edit-view-edited').click();
await tick();
check('toggling back restores the edited result', editImg().src === editedSrc);
check('meta switches back to the run metrics', $('edit-meta').textContent.includes('generate'), $('edit-meta').textContent);

// --- edit output size: same-as-reference and server-derived -----------------
const editGroups = [...$('edit-size').querySelectorAll('optgroup')].map((g) => g.label);
check('edit offers reference-driven size modes', editGroups.includes('from the reference image'), editGroups.join(' | '));
const editSizeValues = [...$('edit-size').options].map((o) => o.value);
check('edit has a "reference size" mode', editSizeValues.includes('reference'));
check('edit has "server-derived from reference aspect"', editSizeValues.includes('auto'));

// jsdom cannot decode images, so inject the pixel size the browser would report
window.eval("state.refs[state.refs.length - 1].w = 640; state.refs[state.refs.length - 1].h = 480; refreshReferenceSizeOption();");
check('reference option stays short enough to fit the select', $('edit-size-reference-option').textContent === 'reference size', $('edit-size-reference-option').textContent);
$('edit-size').value = 'reference';
$('edit-size').onchange();
check('the size hint reports the exact output pixels', $('edit-size-hint').textContent.includes('output 640x480'), $('edit-size-hint').textContent);
$('edit-size').value = 'auto';
$('edit-size').onchange();
check('the hint explains the server-decided mode', $('edit-size-hint').textContent.includes('no size sent'), $('edit-size-hint').textContent);

$('edit-size').value = 'reference';
$('edit-run').click();
await tick(); await tick();
const refCall = calls.filter((c) => c.url.endsWith('/api/edit')).pop();
check('"same size as reference" sends the reference size', refCall.opts.body.get('size') === '640x480', String(refCall.opts.body.get('size')));

$('edit-size').value = 'auto';
$('edit-run').click();
await tick(); await tick();
const autoCall = calls.filter((c) => c.url.endsWith('/api/edit')).pop();
check('"server-derived" omits the size field entirely', autoCall.opts.body.get('size') === null, String(autoCall.opts.body.get('size')));
check('and the banner explains what the server will do', $('edit-banner').textContent.includes('measured behaviour'), $('edit-banner').textContent);

$('edit-size').value = 'custom';
$('edit-size').onchange();
$('edit-size-custom').value = '1000x1000';
$('edit-run').click();
await tick(); await tick();
const customEdit = calls.filter((c) => c.url.endsWith('/api/edit')).pop();
check('edit custom size snaps to the grid', customEdit.opts.body.get('size') === '992x992', String(customEdit.opts.body.get('size')));
$('edit-view-original').click();
await tick();
check('Original label carries the reference pixels once known', $('edit-meta').textContent.includes('original 640x480'), $('edit-meta').textContent);
$('edit-view-edited').click();
await tick();

$('edit-size').value = '1024x1024';
$('edit-size').onchange();

// --- chat tab ---------------------------------------------------------------
window.document.querySelector('nav.tabs button[data-tab="chat"]').click();
$('chat-prompt').value = 'a green apple on a white plate';
$('chat-run').click();
await tick(); await tick();
check('chat posted to /api/chat-image', calls.some((c) => c.url.endsWith('/api/chat-image')));
check('chat image extracted from message.content[0].image_url', !!$('chat-frame').querySelector('img'));
check('chat raw json visible', $('chat-jsonpre').textContent.includes('image_url'));

// --- diagnostics ------------------------------------------------------------
window.document.querySelector('nav.tabs button[data-tab="diag"]').click();
await tick(); await tick();
check('diagnostics loaded health', $('diag-health').textContent.includes('/v1/models'), $('diag-health').textContent.slice(0, 60));
check('diagnostics loaded metrics', $('diag-metrics').textContent.includes('vllm:num_requests_running'));
check('docs link points at the model server', $('diag-docs').href === 'http://model-box:8000/docs', $('diag-docs').href);

const failed = results.filter(([, ok]) => !ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
