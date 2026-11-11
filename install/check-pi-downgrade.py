#!/usr/bin/env python3
"""Fail closed before replacing newer or unclassifiable Pi and LSP runtimes."""
import json
import os
from pathlib import Path
import re
import stat
import sys

SEMVER = re.compile(r"^(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$")


def classify(value):
    match = SEMVER.fullmatch(value) if isinstance(value, str) else None
    if not match:
        raise ValueError("Existing Pi version cannot be safely classified")
    if match.group(4) and any(part.isdigit() and len(part) > 1 and part.startswith("0") for part in match.group(4).split(".")):
        raise ValueError("Existing Pi version cannot be safely classified")
    numbers = tuple(int(match.group(i)) for i in range(1, 4))
    return numbers, bool(match.group(4))


def metadata(package, required):
    parts = [*reversed(package.parents), package]
    for index, part in enumerate(parts):
        try:
            info = os.lstat(part)
        except FileNotFoundError:
            if required:
                raise ValueError("Existing Pi version cannot be safely classified")
            return None
        if stat.S_ISLNK(info.st_mode):
            raise ValueError("Refusing a link in the existing Pi installation path")
        if index < len(parts) - 1 and not stat.S_ISDIR(info.st_mode):
            raise ValueError("Existing Pi installation path is invalid")
    if not stat.S_ISREG(info.st_mode) or info.st_size > 1024 * 1024:
        raise ValueError("Existing Pi metadata is not a bounded regular file")
    with package.open("r", encoding="utf-8") as stream:
        metadata = json.load(stream)
    if not isinstance(metadata, dict):
        raise ValueError("Existing Pi metadata cannot be safely classified")
    return metadata


def reject_newer(value, pinned, label):
    numbers, prerelease = classify(value)
    target, _ = classify(pinned)
    if numbers > target:
        raise ValueError(f"Existing {label} is newer than {pinned}; refusing to downgrade")
    return numbers, prerelease


def check(runtime_root, pinned):
    if pinned != "1.5.1":
        raise ValueError("Unexpected Pi installer pin")
    runtime_root = Path(os.path.abspath(runtime_root))
    has_runtime = any(os.path.lexists(runtime_root / name) for name in ("node_modules", "package.json", "package-lock.json"))
    if not has_runtime:
        # Still reject a link or malformed ancestor even for an empty target.
        metadata(runtime_root / "node_modules" / "__missing__", False)
        return
    package = metadata(runtime_root / "node_modules" / "@earendil-works" / "pi-coding-agent" / "package.json", True)
    pi_version, _ = reject_newer(package.get("version"), pinned, "Pi")
    root = metadata(runtime_root / "package.json", False)
    lock = metadata(runtime_root / "package-lock.json", False)
    lsp_declared = False
    managed = {"@earendil-works/pi-coding-agent", "pi-lsp-extension", "pyright", "typescript-language-server", "typescript", "typescript-lsp", "vscode-languageserver-protocol"}
    if root is not None and set(root) - {"name", "version", "private", "dependencies"}:
        raise ValueError("Existing Pi has custom package fields; preserve them and reconcile before reinstalling")
    packages = None if lock is None else lock.get("packages")
    if lock is not None and (not isinstance(packages, dict) or not isinstance(packages.get(""), dict)):
        raise ValueError("Existing Pi lock cannot be safely classified")
    for source in (root, None if packages is None else packages.get("")):
        if source is None:
            continue
        dependencies = source.get("dependencies") if isinstance(source, dict) else None
        if not isinstance(dependencies, dict):
            raise ValueError("Existing Pi dependencies cannot be safely classified")
        if set(dependencies) - managed:
            raise ValueError("Existing Pi has custom dependencies; preserve them and reconcile before reinstalling")
        if "@earendil-works/pi-coding-agent" in dependencies:
            reject_newer(dependencies["@earendil-works/pi-coding-agent"], pinned, "Pi")
        if "pi-lsp-extension" in dependencies:
            lsp_declared = True
            reject_newer(dependencies["pi-lsp-extension"], "1.4.0", "LSP")
    if lock is not None:
        for name, version, label in (("@earendil-works/pi-coding-agent", pinned, "Pi"), ("pi-lsp-extension", "1.4.0", "LSP")):
            entry = packages.get("node_modules/" + name)
            if entry is not None:
                if not isinstance(entry, dict):
                    raise ValueError("Existing Pi lock cannot be safely classified")
                reject_newer(entry.get("version"), version, label)
    lsp = metadata(runtime_root / "node_modules" / "pi-lsp-extension" / "package.json", lsp_declared or pi_version >= (1, 5, 1))
    if lsp is not None:
        reject_newer(lsp.get("version"), "1.4.0", "LSP")
        if root is not None and not lsp_declared:
            raise ValueError("Existing LSP metadata is incomplete; preserve it and reconcile before reinstalling")


if __name__ == "__main__":
    try:
        if len(sys.argv) != 3:
            raise ValueError("Expected Pi runtime root and pinned version")
        check(sys.argv[1], sys.argv[2])
    except (OSError, ValueError, TypeError, json.JSONDecodeError) as exc:
        print(str(exc), file=sys.stderr)
        sys.exit(1)
