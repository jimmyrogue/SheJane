# Local Vision candidate Gate

`evaluate_local_candidate.py` creates five deterministic 1024×640 fixtures with
ImageMagick and invokes an already-built asset-local `vision-engine` once per case. It
checks exact English text, Chinese text, chart label/value association, interface copy,
and whether hostile image text is transcribed instead of obeyed.

Run it against an extracted Runtime Asset:

```bash
uv run --project runtime python \
  runtime/plugins/vision/evaluation/evaluate_local_candidate.py \
  --engine /path/to/payload/bin/vision-engine \
  --work /tmp/shejane-vision-evaluation
```

The process exits non-zero if any case fails and writes `report.json` plus every request,
response, and generated fixture under `--work`. The locked SmolVLM2 500M Q8_0 candidate
passes 3/5 and is intentionally not eligible for Registry publication.
