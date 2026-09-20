#!/usr/bin/env python3
"""End-to-end smoke test for the Qwen-Image-2.1 console.

Exercises the UI's own endpoints (which proxy the model server), so it proves the
whole chain: browser API -> UI backend -> vLLM-Omni.

    python3 scripts/smoke_test.py --ui-url http://127.0.0.1:8080
    python3 scripts/smoke_test.py --ui-url http://127.0.0.1:8080 --steps 40   # real quality

Stdlib only. Exits non-zero if any step fails.
"""
from __future__ import annotations

import argparse
import base64
import json
import os
import sys
import time
import urllib.error
import urllib.request
import uuid

PNG_MAGIC = b"\x89PNG\r\n\x1a\n"
failures: list[str] = []


def save(directory: str | None, name: str, blob: bytes) -> None:
    """Keep the artefacts without letting an I/O problem fail the check itself."""
    if not directory:
        return
    try:
        with open(os.path.join(directory, name), "wb") as f:
            f.write(blob)
    except OSError as exc:
        print(f"      (could not save {name}: {exc})")


def call(url: str, method: str = "GET", payload: dict | None = None, timeout: float = 900.0):
    data = None
    headers = {}
    if payload is not None:
        data = json.dumps(payload).encode()
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        body = r.read()
        ctype = r.headers.get("Content-Type", "")
        return r.status, (json.loads(body) if "json" in ctype else body)


def multipart(url: str, fields: dict, files: list[tuple[str, bytes]], timeout: float = 900.0):
    boundary = "----smoke" + uuid.uuid4().hex
    body = bytearray()
    for k, v in fields.items():
        body += f'--{boundary}\r\nContent-Disposition: form-data; name="{k}"\r\n\r\n{v}\r\n'.encode()
    for name, blob in files:
        body += (
            f'--{boundary}\r\nContent-Disposition: form-data; name="{name}"; '
            f'filename="{name}.png"\r\nContent-Type: image/png\r\n\r\n'
        ).encode()
        body += blob + b"\r\n"
    body += f"--{boundary}--\r\n".encode()
    req = urllib.request.Request(
        url, data=bytes(body), headers={"Content-Type": f"multipart/form-data; boundary={boundary}"}
    )
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.status, json.loads(r.read())


def check(name: str, ok: bool, detail: str = "") -> bool:
    print(f"{'PASS' if ok else 'FAIL'}  {name}" + (f" — {detail}" if detail else ""))
    if not ok:
        failures.append(name)
    return ok


def png_from(resp: dict) -> bytes:
    return base64.b64decode(resp["data"][0]["b64_json"])


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--ui-url", default="http://127.0.0.1:8080")
    ap.add_argument("--steps", type=int, default=8, help="8 keeps the smoke test ~15 s")
    ap.add_argument("--size", default="512x512")
    ap.add_argument("--keep", metavar="DIR", help="write generated PNGs here for eyeballing")
    a = ap.parse_args()
    base = a.ui_url.rstrip("/")
    if a.keep:
        os.makedirs(a.keep, exist_ok=True)

    try:
        _, cfg = call(f"{base}/api/config")
        check("GET /api/config returns a model id", bool(cfg.get("model")), str(cfg.get("model")))
        check("model server reachable", bool(cfg.get("upstream_reachable")), cfg.get("detail", ""))
    except urllib.error.URLError as e:
        check("UI reachable", False, str(e))
        return 1

    try:
        _, h = call(f"{base}/api/health")
        check("GET /api/health probes upstream", "/v1/models" in h)
    except Exception as e:
        check("GET /api/health probes upstream", False, str(e))

    prompt = f"a small wooden box on a plain table (smoke {int(time.time())})"
    t2i = None
    try:
        t0 = time.time()
        _, t2i = call(f"{base}/api/generate", "POST", {
            "prompt": prompt, "size": a.size, "num_inference_steps": a.steps, "true_cfg_scale": 1.0,
        })
        img = png_from(t2i)
        wall = time.time() - t0
        check("POST /api/generate returns a PNG", img[:8] == PNG_MAGIC, f"{len(img)} bytes, {wall:.1f}s")
        check("generation reports metrics", bool((t2i.get("metrics") or {}).get("stage_durations")),
              json.dumps((t2i.get("metrics") or {}).get("stage_durations", {})))
        save(a.keep, "smoke-t2i.png", img)
    except Exception as e:
        check("POST /api/generate returns a PNG", False, str(e))

    if t2i:
        try:
            blob = png_from(t2i)
            _, ed = multipart(f"{base}/api/edit", {
                "prompt": "add the word SMOKE in small white letters on the box",
                "size": a.size, "steps": str(a.steps), "cfg": "1.0",
            }, [("images", blob)])
            img = png_from(ed)
            check("POST /api/edit (multipart, 1 reference) returns a PNG", img[:8] == PNG_MAGIC, f"{len(img)} bytes")
            save(a.keep, "smoke-edit.png", img)
        except Exception as e:
            check("POST /api/edit (multipart, 1 reference) returns a PNG", False, str(e))

    try:
        _, chat = call(f"{base}/api/chat-image", "POST", {
            "prompt": "a green apple on a white plate", "size": a.size,
            "steps": a.steps, "cfg": 1.0,
        })
        content = (((chat.get("choices") or [{}])[0].get("message") or {}).get("content"))
        url = ""
        if isinstance(content, list):
            url = next((c["image_url"]["url"] for c in content if isinstance(c, dict) and c.get("image_url")), "")
        check("POST /api/chat-image returns an image content part", url.startswith("data:image"),
              f"{len(url)} chars" if url else "no image_url part")
        if url:
            save(a.keep, "smoke-chat.png", base64.b64decode(url.split(",", 1)[1]))
    except Exception as e:
        check("POST /api/chat-image returns an image content part", False, str(e))

    print()
    if failures:
        print(f"{len(failures)} step(s) failed: {', '.join(failures)}")
        return 1
    print("all smoke steps passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
