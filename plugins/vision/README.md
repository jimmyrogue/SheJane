# Vision reference plugin

This directory contains one `vision.analyze_images` contract packaged as two explicit Managed Worker backends:

- `local` requires one exact `org.llama-mtmd.runtime` Runtime Asset and has no network/model-provider capability;
- `cloud` has no model asset and may issue one bounded `model.vision.invoke` request through the Runtime-owned provider adapter.

They intentionally use different stable plugin IDs so installing the cloud backend never downloads a local model and installing the local backend never creates remote-processing authority. Both return the same output schema. Neither backend falls back to the current chat model or to the other plugin.

The cloud backend now has a reproducible Linux/arm64 PyInstaller onedir Worker and
deterministic package. It passes the production VM host-call bridge with a fake provider;
the Runtime provider adapter separately validates authorized images, credentials,
concrete model identity, limits, and normalized usage. It remains unpublished until the
real signed/notarized release workflow passes.

`runtime-assets/` contains a reproducible Darwin arm64 spike for the local backend. It
freezes `llama.cpp` `b10025`, `libmtmd`, and the official SmolVLM2 500M Q8_0 model plus
projector; builds a dedicated JSON-only, CPU, single-threaded `vision-engine`; and rejects
undeclared dynamic libraries. Two clean builds produced the identical 557,970,221-byte
asset (`sha256:1e0e1c1cb30aa4972d8c4aff56e54452a5ab3dccd0d68951af21d449c022b4b0`).

That model is **not a product-approved local Vision model**. The reproducible evaluation
under `evaluation/` passed exact English text, a simple destructive-action dialog, and
hostile-image text handling, but failed Chinese text and reversed chart values. A manual
brand-image smoke test also hallucinated visible text and semantics. The package is kept
as a conformance candidate and must not be added to the production Registry.
