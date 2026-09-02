# Contributing

Thanks for considering a contribution. This is a small, focused package —
most changes are welcome, but please open an issue first for anything beyond
a bug fix or small addition, so we can agree on the approach before you put
work into it.

## Setup

```bash
pnpm install
pnpm run typecheck
pnpm run test:offline   # fully mocked — no database needed
```

See the README's [Development](README.md#development) section for what the
mocked test suite covers, and
[Running the conformance suite](README.md#running-the-conformance-suite) for
running the full suite against a real Postgres — required for any change
that touches query translation, the generators, joins, or transactions.
`pnpm run test:offline` alone is not enough to merge a change in those areas.

## Making a change

1. Fork and branch off `main`.
2. Make your change. If it touches query translation or the contract
   generators, keep PSL and TypeScript authoring modes semantically
   identical — this package deliberately guarantees the two produce the same
   behavior, differing only in syntax (see the README's
   ["Why this isn't a port of the v7 adapter"](README.md#why-this-isnt-a-port-of-the-v7-adapter)
   section for why that matters).
3. Add or update tests. A bug fix without a regression test that would have
   caught it is unlikely to be merged.
4. Run `pnpm run typecheck` and `pnpm run test:offline`; run the live
   conformance suite locally if your change touches anything it exercises.
5. Add a changeset: `pnpm changeset`. Pick `patch` for a bug fix, `minor` for
   a backwards-compatible feature or capability addition, `major` for a
   breaking change. Skip this for docs-only or CI-only changes.
6. Open a PR. CI runs typecheck, the mocked suite, a build, and the full live
   conformance suite against a Postgres service container.

## Releasing

Releases are automated via [Changesets](https://github.com/changesets/changesets).
Merging a PR with a changeset file queues it; a bot-maintained "Version
Packages" PR batches pending changesets, and merging *that* PR publishes to
npm. You don't need publish access to contribute — only maintainers need the
npm token that makes the release workflow's publish step work.

## Reporting a bug

Please include a minimal reproduction — see the bug report template for what's
useful (package/Prisma/Better Auth versions, contract authoring mode, the
exact error). A repro that fails against the live conformance suite's setup
is the fastest to act on.
