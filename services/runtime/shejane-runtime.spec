# -*- mode: python ; coding: utf-8 -*-
# PyInstaller spec for the SheJane Runtime.
#
# Produces a self-contained ONEDIR bundle (dist/shejane-runtime/) that runs WITHOUT a
# system Python — it's what the Electron desktop app spawns. Build it with
# `make build-daemon` (= `uv run pyinstaller shejane-runtime.spec`).
#
# onedir (not onefile) on purpose: onefile re-extracts to a temp dir on every
# launch (slow + AV re-scan) and breaks uvicorn's signal handling; onedir starts
# fast and lets each inner binary be code-signed individually (needed for macOS
# notarization in a later phase).

from pathlib import Path
import sys

from PyInstaller.utils.hooks import collect_all, collect_submodules

datas = []
binaries = []
hiddenimports = []

if sys.platform.startswith("linux"):
    linux_launcher = Path("build/managed-worker-linux/shejane-managed-worker-linux")
    linux_bubblewrap = Path("build/managed-worker-linux/bubblewrap")
    if not linux_launcher.is_file():
        raise SystemExit("Linux Managed Worker launcher must be built before PyInstaller")
    if not (linux_bubblewrap / "shejane-bwrap").is_file():
        raise SystemExit("Linux Managed Worker bubblewrap must be built before PyInstaller")
    binaries.append((str(linux_launcher), "."))
    binaries += [
        (str(linux_bubblewrap / "shejane-bwrap"), "managed-worker-linux"),
        (str(linux_bubblewrap / "libcap.so.2"), "managed-worker-linux"),
    ]
    datas += [
        (str(linux_bubblewrap / name), "managed-worker-linux")
        for name in ("COPYING.bubblewrap", "copyright.libcap", "manifest.json")
    ]

# Packages PyInstaller's static analysis under-collects because they rely on
# dynamic imports, entry-point discovery, or ship data files / native libs.
# onnxruntime + magika are the critical ones: markitdown builds a module-level
# MarkItDown() (office tools) which loads magika's ONNX model via onnxruntime AT
# IMPORT TIME — miss their data/binaries and the frozen daemon crashes on launch.
for pkg in (
    "onnxruntime",
    "magika",
    "langgraph",
    "langchain",
    "langchain_core",
    "deepagents",
    "markitdown",
    # wasmtime resolves its platform library with ctypes at import time, so
    # PyInstaller cannot discover the wheel's nested dylib/DLL from imports.
    "wasmtime",
):
    d, b, h = collect_all(pkg)
    datas += d
    binaries += b
    hiddenimports += h

# The daemon boots via uvicorn.run("local_host.server:app", ...) — a STRING
# import — so the whole local_host package is invisible to static analysis.
hiddenimports += collect_submodules("local_host")
datas += [
    (str(path), "local_host/agent/prompts")
    for path in Path("local_host/agent/prompts").glob("*.md")
]
# uvicorn loads its loop / protocol / lifespan implementations dynamically.
hiddenimports += collect_submodules("uvicorn")

a = Analysis(
    ["pyi_entry.py"],
    pathex=["."],
    binaries=binaries,
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    runtime_hooks=[],
    # The agentic-browser feature is optional + stubbed (see pyproject
    # [project.optional-dependencies].browser); never bundle it in the desktop
    # build even if a dev froze from an env that has it installed.
    excludes=["browser_use", "playwright"],
    noarchive=False,
)

pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,  # onedir: deps live beside the exe, not inside it
    name="shejane-runtime",
    console=True,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,  # native arch of the build machine (per-OS/arch in CI)
)

coll = COLLECT(
    exe,
    a.binaries,
    a.datas,
    name="shejane-runtime",  # → dist/shejane-runtime/
)
