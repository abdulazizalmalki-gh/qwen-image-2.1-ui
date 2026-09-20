"""Qwen-Image-2.1 test UI — thin backend proxy in front of a vLLM-Omni server.

The UI itself is a static page; this service exists so the browser never talks
to the model server directly (no CORS, one place to configure the endpoint, and
the multipart /v1/images/edits call is rebuilt server-side).

Only the UI ships in this repo — the model, weights and the vLLM-Omni server
are external and reached through QWEN_IMAGE_API.
"""
from __future__ import annotations

import os
from typing import Annotated

import httpx
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import PlainTextResponse
from fastapi.staticfiles import StaticFiles

API_BASE = os.environ.get("QWEN_IMAGE_API", "http://localhost:8000").rstrip("/")
MODEL_OVERRIDE = os.environ.get("QWEN_IMAGE_MODEL", "").strip()
TIMEOUT_S = float(os.environ.get("QWEN_IMAGE_TIMEOUT_S", "900"))
STATIC_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "static")

app = FastAPI(title="Qwen-Image-2.1 test UI", version="1.0.0")


def _client() -> httpx.AsyncClient:
    return httpx.AsyncClient(base_url=API_BASE, timeout=httpx.Timeout(TIMEOUT_S, connect=10.0))


async def _upstream_model(client: httpx.AsyncClient) -> str:
    """The model id the server answers to; never assume it, read it."""
    if MODEL_OVERRIDE:
        return MODEL_OVERRIDE
    try:
        r = await client.get("/v1/models")
        r.raise_for_status()
        data = r.json().get("data") or []
        if data:
            return data[0].get("id") or ""
    except Exception:
        pass
    return ""


@app.get("/api/config")
async def config() -> dict:
    async with _client() as client:
        model = await _upstream_model(client)
        reachable, detail = True, "ok"
        try:
            r = await client.get("/health")
            reachable = r.status_code < 500
        except Exception as exc:  # connection refused, DNS, timeout
            reachable, detail = False, str(exc)
    return {
        "api_base": API_BASE,
        "model": model,
        "defaults": {"size": "1024x1024", "steps": 40, "cfg": 1.0},
        "upstream_reachable": reachable,
        "detail": detail,
    }


@app.get("/api/health")
async def health() -> dict:
    async with _client() as client:
        out: dict = {"api_base": API_BASE}
        for path in ("/health", "/v1/models"):
            try:
                r = await client.get(path)
                out[path] = {"status": r.status_code, "body": r.text[:400]}
            except Exception as exc:
                out[path] = {"status": None, "error": str(exc)}
        return out


@app.get("/api/metrics", response_class=PlainTextResponse)
async def metrics() -> str:
    async with _client() as client:
        try:
            r = await client.get("/metrics")
            return r.text
        except Exception as exc:
            raise HTTPException(status_code=502, detail=f"metrics unavailable: {exc}")


@app.post("/api/generate")
async def generate(payload: dict) -> dict:
    """Proxy /v1/images/generations (JSON in, JSON out — response carries metrics)."""
    async with _client() as client:
        model = await _upstream_model(client)
        if not model:
            raise HTTPException(status_code=502, detail="model server unreachable")
        body = {**payload, "model": model}
        # Upstream only engages the negative prompt when true_cfg_scale > 1; sending
        # both at cfg 1.0 makes the server apply guidance 4.0 and double the compute.
        if float(body.get("true_cfg_scale") or 1.0) <= 1.0 or not str(body.get("negative_prompt", "")).strip():
            body.pop("negative_prompt", None)
        try:
            r = await client.post("/v1/images/generations", json=body)
        except Exception as exc:
            raise HTTPException(status_code=502, detail=str(exc))
        if r.status_code >= 400:
            raise HTTPException(status_code=r.status_code, detail=r.text[:2000])
        return r.json()


@app.post("/api/edit")
async def edit(
    prompt: Annotated[str, Form()],
    images: Annotated[list[UploadFile], File()],
    size: Annotated[str, Form()] = "1024x1024",
    steps: Annotated[int, Form()] = 40,
    cfg: Annotated[float, Form()] = 1.0,
    seed: Annotated[str, Form()] = "",
    negative_prompt: Annotated[str, Form()] = "",
) -> dict:
    """Proxy /v1/images/edits. That endpoint is multipart-only upstream."""
    if not images:
        raise HTTPException(status_code=400, detail="at least one reference image is required")
    if len(images) > 4:
        raise HTTPException(status_code=400, detail="the model accepts at most 4 reference images")

    async with _client() as client:
        model = await _upstream_model(client)
        if not model:
            raise HTTPException(status_code=502, detail="model server unreachable")

        fields: dict[str, str] = {
            "model": model,
            "prompt": prompt,
            "size": size,
            "num_inference_steps": str(steps),
            "true_cfg_scale": str(cfg),
        }
        if seed.strip():
            fields["seed"] = seed.strip()
        if negative_prompt.strip() and float(cfg) > 1.0:
            fields["negative_prompt"] = negative_prompt.strip()

        files = []
        for up in images:
            content = await up.read()
            files.append(("image", (up.filename or "image.png", content, up.content_type or "image/png")))
        try:
            r = await client.post("/v1/images/edits", data=fields, files=files)
        except Exception as exc:
            raise HTTPException(status_code=502, detail=str(exc))
        if r.status_code >= 400:
            raise HTTPException(status_code=r.status_code, detail=r.text[:2000])
        return r.json()


@app.post("/api/chat-image")
async def chat_image(payload: dict) -> dict:
    """Exercise the chat-completions path, which returns the picture in the message."""
    prompt = (payload.get("prompt") or "").strip()
    if not prompt:
        raise HTTPException(status_code=400, detail="prompt is required")
    data_urls = payload.get("images") or []

    content: list[dict] = [
        {"type": "image_url", "image_url": {"url": url}} for url in data_urls if url
    ]
    content.append({"type": "text", "text": prompt})

    async with _client() as client:
        model = await _upstream_model(client)
        if not model:
            raise HTTPException(status_code=502, detail="model server unreachable")
        body = {
            "model": model,
            "messages": [{"role": "user", "content": content}],
            "modalities": ["image"],
            "extra_body": {
                "size": payload.get("size", "1024x1024"),
                "num_inference_steps": int(payload.get("steps", 40)),
                "true_cfg_scale": float(payload.get("cfg", 1.0)),
                **({"seed": int(payload["seed"])} if str(payload.get("seed", "")).strip() else {}),
            },
        }
        try:
            r = await client.post("/v1/chat/completions", json=body)
        except Exception as exc:
            raise HTTPException(status_code=502, detail=str(exc))
        if r.status_code >= 400:
            raise HTTPException(status_code=r.status_code, detail=r.text[:2000])
        return r.json()


app.mount("/", StaticFiles(directory=STATIC_DIR, html=True), name="static")
