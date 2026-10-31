#!/usr/bin/env python3
"""Apply a pinned private store configuration before building release artifacts."""

import json
import os
from pathlib import Path
import shutil
import sys

root = Path(__file__).resolve().parents[1]
config = Path(sys.argv[1]).resolve()
branding = json.loads((config / "branding.json").read_text())
env = json.loads((config / "build-env.json").read_text())

# Only application source is transformed. Public docs and workflow definitions stay public.
for directory in ["pindou-miniapp/src", "pindou-miniapp/scripts", "pindou-miniapp/tests", "pindou-admin/src", "pindou-admin/e2e", "pindou-backend"]:
    for file in (root / directory).rglob("*"):
        if not file.is_file() or file.suffix not in {".ts", ".tsx", ".scss", ".mjs", ".go", ".json", ".html"}:
            continue
        if "dist" in file.parts or "bin" in file.parts:
            continue
        text = file.read_text()
        for placeholder, value in branding.items():
            text = text.replace(placeholder, value)
        file.write_text(text)

for file in (config / "files").rglob("*"):
    if not file.is_file():
        continue
    relative = file.relative_to(config / "files")
    destination = (root / relative).resolve()
    if not destination.is_relative_to(root) or ".git" in relative.parts:
        raise ValueError(f"apply-store-config: forbidden destination {relative}")
    destination.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(file, destination)

# Taro loads local env files for local builds; Actions uses GITHUB_ENV for subsequent steps.
for key, value in env.items():
    if not key.replace("_", "").isalnum() or not isinstance(value, str) or "\n" in value or "\r" in value:
        raise ValueError(f"apply-store-config: invalid environment entry {key}")
env_text = "".join(f"{key}={value}\n" for key, value in env.items())
(root / "pindou-miniapp/.env.production.local").write_text(env_text)
if os.environ.get("GITHUB_ENV"):
    with open(os.environ["GITHUB_ENV"], "a") as output:
        output.write(env_text)
print("Private store configuration applied; values are not logged.")
