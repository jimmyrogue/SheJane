# Runtime Asset v1

A Runtime Asset is a content-addressed, platform-specific byte bundle shared by Managed Worker plugins. It solves one narrow problem: large deterministic engines such as LibreOffice and MuPDF should not be duplicated in Documents, Spreadsheets, and Presentations packages.

It is not a third plugin type. It has no Actions, commands, skills, UI, hooks, network behavior, dependency graph, or direct execution path.

## Archive and identity

The archive suffix is `.shejane-runtime-asset`. It is a canonical ZIP with this minimum layout:

```text
office-runtime/
├── .shejane-runtime-asset/
│   ├── asset.json
│   └── sbom.spdx.json
└── payload/
    ├── office-runtime.json
    └── ...
```

`asset.json` contains exactly:

```json
{
  "schema_version": 1,
  "id": "org.libreoffice.runtime",
  "version": "25.8.7",
  "platform": "darwin/arm64",
  "license": "MPL-2.0",
  "source_url": "https://www.libreoffice.org/",
  "payload": "payload",
  "sbom": ".shejane-runtime-asset/sbom.spdx.json",
  "executables": ["payload/LibreOffice.app/Contents/MacOS/soffice", "payload/bin/mutool"]
}
```

The canonical digest uses the same safe tree framing as plugin packages with a distinct `shejane-runtime-asset-v1\0` domain and an entry-kind byte. Directories hash as `D`, regular files as `F + bytes`, and internal relative symbolic links as `L + UTF-8 target`. Links are created only after regular extraction and every final target must resolve inside the same Asset root. Absolute, broken, cyclic, or escaping links fail closed. Plugin packages continue to prohibit all links. Archive traversal, special files, path collisions, invalid manifests, wrong platforms, missing SBOMs, oversized archives, and digest mismatches fail before installation.

Runtime Asset v1 accepts at most a 768 MiB compressed archive, a 2 GiB extracted tree, and 50,000 entries. This larger archive ceiling applies only to separately verified Runtime Assets so one reviewed local model such as Speech can fit; it does not increase the ordinary plugin package ceiling.

## Installation and use

Runtime installs the verified tree under its digest. Installing the same digest is idempotent and re-verifies the existing bytes. Declared executables are normalized to owner read/execute only; the asset itself never chooses what to run.

A Managed Worker manifest references exact `id + version + digest`; its one package platform must match the asset platform. P6 resolves and verifies every reference before leasing it. P10 exposes only each payload root as read-only sandbox input and sends the exact identities in the Worker handshake. There is no host `PATH`, LibreOffice, Microsoft Office, font, or engine fallback.

## Lifecycle

Runtime Assets remain content-addressed after plugin retirement because an active or recoverable Run may still hold an exact plugin binding. They are physically reclaimed only by the same future reference-aware garbage collector that reclaims retired plugin blobs. v1 intentionally has no independent user-facing remove command: an asset cannot execute or be selected by itself, and independent deletion would break reproducibility.

The first consumer is the shared Office runtime locked in [`plugins/office/runtime-assets`](../../plugins/office/runtime-assets).
