# Archive WASI fixture

This fixture is a real `wasm32-wasip2` Component used by the Runtime contract tests. It receives invocation JSON plus one authorized ZIP byte buffer and returns bounded candidate Artifact bytes. The Host does not expose WASIp2 filesystem, network, clock, environment, or real-random capabilities.

Rebuild after changing Rust or WIT source:

```bash
rustup target add wasm32-wasip2
cd payload/archive-component
cargo build --release --target wasm32-wasip2
cp target/wasm32-wasip2/release/shejane_archive_fixture.wasm ../archive.wasm
```

Run the public-boundary check from `runtime`:

```bash
uv run python -m pytest tests/test_wasi_spike.py -q
```
