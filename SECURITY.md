# Security Policy

This package sits in an authentication path — a vulnerability here can affect
every application that uses it. Please report security issues responsibly.

## Reporting a vulnerability

**Do not open a public GitHub issue for a security vulnerability.**

Use GitHub's private vulnerability reporting: go to the **Security** tab of
this repository → **Report a vulnerability**. This opens a private channel
with maintainers and does not disclose the issue publicly until a fix is
ready.

Include, where relevant:

- The affected version(s) of `better-auth-adapter-prisma8`
- Whether the issue is in query translation (e.g. a predicate that could
  over-match or under-exclude rows — see the adapter's own handling of
  case-insensitive `in`/`not_in` for the kind of bug class this covers), in
  the generated contract/schema, or elsewhere
- A minimal reproduction

## Supported versions

This package is pre-1.0; only the latest published version receives security
fixes. There are no maintained older release lines.

## Response

We aim to acknowledge reports within a few days and to publish a fix (or an
explanation of why the report doesn't apply) as soon as reasonably possible
given the severity.
