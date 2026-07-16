# PDF plugin

This Managed Worker plugin uses only an exact `org.mupdf.runtime` asset. It provides bounded PDF inspection, page-window text extraction, and selected-page PNG rendering without host tool discovery, implicit OCR, arbitrary MuPDF options, or model fallback.

The reproducible `linux/arm64` Runtime Asset and frozen onedir Worker pass real macOS-arm64 VM coverage for Unicode and blank-page semantics, exact selected-page PNG goldens, hostile/truncated input, cancellation cleanup, and replay after cancellation. The package remains Registry-disabled until those checks pass in the signed/notarized packaged-app release job. Additional native assets and Gates are still required before other host/guest platform pairs are advertised.
