# Security Policy

## Reporting a vulnerability

**Please do not open a public GitHub issue for security vulnerabilities.**

Instead, report privately via GitHub's
[Report a vulnerability](https://github.com/jimmyrogue/SheJane/security/advisories/new)
(Security → Advisories) so we can triage and fix before disclosure.

Please include:

- A description of the issue and its impact.
- Steps to reproduce (a proof-of-concept if you have one).
- Affected component (Runtime, Desktop, optional Cloud, Admin, or Runtime SDK) and version/commit.

We aim to acknowledge reports within a few business days and will keep
you updated on remediation. Coordinated disclosure is appreciated — we
will credit reporters who want it.

## Scope & sensitive areas

This project handles credentials and money. Findings in these areas are
especially valued:

- **Auth**: JWT issuance/validation, refresh-token handling, the
  `ADMIN_EMAILS` promotion path, disabled-user enforcement.
- **Billing**: the credit ledger (reserve → settle → release), Stripe
  webhook idempotency, the cloud Tool Gateway's per-call billing.
- **Secret boundaries**: Runtime BYOK keys must stay in the operating-system
  credential store; optional Cloud keys must not reach Runtime or Desktop.
- **Tool sandbox**: code execution runs in E2B microVMs; file uploads
  are screened by a sensitive-pattern blacklist before leaving the
  machine.
- **Document storage**: S3 presigned URLs, per-user ownership checks,
  expiry/TTL enforcement.

## What is not a vulnerability

- Issues that require a malicious local process already running as the
  user and already possessing the Runtime pairing token.
- Missing rate limits on local-only endpoints.
- Anything reproducible only with secrets the reporter supplied themselves.

## Supported versions

This is pre-1.0 software under active development. Security fixes land on
`main`; there are no backported release branches yet.
