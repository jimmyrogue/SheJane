# Plugin Source Index v1

> Status: implemented end to end for explicit source add, manual refresh, discovery, exact package install, and removal. Background refresh and automatic updates are intentionally unsupported.

A plugin source is two static HTTPS files:

- `index.json`: an immutable-version package catalog;
- `index.sig.json`: an Ed25519 signature over the exact `index.json` bytes.

The user configures the index URL and source public key together. The index cannot introduce or replace its own trusted key. A source is only a discovery mechanism: installation still verifies the downloaded package digest, the package publisher signature, Runtime compatibility, capabilities, and the platform isolation Gate.

## Index

```json
{
  "schema_version": 1,
  "source": {
    "id": "dev.example.plugins",
    "name": "Example plugins"
  },
  "packages": [
    {
      "plugin_id": "dev.example.archive",
      "version": "1.0.0",
      "name": "Archive",
      "publisher_id": "dev.example",
      "runtime_min_version": "0.1.0",
      "execution_kind": "wasi",
      "platform": "any",
      "package_url": "https://plugins.example.dev/archive-1.0.0.shejane-plugin",
      "package_size_bytes": 20480,
      "package_digest": "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      "signer_key_id": "ed25519:sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      "capabilities": ["artifact.write", "input.read"],
      "consumes": ["application/zip"],
      "produces": ["application/octet-stream"],
      "release_notes": "Initial release."
    }
  ]
}
```

Rules:

- Unknown fields are rejected.
- `source.id`, `plugin_id`, and `publisher_id` use the same stable ID grammar as plugin manifests.
- A package target is unique by plugin ID, version, execution kind, and platform.
- WASI packages use `platform: "any"`; Managed Worker packages use one concrete supported OS/architecture.
- Package URLs must use HTTPS. Local development uses the existing local-file installation path instead of weakening source transport.
- Capabilities and MIME lists are display/search summaries. The downloaded manifest remains authoritative and must agree before installation.
- The package digest is the canonical SheJane package digest, not the ZIP file SHA-256.
- `signer_key_id` identifies the publisher key expected inside the package signature. Trust in that publisher key remains deployment-owned.
- v1 sources are read-only and manually refreshed. They cannot request automatic installation or background updates.

## Detached source signature

```json
{
  "schema_version": 1,
  "algorithm": "ed25519",
  "key_id": "ed25519:sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  "index_sha256": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  "signature": "BASE64_ED25519_SIGNATURE"
}
```

The verifier computes:

```text
index_sha256 = lowercase_hex(SHA-256(exact index.json bytes))
key_id = "ed25519:sha256:" + lowercase_hex(SHA-256(raw 32-byte public key))
message = UTF-8("shejane-plugin-source-v1\0") + UTF-8(index_sha256)
signature = Ed25519.sign(source_private_key, message)
```

Reformatting `index.json` changes its signed bytes and therefore requires a new signature. The signature proves which configured source produced the index; it does not make packages trusted.

## Refresh and failure semantics

The Runtime source controller:

1. download both files with strict size and timeout limits;
2. verify them before replacing the last-known-good index;
3. downloads packages to private staging and checks exact archive size and canonical digest;
4. require the package publisher signature to match `publisher_id` and `signer_key_id`;
5. submits `plugin.source.install` through the existing idempotent Runtime Command path;
6. leave installed packages and the last-known-good index untouched when refresh fails.

Source refresh must never enable a plugin, update an installed version, or change a frozen Run binding by itself.

Runtime stores only the last index that passed all source checks. Adding, refreshing, installing from, and removing a source use the normal Runtime Command receipt log. The Plugin Tab takes the source public key separately from the two HTTPS URLs, shows packages from the stored index, and installs or explicitly updates to one exact `(plugin_id, version, execution_kind, platform, package_digest, source_revision)` selection. Updating also carries the active plugin digest observed by the UI and fails on a concurrent change. Removing a source does not remove already installed content-addressed plugin bytes.
