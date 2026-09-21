# Notes on standing up the model server this UI expects

Recipe: <https://recipes.vllm.ai/Qwen/Qwen-Image-2.1> — model `Qwen/Qwen-Image-2.1`
(7.1B DiT + Qwen3-VL-8B text encoder + 16x RGBA VAE) served by vLLM-Omni's OpenAI-compatible
API. The recipe's fp8 variant is online quantization of that one checkpoint, not a separate
FP8 repo, and it needs the `vllm/vllm-omni:qwen-image21` image because upstream PR #7759 was
still unmerged.

These are findings from running that recipe on consumer Ampere cards (2x RTX 3090). They are
not requirements of the UI — they are the traps we hit, so you do not have to rediscover them.

## Support ships only in the container image

Upstream `vllm-project/vllm-omni#7759` was still unmerged when this was written, so
`pip install vllm-omni` has nothing to serve Qwen-Image-2.1. Use the dedicated image:

```bash
docker run --gpus all --privileged --ipc=host -p 8000:8000 \
  -v ~/.cache/huggingface:/root/.cache/huggingface \
  vllm/vllm-omni:qwen-image21 Qwen/Qwen-Image-2.1 --omni
```

That image has **no ENTRYPOINT** (`Config.Entrypoint` and `.Cmd` are both null).
Under compose you must set `entrypoint: ["vllm", "serve"]`, otherwise the first
argument is executed as a program and you get:

```
exec: "/models": is a directory: permission denied
```

## FP8 on Ampere needs the Marlin kernel

FP8 is *online* quantization — there is no separate FP8 checkpoint to download. The
recipe's fp8 variant is one extra argument on the BF16 weights:

```bash
--diffusion-quantization-config '{"transformer":{"method":"fp8","ignored_layers":["img_mlp"]}}'
```

On a device without FP8 tensor cores the selector can still pick the CUTLASS w8a8
kernel (its `is_supported()` returns True on any CUDA device in 0.29.0) and the
startup dummy run aborts with:

```
RuntimeError: Dummy run failed: cutlass_scaled_mm_sm80_epilogue, .../w8a8/cutlass/scaled_mm_c2x.cu:89
```

The working path on capability < 8.9 is Marlin — vLLM's own "FP8 kernel for GPUs
that lack FP8 hardware support" (capability >= 7.5):

```bash
--linear-backend marlin
VLLM_DISABLED_KERNELS=FlashInferFP8ScaledMMLinearKernel,CutlassFP8ScaledMMLinearKernel,B12xTensorFP8ScaledMMLinearKernel,PerTensorTorchFP8ScaledMMLinearKernel,ChannelWiseTorchFP8ScaledMMLinearKernel,HummingFP8ScaledMMLinearKernel
```

Success looks like this line in the log:

```
Selected MarlinFP8ScaledMMLinearKernel for Fp8PerTensorOnlineLinearMethod
```

## The text encoder is replicated per rank

`pipeline_qwen_image_21.py` loads the Qwen3-VL text encoder with `.to(device)`
inside every diffusion worker, so each rank holds a full 17.5 GB BF16 copy on top
of its DiT shard and the VAE. With two 24 GB cards, DiT-only FP8 runs out of memory
during startup (measured: 23.44 GiB used, 47 MiB free). Add the text-encoder key —
the language-model linears are quantized, the vision tower and the unused LM head
stay BF16:

```bash
--diffusion-quantization-config '{"transformer":{"method":"fp8","ignored_layers":["img_mlp"]},"text_encoder":{"method":"fp8"}}'
```

Measured on 2x RTX 3090 (TP=2): ~19.1 GiB per card steady, ~23.6 GiB peak during a
1024x1024 generation, ~66 s per image at 40 steps.

## VAE tiling trades quality for memory

`--vae-use-tiling` decodes in 512 px tiles at 384 px stride. A/B on the same seed
shows the difference concentrated along the tile boundary (worst columns 501–506,
rows 511–521; mean |Δ| ≈ 2/255, max 153) — visible as a seam in edits. Full-frame
decode peaked 22.6/23.53 GiB per card at 1024x1024, so prefer no tiling unless you
need the headroom for larger sizes or multi-image edits (the server halves tiles
automatically on CUDA OOM).

## Request shape gotchas

- `num_inference_steps` is sent per request; the checkpoint wants 40 (server default 50).
- `true_cfg_scale` defaults to 4.0 upstream but only applies with a `negative_prompt`.
  Without a negative prompt, CFG is effectively off — which is what you want, since
  guidance roughly doubles compute.
- `size` values are floored to a multiple of 32, never rejected.
- **An omitted size does not scale the output to ~1 MP.** The recipe says an edit
  request without a size "derives the output size from the last condition image's
  aspect ratio at approximately 1024x1024". Measured on this build with single-reference
  edits, omitting the size returned the reference's exact dimensions every time
  (640x480 -> 640x480, 1216x704 -> 1216x704, 1024x1024 -> 1024x1024). Pass an explicit
  size when you care, and treat "same as the reference image" as the reliable option.
- **Practical VRAM ceiling on 2x24 GB:** 1024x1024 (1.05 MP) and 1216x704 (0.86 MP)
  generate fine; 1536x864 (1.33 MP) dies with `CUDA out of memory. Tried to allocate
  1.42 GiB ... 1.11 GiB is free` at ~22.4 GiB in use. Presets above ~1 MP are flagged
  *(heavy)* in the UI for that reason.
- `/v1/images/edits` takes multipart/form-data, not JSON; a JSON body resets the
  connection, which is easy to mistake for a broken server.
- Up to 4 reference images per request; a fifth is rejected with a 400.
