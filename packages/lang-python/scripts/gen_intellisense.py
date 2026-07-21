#!/usr/bin/env python3
"""Derive the Python IntelliSense block of nano-ide.ext.json from the Camunda
Python SDK itself.

The SDK (``camunda-orchestration-sdk``) is strongly typed and self-documenting,
so we do NOT hand-author completions/hovers/signatures. This script imports the
SDK and introspects the client + the model classes a worker/app author types
directly (``inspect.signature`` for methods, ``__annotations__`` +
Google-style ``Attributes:`` docstrings for dataclass fields), then writes the
manifest's ``intellisense`` array.

The console's pack-fed completion provider is a flat, global list (no in-browser
Python language server to scope member completions to a receiver type), so we
surface the client's public methods and the entry-point model classes' fields —
the surface an author actually reaches for.

Usage:  python3 scripts/gen_intellisense.py [--check]
  --check  exit non-zero if the manifest is stale (for CI); no write.

Requires the SDK importable in the active interpreter (``pip install
camunda-orchestration-sdk`` or run inside the template's ``uv`` env).
"""

from __future__ import annotations

import inspect
import json
import re
import sys
from pathlib import Path

PACK_ROOT = Path(__file__).resolve().parent.parent
MANIFEST = PACK_ROOT / "nano-ide.ext.json"

# Classes whose PUBLIC METHODS are surfaced (the client API surface).
CLIENT_CLASSES = ["CamundaAsyncClient", "CamundaClient"]

# Classes whose FIELDS (constructor kwargs) are surfaced — the config/instruction
# objects an author fills in.
MODEL_CLASSES = [
    "WorkerConfig",
    "ProcessCreationById",
    "ProcessCreationByKey",
    "ConnectedJobContext",
    "JobContext",
]

# Bare names to surface as type completions (NewType aliases / simple types).
TYPE_NAMES = [
    "ProcessDefinitionId",
    "ProcessDefinitionKey",
    "ProcessInstanceCreationInstructionByIdVariables",
]

# Client plumbing authors never call directly.
SKIP_METHODS = {"aclose", "close"}


def load_sdk():
    try:
        import camunda_orchestration_sdk as sdk  # type: ignore
    except Exception as exc:  # pragma: no cover - environment dependent
        sys.exit(
            "gen_intellisense: cannot import camunda_orchestration_sdk "
            f"({exc}). Install it (pip install camunda-orchestration-sdk) or run "
            "inside the template's uv environment."
        )
    return sdk


def first_para(doc: str | None) -> str:
    if not doc:
        return ""
    out: list[str] = []
    for line in doc.strip().splitlines():
        if not line.strip():
            if out:
                break
            continue
        out.append(line.strip())
    return " ".join(out).strip()


def parse_attributes(doc: str | None) -> dict[str, str]:
    """Parse a Google-style ``Attributes:`` block into {field: description}."""
    if not doc:
        return {}
    lines = doc.splitlines()
    try:
        start = next(
            i for i, ln in enumerate(lines) if ln.strip().rstrip(":") == "Attributes"
        )
    except StopIteration:
        return {}
    fields: dict[str, str] = {}
    cur: str | None = None
    buf: list[str] = []
    entry = re.compile(r"^\s{2,}(\w+)\s*(?:\([^)]*\))?\s*:\s*(.*)$")
    for ln in lines[start + 1 :]:
        if not ln.strip():
            continue
        m = entry.match(ln)
        if m and (len(ln) - len(ln.lstrip())) <= 8:
            if cur:
                fields[cur] = " ".join(buf).strip()
            cur, buf = m.group(1), [m.group(2)]
        elif cur:
            buf.append(ln.strip())
    if cur:
        fields[cur] = " ".join(buf).strip()
    return fields


def simplify_annotation(ann: object) -> str:
    s = ann if isinstance(ann, str) else getattr(ann, "__name__", str(ann))
    s = re.sub(r"[\w\.]+\.(\w+)", r"\1", s)  # strip module qualifiers
    s = s.replace("NoneType", "None")
    return s.strip()


def format_signature(func) -> tuple[str, list[tuple[str, str]], list[str]]:
    """Return (param_string, [(label, name)], placeholder_names)."""
    try:
        sig = inspect.signature(func)
    except (TypeError, ValueError):
        return "", [], []
    labels: list[tuple[str, str]] = []
    placeholders: list[str] = []
    parts: list[str] = []
    for name, p in sig.parameters.items():
        if name == "self":
            continue
        if p.kind in (inspect.Parameter.VAR_KEYWORD, inspect.Parameter.VAR_POSITIONAL):
            continue
        ann = ""
        if p.annotation is not inspect.Parameter.empty:
            ann = simplify_annotation(p.annotation)
        label = f"{name}: {ann}" if ann else name
        if p.default is not inspect.Parameter.empty:
            label += " = ..."
        else:
            placeholders.append(name)
        parts.append(label)
        labels.append((label, name))
    return ", ".join(parts), labels, placeholders


def build(sdk) -> dict:
    completions: list[dict] = []
    signatures: list[dict] = []
    hovers: dict[str, str] = {}
    seen: set[tuple[str, str]] = set()

    def add_completion(item: dict) -> None:
        key = (item["kind"], item["label"])
        if key in seen:
            return
        seen.add(key)
        completions.append(item)

    def add_hover(symbol: str, contents: str) -> None:
        if not symbol or not contents:
            return
        prev = hovers.get(symbol)
        if prev and contents in prev:
            return
        hovers[symbol] = f"{prev}\n\n---\n\n{contents}" if prev else contents

    # Client method surfaces.
    for cls_name in CLIENT_CLASSES:
        cls = getattr(sdk, cls_name, None)
        if cls is None:
            continue
        doc = first_para(inspect.getdoc(cls))
        add_completion(
            {"label": cls_name, "kind": "class", "detail": "camunda_orchestration_sdk",
             "documentation": doc or None}
        )
        if doc:
            add_hover(cls_name, f"**`class {cls_name}`** — camunda_orchestration_sdk\n\n{doc}")
        for name, func in inspect.getmembers(cls, inspect.isfunction):
            if name.startswith("_") or name in SKIP_METHODS:
                continue
            params, labels, placeholders = format_signature(func)
            is_async = inspect.iscoroutinefunction(func)
            mdoc = first_para(inspect.getdoc(func))
            snippet_args = ", ".join(
                f"${{{i + 1}:{n}}}" for i, n in enumerate(placeholders)
            )
            sig_label = f"{name}({params})"
            add_completion(
                {
                    "label": name,
                    "kind": "method",
                    "insertText": f"{name}({snippet_args})",
                    "snippet": True,
                    "detail": sig_label,
                    "documentation": mdoc or None,
                }
            )
            prefix = "await " if is_async else ""
            add_hover(
                name,
                f"**`{prefix}{cls_name}.{sig_label}`**" + (f"\n\n{mdoc}" if mdoc else ""),
            )
            if labels:
                signatures.append(
                    {
                        "trigger": name,
                        "label": sig_label,
                        "documentation": mdoc or None,
                        "parameters": [{"label": lbl} for lbl, _ in labels],
                    }
                )

    # Model field surfaces.
    for cls_name in MODEL_CLASSES:
        cls = getattr(sdk, cls_name, None)
        if cls is None:
            continue
        cdoc = first_para(inspect.getdoc(cls))
        add_completion(
            {"label": cls_name, "kind": "class", "detail": "camunda_orchestration_sdk",
             "documentation": cdoc or None}
        )
        if cdoc:
            add_hover(cls_name, f"**`class {cls_name}`** — camunda_orchestration_sdk\n\n{cdoc}")
        field_docs = parse_attributes(inspect.getdoc(cls))
        anns = getattr(cls, "__annotations__", {})
        for fname, ann in anns.items():
            if fname.startswith("_") or fname == "additional_properties":
                continue
            ftype = simplify_annotation(ann)
            fdoc = field_docs.get(fname, "")
            add_completion(
                {
                    "label": fname,
                    "kind": "field",
                    "detail": f"{cls_name}.{fname}: {ftype}" if ftype else f"{cls_name}.{fname}",
                    "documentation": fdoc or None,
                }
            )
            add_hover(
                fname,
                f"**`{cls_name}.{fname}`**"
                + (f" — `{ftype}`" if ftype else "")
                + (f"\n\n{fdoc}" if fdoc else ""),
            )

    # Simple type / alias surfaces.
    for tname in TYPE_NAMES:
        obj = getattr(sdk, tname, None)
        if obj is None:
            continue
        supert = getattr(obj, "__supertype__", None)
        detail = (
            f"type alias over {simplify_annotation(supert)}" if supert is not None else "camunda_orchestration_sdk"
        )
        add_completion({"label": tname, "kind": "class", "detail": detail})
        add_hover(tname, f"**`{tname}`** — {detail}")

    # Prune None-valued optional keys for a tight manifest.
    def prune(d: dict) -> dict:
        return {k: v for k, v in d.items() if v is not None}

    completions = [prune(c) for c in completions]
    signatures = [prune(s) for s in signatures]

    completions.sort(key=lambda c: (c["label"].lower(), c["kind"]))
    signatures.sort(key=lambda s: (s["trigger"].lower(), s["label"]))
    hover_list = sorted(
        ({"symbol": k, "contents": v} for k, v in hovers.items()),
        key=lambda h: h["symbol"].lower(),
    )

    return {
        "monacoLang": "python",
        "triggerCharacters": ["."],
        "completions": completions,
        "hovers": hover_list,
        "signatures": signatures,
    }


def main() -> None:
    check = "--check" in sys.argv
    sdk = load_sdk()
    block = build(sdk)

    manifest = json.loads(MANIFEST.read_text())
    manifest["intellisense"] = [block]
    out = json.dumps(manifest, indent=2, ensure_ascii=False) + "\n"

    if check:
        if MANIFEST.read_text() != out:
            sys.exit(
                "gen_intellisense: nano-ide.ext.json intellisense is stale. "
                "Run 'npm run gen:intellisense' and commit."
            )
        print(f"gen_intellisense: up to date ({len(block['completions'])} completions).")
        return

    MANIFEST.write_text(out)
    print(
        f"gen_intellisense: wrote {len(block['completions'])} completions, "
        f"{len(block['hovers'])} hovers, {len(block['signatures'])} signatures."
    )


if __name__ == "__main__":
    main()
