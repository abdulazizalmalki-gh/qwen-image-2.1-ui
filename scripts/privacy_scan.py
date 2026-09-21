#!/usr/bin/env python3
"""Fail if private or environment-specific values reach the repo or the image.

Two rule sets:
  * private  — this deployment's own values (LAN prefixes, host names, house ports,
               home paths, credential shapes). These must never be committed.
  * generic  — obvious credential shapes, so a stray token is caught even if it is
               not one of ours.

Usage:
    python3 scripts/privacy_scan.py                 # scan the working tree
    python3 scripts/privacy_scan.py --root /app     # scan an unpacked image layer

Exit code 1 with a report when anything matches.
"""
from __future__ import annotations

import argparse
import pathlib
import re
import sys

PRIVATE = {
    "private IPv4 (10/8)": r"\b10\.\d{1,3}\.\d{1,3}\.\d{1,3}\b",
    "private IPv4 (192.168/16)": r"\b192\.168\.\d{1,3}\.\d{1,3}\b",
    "private IPv4 (172.16/12)": r"\b172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}\b",
    "home directory path": r"/home/(?!runner|user\b)[a-z][a-z0-9_-]{2,}",
    "house hostname": r"\b(myllm|mybutler|mynas|myjumpserver|dev-vm|myhetvm)\b",
    "house service port": r"\b18(0[0-9][0-9]|1[0-9][0-9])\b",
    "other account name": r"\bletechlead\b",
    "ssh key path": r"id_ed25519_[a-z0-9]+",
    "HF token shape": r"\bhf_[A-Za-z0-9]{20,}\b",
}

GENERIC = {
    "GitHub token": r"\b(gh[pousr]_[A-Za-z0-9]{20,})\b",
    "generic api key assignment": r"(?i)\b(api[_-]?key|secret|token|password)\b\s*[:=]\s*['\"][^'\"\s]{12,}['\"]",
    "private key block": r"-----BEGIN [A-Z ]*PRIVATE KEY-----",
    "Slack token": r"\bxox[abprs]-[A-Za-z0-9-]{10,}\b",
    "AWS access key": r"\bAKIA[0-9A-Z]{16}\b",
}

SKIP_DIRS = {".git", "node_modules", "__pycache__", ".venv", "venv", ".pytest_cache"}
# this file spells the patterns out in plain text, so scanning it would self-match
SKIP_FILES = {"privacy_scan.py"}
SKIP_SUFFIX = {".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".pyc", ".woff", ".woff2"}


def iter_files(root: pathlib.Path):
    for path in sorted(root.rglob("*")):
        if not path.is_file():
            continue
        if any(part in SKIP_DIRS for part in path.parts):
            continue
        if path.name in SKIP_FILES:
            continue
        if path.suffix.lower() in SKIP_SUFFIX:
            continue
        yield path


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--root", default=".", help="directory to scan (default: cwd)")
    ap.add_argument("--rules", choices=["all", "private", "generic"], default="all")
    args = ap.parse_args()

    root = pathlib.Path(args.root).resolve()
    rules: dict[str, str] = {}
    if args.rules in ("all", "private"):
        rules |= PRIVATE
    if args.rules in ("all", "generic"):
        rules |= GENERIC
    compiled = {name: re.compile(pattern) for name, pattern in rules.items()}

    hits: list[str] = []
    scanned = 0
    for path in iter_files(root):
        try:
            text = path.read_text(encoding="utf-8", errors="ignore")
        except OSError:
            continue
        scanned += 1
        for lineno, line in enumerate(text.splitlines(), 1):
            for name, rx in compiled.items():
                if rx.search(line):
                    rel = path.relative_to(root)
                    hits.append(f"{rel}:{lineno}: [{name}] {line.strip()[:140]}")

    print(f"scanned {scanned} files under {root} against {len(compiled)} patterns "
          f"({sum(1 for n in rules if n in PRIVATE)} private, {sum(1 for n in rules if n in GENERIC)} generic)")
    if hits:
        print(f"\n{len(hits)} hit(s):")
        for h in hits:
            print(" ", h)
        return 1
    print("clean: no private values or credential shapes found")
    return 0


if __name__ == "__main__":
    sys.exit(main())
