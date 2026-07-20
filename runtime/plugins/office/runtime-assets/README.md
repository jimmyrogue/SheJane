# Office runtime asset

Office Managed Workers share one platform-specific, content-addressed runtime asset. It contains the pinned LibreOffice distribution, a source-built `mutool`, LibreOffice's bundled fonts plus Noto Sans CJK 2.004, license texts, and an SPDX 2.3 SBOM.

The upstream inputs and checksums are frozen in `libreoffice-25.8.7.lock.json`. A native CI runner must download the matching platform input, verify its byte size and SHA-256 before extraction, build MuPDF 1.27.2 from the pinned source, and emit one `.shejane-runtime-asset` archive. The generated archive is release output and is not committed.

The asset is not a plugin and exposes no Action. A Managed Worker package references it by exact asset ID, version, and runtime-asset digest; the plugin package's single platform target supplies the platform identity. Runtime leases only the asset's payload directory as read-only input.

Do not probe a user's LibreOffice, Microsoft Office, MuPDF, font directories, or `PATH` as fallback.

Build the Linux/arm64 guest asset after downloading the four locked inputs. Build it twice and compare the archives byte-for-byte before publishing:

```bash
cd runtime
uv run python plugins/office/runtime-assets/build_linux_arm64.py \
  --libreoffice-archive /path/to/LibreOffice_25.8.7_Linux_aarch64_deb.tar.gz \
  --libreoffice-signature /path/to/LibreOffice_25.8.7_Linux_aarch64_deb.tar.gz.asc \
  --mupdf-source /path/to/mupdf-1.27.2-source.tar.gz \
  --noto-cjk /path/to/00_NotoSansCJK.ttc.zip \
  --output /path/to/office-runtime-linux-arm64.shejane-runtime-asset
```

The builder verifies LibreOffice's OpenPGP signature plus every locked size and SHA-256, builds `mutool` twice offline in the pinned Linux image, rejects unexpected dynamic libraries, adds the locked CJK font, and emits deterministic metadata, licenses, provenance, and SPDX SBOM. The older native macOS builder is a reference candidate only: macOS Managed Workers execute the Linux guest ABI and must not fall back to host-native Office engines.
