## What does this change, and why?

<!-- The behavior before/after, and the reasoning — not just a restatement of the diff. -->

## Checklist

- [ ] `pnpm run typecheck` passes
- [ ] `pnpm run test:offline` passes (the full mocked suite — no database needed)
- [ ] If this touches query translation, the generators, or anything the [official conformance suite](../README.md#running-the-conformance-suite) exercises: ran it locally against a real Postgres (`LIVE_PG_URL=... pnpm test`) and it's green
- [ ] Added a changeset (`pnpm changeset`) describing the change, unless this is docs/CI-only
- [ ] If this changes behavior for **both** PSL and TypeScript authoring modes, both are covered — this package deliberately keeps the two semantically identical

## Related issue

<!-- Closes #... , or "none" -->
