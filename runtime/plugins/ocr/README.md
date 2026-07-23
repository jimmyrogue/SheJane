# OCR plugin

The OCR plugin recognizes text in an ordered batch of explicitly selected images.
It uses only the exact `org.rapidocr.runtime` asset declared in its installed
manifest: RapidOCR 3.9.1, PP-OCRv6 medium detection/recognition models, ONNX Runtime,
and the CPU execution provider.

The plugin does not download models, switch providers, call a vision model, or fall
back to platform OCR. PDF OCR is an explicit composition: render selected pages with
the PDF plugin, then pass those same-Run PNG Artifact IDs to this plugin.

`build_package.py` creates a deterministic platform-specific `.shejane-plugin`
archive from a PyInstaller onedir Worker and an exact Runtime Asset digest. The
SheJane-maintained package is executed by the fixed OCR host adapter; arbitrary
third-party packages cannot select that adapter. This keeps the general Managed
Worker release gate closed while allowing the trusted, native macOS OCR capability.
