# Qwen-Image-2.1 test console

A small web UI for poking at a **Qwen-Image-2.1** model served by
[vLLM-Omni](https://github.com/vllm-project/vllm-omni) over its OpenAI-compatible API.

This repository ships **the UI only** — no model weights, no inference server, no
CUDA code. You point it at a model server you already run.

```
browser  ->  this UI (FastAPI + static page)  ->  vLLM-Omni server (/v1/...)
```

## What it lets you test

| Tab | Endpoint exercised | What you can vary |
| --- | --- | --- |
| Text → Image | `POST /v1/images/generations` | prompt, negative prompt, size, steps, `true_cfg_scale`, seed |
| Edit / image-conditioned | `POST /v1/images/edits` (multipart, 1–4 references) | reference images (drop/click/paste), instruction, size, steps, cfg, seed |
| Chat (image in / image out) | `POST /v1/chat/completions` with `modalities:["image"]` | prompt, optional reference images, size, steps, cfg, seed |
| Diagnostics | `/health`, `/v1/models`, `/metrics` | live server state, Prometheus output, link to the server's Swagger UI |

Plus: server/model auto-detection, per-request wall time and the server's own
`stage_0_gen_ms` / `peak_memory_mb` metrics, a session gallery, PNG download,
"send result to the edit tab", and client-side validation (size must be a
multiple of 32, ≤ 4 reference images, CFG>1 warns unless you supply a negative
prompt).

## Quickstart

```bash
git clone https://github.com/abdulazizalmalki-gh/qwen-image-ui.git
cd qwen-image-ui
cp .env.example .env          # set QWEN_IMAGE_API to your model server
docker compose up -d --build
open http://localhost:8080
```

Without compose:

```bash
docker build -t qwen-image-ui .
docker run --rm -p 8080:8080 -e QWEN_IMAGE_API=http://your-model-server:8000 qwen-image-ui
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
comfortably has, so expect a long run or a CUDA OOM.

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
image endpoint with that shape works; the reference setup is:

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
