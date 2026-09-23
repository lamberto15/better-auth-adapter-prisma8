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
pnpm run test:coverage
pnpm run build
```

The mocked suite covers:

- `src/prisma8-adapter.test.ts`: query translation against a fake in-memory
  `db.orm.<schema>.<Model>`. Predicates and connectors, null handling,
  LIKE-wildcard escaping (including each value of a case-insensitive
  `in` / `not_in`), `select` column mapping, arrays per provider, the
  one/All/Count write forms, `consumeOne` / `incrementOne`, and every
  transaction path.
- `src/schema-generator.test.ts` / `src/typescript-contract-*.test.ts`:
  contract output in isolation (field types, relations, indexes, name
  mapping, merging) in both PSL and TypeScript modes.
- `src/create-schema.integration.test.ts`: the CLI path end to end, from
  adapter to `createSchema` to merging into a real file on disk.

Any change that touches query translation, the generators, joins, or
transactions must also pass the
[live conformance suite](#running-the-conformance-suite).
`pnpm run test:offline` alone is not enough to merge a change in those areas.

## Running the conformance suite

`src/official-adapter-suite.integration.test.ts` runs Better Auth's official
adapter conformance suite against a real PostgreSQL. It's skipped unless
`LIVE_PG_URL` is set, so `pnpm test` passes without a database.

Use a **local** database. The suite runs about ten thousand statements one
after another: seconds against a local database, but it can take hours
against a remote one, which looks like a hang.

Start a throwaway local PostgreSQL (trust auth, so no password is needed),
then point `LIVE_PG_URL` at it:

```bash
docker run -d --name ba-pg -e POSTGRES_HOST_AUTH_METHOD=trust -p 55432:5432 postgres:16-alpine
LIVE_PG_URL="postgresql://postgres@127.0.0.1:55432/postgres" pnpm test
```

The test fixture rebuilds both the database tables and the Prisma contract
from `getAuthTables(options)` whenever a test changes the schema, so the ~30
tests that add a plugin model, add a field, rename a column or switch id
types all run for real instead of being skipped.

## Making a change

1. Fork and branch off `main`.
2. Make your change. If it touches query translation or the contract
   generators, keep PSL and TypeScript authoring modes semantically
   identical — this package deliberately guarantees the two produce the same
   behavior, differing only in syntax (see
   [docs/internals.md](docs/internals.md) for how the adapter maps onto
   Prisma 8's query API).
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
npm. You don't need publish access to contribute — the release workflow
publishes via npm Trusted Publishing (OIDC), so no npm token exists anywhere.

## Reporting a bug

Please include a minimal reproduction — see the bug report template for what's
useful (package/Prisma/Better Auth versions, contract authoring mode, the
exact error). A repro that fails against the live conformance suite's setup
is the fastest to act on.
