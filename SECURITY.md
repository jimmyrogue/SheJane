# Security Policy

## Reporting a vulnerability

**Please do not open a public GitHub issue for security vulnerabilities.**

Instead, report privately via GitHub's
[Report a vulnerability](https://github.com/jimmyrogue/SheJane/security/advisories/new)
(Security → Advisories) so we can triage and fix before disclosure.

Please include:

- A description of the issue and its impact.
- Steps to reproduce (a proof-of-concept if you have one).
- Affected component (Runtime, Client, or Runtime SDK) and version/commit.

We aim to acknowledge reports within a few business days and will keep
you updated on remediation. Coordinated disclosure is appreciated — we
will credit reporters who want it.

## Scope & sensitive areas

This project handles credentials and local tool execution. Findings in these areas are
especially valued:

- **Secret boundaries**: Runtime BYOK keys must stay in the operating-system
  credential store and must not reach task records or Client storage.
- **Tool permissions**: risky local operations must pause for an explicit,
  correctly scoped user decision.
- **Workspace boundaries**: file and Office tools must stay within the
  authorized workspace, including symlink and path traversal cases.
- **Outbound requests**: web tools must block credentials, loopback/private
  targets, unsafe redirects, and DNS rebinding.
- **Runtime pairing**: local HTTP endpoints must enforce loopback access and
  the current pairing token.

## What is not a vulnerability

- Issues that require a malicious local process already running as the
  user and already possessing the Runtime pairing token.
- Missing rate limits on local-only endpoints.
- Anything reproducible only with secrets the reporter supplied themselves.

## Supported versions

This is pre-1.0 software under active development. Security fixes land on
`main`; there are no backported release branches yet.
