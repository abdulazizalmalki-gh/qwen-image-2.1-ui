# Qwen-Image-2.1 test console

[![ci](https://github.com/abdulazizalmalki-gh/qwen-image-2.1-ui/actions/workflows/ci.yml/badge.svg)](https://github.com/abdulazizalmalki-gh/qwen-image-2.1-ui/actions/workflows/ci.yml)

A small web UI for poking at a **Qwen-Image-2.1** model served by
[vLLM-Omni](https://github.com/vllm-project/vllm-omni) over its OpenAI-compatible API.

Built for the vLLM recipe **<https://recipes.vllm.ai/Qwen/Qwen-Image-2.1>**
(model `Qwen/Qwen-Image-2.1`, served as `vllm serve Qwen/Qwen-Image-2.1 --omni`). The recipe
hands you an API and a set of curl commands; this is the front end for actually driving it —
including the parts that are easy to get wrong (the 32-grid size rule, `true_cfg_scale` only
with a negative prompt, multipart edits, the reference-image output size).

This repository ships **the UI only** — no model weights, no inference server, no
CUDA code. You point it at a model server you already run.

```
browser  ->  this UI (FastAPI + static page)  ->  vLLM-Omni server (/v1/...)
```

## What it lets you test

| Tab | Endpoint exercised | What you can vary |
| --- | --- | --- |
| Text → Image | `POST /v1/images/generations` | prompt, negative prompt, size, steps, `true_cfg_scale`, seed |
| Edit / image-conditioned | `POST /v1/images/edits` (multipart, 1–4 references) | reference images (drop/click/paste), instruction, output size (preset, **reference size**, server-decided, or custom), steps, cfg, seed |
| Chat (image in / image out) | `POST /v1/chat/completions` with `modalities:["image"]` | prompt, optional reference images, size, steps, cfg, seed |
| Diagnostics | `/health`, `/v1/models`, `/metrics` | live server state, Prometheus output, link to the server's Swagger UI |

Plus: server/model auto-detection, per-request wall time and the server's own
`stage_0_gen_ms` / `peak_memory_mb` metrics, a session gallery, PNG download,
"send result to the edit tab", and client-side validation (size must be a
multiple of 32, ≤ 4 reference images, CFG>1 warns unless you supply a negative
prompt).

## Quickstart

Pull the published image (multi-arch `linux/amd64` + `linux/arm64`, public):

```bash
docker run --rm -p 8080:8080 \
  -e QWEN_IMAGE_API=http://your-model-server:8000 \
  ghcr.io/abdulazizalmalki-gh/qwen-image-2.1-ui:latest
open http://localhost:8080
```

Or with compose (the default file pulls the published image):

```bash
git clone https://github.com/abdulazizalmalki-gh/qwen-image-2.1-ui.git
cd qwen-image-2.1-ui
cp .env.example .env          # set QWEN_IMAGE_API to your model server
docker compose up -d
open http://localhost:8080
```

Building from source instead of pulling (same service, `build:` from the override):

```bash
docker compose -f docker-compose.yml -f docker-compose.build.yml up -d --build
```

Smoke-test the deployed UI (stdlib only, exercises all three generation paths):

```bash
python3 scripts/smoke_test.py --ui-url http://localhost:8080          # fast: 8 steps, 512x512
python3 scripts/smoke_test.py --ui-url http://localhost:8080 --steps 40 --size 1024x1024 --keep /tmp/ui-out
```

## Size presets

The size dropdown is a generated ladder of **55 presets across 9 aspect ratios**
(1:1, 16:9, 9:16, 4:3, 3:4, 3:2, 2:3, 16:10, 21:9) from 256 to 2048 a side, and the
edit and chat tabs use the same list. Two rules are baked into it, both measured
against the model server:

- **Both sides must be a multiple of 32.** The VAE is a 16x autoencoder and the
  server floors each side silently: `1280x720` renders `1280x704`, `1000x1000`
  renders `992x992`. Exact 16:9 in that grid is `512k x 288k` (`512x288`,
  `1024x576`, `1536x864`, `2048x1152`); the classic names are offered as the size
  the server would actually produce (`1280x704`, `1920x1056`, `704x1280`), so the
  label and the result agree.
- **Free-typed sizes snap instead of failing.** Anything not on the grid is floored
  and reported in a warning; only impossible requests are refused (a side below 256
  or above 2048, which is beyond a 24 GB card's budget).

Presets above ~1 MP are marked *(heavy)* — they need more VRAM than a 24 GB card
comfortably has, so expect a long run or a CUDA OOM. Measured on 2x RTX 3090: 1024x1024
and 1216x704 generate, 1536x864 fails with `CUDA out of memory`.

On the edit tab the size list also carries two reference-driven modes:

- **reference size (W x H)** — sends the uploaded picture's exact
  dimensions (floored to the 32 grid if needed), so an edit comes back at the size you
  fed it. The option label shows the pixels that will be sent.
- **server decides** — sends no size at all. Measured on this build it returns the
  reference's exact dimensions too, so it is a convenience rather than a different result;
  the recipe's documented "~1 MP derived from the aspect" behaviour did not reproduce in
  our tests (640x480, 1216x704 and 1024x1024 references all came back unchanged).

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `QWEN_IMAGE_API` | `http://your-model-server:8000` | Base URL of the vLLM-Omni server |
| `QWEN_IMAGE_MODEL` | *(empty)* | Pin the model id; empty = read the first entry of `/v1/models` |
| `QWEN_IMAGE_TIMEOUT_S` | `900` | Upstream request timeout — image generation is slow, do not set this low |
| `UI_PORT` | `8080` | Host port the UI is published on (compose only) |

The UI never talks to the model server from the browser: every call goes through
`/api/*` on this container, which is what keeps a remote model server free of CORS
configuration and lets the multipart edit call be rebuilt server-side.

## Requirements on the model server side

The server must expose `POST /v1/images/generations`, `POST /v1/images/edits`
(multipart only — a JSON body to that route resets the connection) and
`POST /v1/chat/completions` with `modalities: ["image"]`. Any OpenAI-compatible
image endpoint with that shape works; the reference setup is the
[Qwen-Image-2.1 recipe](https://recipes.vllm.ai/Qwen/Qwen-Image-2.1):

```bash
docker run --gpus all --privileged --ipc=host -p 8000:8000 \
  -v ~/.cache/huggingface:/root/.cache/huggingface \
  vllm/vllm-omni:qwen-image21 Qwen/Qwen-Image-2.1 --omni
```

Notes learned the hard way (see `docs/model-server-notes.md`):

- Send `num_inference_steps` on every request — the checkpoint wants **40**, the
  server default is **50**.
- `true_cfg_scale` only engages alongside a `negative_prompt`; sending a negative
  prompt at cfg 1.0 makes the server apply guidance at 4.0 and roughly doubles the
  compute. This UI strips the combination automatically.
- On GPUs without FP8 tensor cores (e.g. Ampere/RTX 3090) the FP8 path must be
  pinned to the Marlin kernel, and the Qwen3-VL text encoder is replicated per
  rank, so DiT-only FP8 does not fit a 24 GB card.
- 1024x1024 at 40 steps measured ~66 s per image on 2x RTX 3090, ~23.6 GB VRAM peak —
  which is why presets above ~1 MP are flagged heavy.

## Layout

```
app/main.py            FastAPI: static hosting + /api proxy endpoints
app/static/index.html  the console (tabs)
app/static/app.js      client logic, no build step
app/static/styles.css  dark theme
scripts/smoke_test.py  end-to-end check of all three paths against a running UI
tests/ui_dom_test.mjs  jsdom test: drives the real page without a browser
docs/                  model-server notes
```

## Tests

```bash
python3 scripts/smoke_test.py --ui-url http://localhost:8080   # needs a live model server
npm install && npm test                                        # 25 DOM checks, no model needed
```

`tests/ui_dom_test.mjs` loads the real `index.html` + `app.js` in jsdom with a
stubbed `fetch` and walks every tab — payload shape, validation, the CFG/negative
prompt rule, multipart edit assembly, chat image extraction, gallery and
diagnostics. It runs in about a second and needs no GPU.

After a run the edit preview grows an **Original / Edited** switch: both images are kept
client-side (the reference that was actually sent, and the result) and either one is rendered as
large as the column allows, with the meta line saying which you are looking at (`original
1216x704`, or the run's metrics for the edited frame). Download saves whichever is on screen.

## CI

`.github/workflows/ci.yml` runs on every push, PR and tag:

- **tests** — the jsdom DOM suite (`npm test`), a Python syntax check, and
  `scripts/privacy_scan.py`, which fails the build if this deployment's own values (LAN
  prefixes, house host names, service ports, home paths, credential shapes) appear anywhere
  in the repo. Scan it against a deliberately leaky tree to see it work: it exits non-zero
  and names file, line and rule.
- **build** — `linux/amd64` + `linux/arm64` via BuildKit, pushed to GHCR
  (`ghcr.io/abdulazizalmalki-gh/qwen-image-2.1-ui`) with `latest` on the default branch only,
  plus branch/PR and `sha-…` tags, with SBOM and provenance attached.
- **smoke** — boots the pushed image *by digest* (no model server needed), asserts `/`,
  `/app.js` and `/styles.css` serve, that an unreachable model server degrades cleanly to
  `"upstream_reachable":false`, that the container runs as the non-root `appuser`, and then
  re-runs the privacy scan inside the image's `/app` so nothing private can ride along in a
  layer.

## Layout and window shapes

The console is responsive and does not need a particular window size:

- Wide windows get the form on the left and the preview on the right; the grid collapses to one
  column below 1080 px and in short landscape windows (below 620 px tall), so a phone or a
  half-screen window gets a full-width form with the preview beneath it.
- A **portrait 1440p monitor (1440x2560)** keeps both columns — 1440 px is wide enough — and the
  tall viewport is given to the preview (`min-height: 46vh`, image capped at 66vh), so the screen
  is used instead of a small preview stranded at the top.
- The collapse that used to happen there was a `<select>` sizing itself to its widest option and
  pushing the form column wider than the window, clipping text next to it. Guarded with
  `min-width: 0; max-width: 100%` on inputs/selects plus `minmax(0, 1fr)` on the result column and
  `min-width: 0` on its children.
- Paddings, font sizes and preview heights are fluid (`clamp()`), the tab strip scrolls sideways on
  narrow windows, action buttons go full width on phones, the preview is bounded by both
  `max-width: 100%` and a viewport-relative `max-height`, and the shell fills the window so the
  gallery sits at the bottom rather than leaving a dead area under a short page.
- Tabs are deep-linkable: `/#edit`, `/#chat`, `/#diag` open straight onto that pane.

## Limits / known behaviour

- One request at a time is the practical mode: the reference server processes
  requests serially (its `queue_wait_ms` metric shows the queue).
- The gallery is per-session and in-memory; the UI stores nothing on disk.
- The edit results depend on `--vae-use-tiling` on the server: with tiling on,
  seams can appear at the 512 px tile boundary. Full-frame decode is preferred
  where VRAM allows.
- No authentication: run it on a trusted network, or put it behind your own proxy.

## License

MIT — see `LICENSE`.
