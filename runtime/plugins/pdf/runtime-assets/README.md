# MuPDF Runtime Asset

`mupdf-1.27.2.lock.json` freezes the official MuPDF 1.27.2 source bytes, the minimal PDF-only feature policy, every statically compiled third-party component, and exact platform build environments.

MuPDF does not publish the PGP release-signing workflow used by FFmpeg. The lock therefore records the exact size and SHA-256 obtained from the official HTTPS source and does not claim upstream signature authentication.

The asset is AGPL and includes the complete corresponding source archive, compiled-component licenses, SBOM, and build provenance. Optional MuJS, HTML/EPUB, Brotli, XPS, SVG, DOCX export, OCR, barcode, archive, GUI, network, and crypto-signing features are disabled.

```bash
python build_linux_arm64.py \
  --source /path/to/mupdf-1.27.2-source.tar.gz \
  --output /path/to/org.mupdf.runtime.shejane-runtime-asset
```

The Linux builder verifies the pinned Debian OCI image and package closure, builds twice offline, compares both executables, checks the final ELF/`DT_NEEDED` closure, and emits deterministic source, license, SBOM, and provenance bytes. Build a second asset archive and compare both archives plus their canonical installed digest with `verify_release.py`.

The current `linux/arm64` result is recorded in `docs/plugins/phase6-pdf-research.md`; it is not a cross-platform release declaration. Linux amd64 and Windows need native builders and the same source, component, license, sandbox, hostile-input, and golden Gates before they are advertised. The older Darwin builder remains only as research evidence because macOS Managed Workers execute Linux/arm64 guests.
