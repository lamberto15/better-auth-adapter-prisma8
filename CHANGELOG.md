# Changelog

All notable changes to this package are documented here. Format loosely
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); this package
does not yet tag releases in git, so entries are grouped by npm version only.

## 0.5.0

`0.4.0` was published without its own changelog entry — this repo has no git
history to bisect exactly what was in the tree at that publish, so its
changes are folded into this entry rather than guessed at retroactively.
Everything below shipped across `0.4.0` and `0.5.0` together.

### Added
- **`supportsUUIDs: true` on PostgreSQL.** `advanced.database.generateId:
  "uuid"` now generates a time-ordered (v7) id via the ORM runtime instead of
  Better Auth generating it in application code — matching what
  `@better-auth/kysely-adapter`, `@better-auth/drizzle-adapter`, and
  `@better-auth/prisma-adapter` all declare for their own Postgres target.
  Both contract generators gained a `useUUID` option (mirroring
  `useNumberId`'s existing shape) using Prisma 8's dedicated id preset —
  `field.id.uuidv7String()` in TypeScript, `@default(uuid(7))` in PSL — which
  are confirmed, by reading `@prisma/orm-target-postgres`'s default-function
  registry directly, to lower to the identical internal representation, so
  PSL- and TypeScript-authored contracts generate ids the same way.
  Generation is client-side (no database function, no PostgreSQL version
  floor); the id column is `character(36)`, not the plain `text` every
  foreign key gets, but — unlike `useNumberId`'s `Int` id — needs no FK
  retyping, verified directly that Postgres's "character" type family
  interoperates with `text` for FK constraints and equality. `false` on
  SQLite, where nothing in that lane emits a matching preset.

  An earlier draft of this used a raw `.defaultSql("gen_random_uuid()")`
  default instead of the dedicated preset, out of an unverified assumption
  that the preset's `character(36)` column would need every foreign key
  retyped the same way `useNumberId`'s `Int` id does. Direct testing (a
  `character(36)` primary key against a plain `text` foreign key, through
  both raw SQL and the real adapter) showed that assumption was wrong before
  it shipped.
- Native join pushdown for `advanced.database.joins: true`: `findOne`/`findMany`
  now batch every joined model into a single `.where(f => f.to.in([...]))`
  query instead of relying on Better Auth's per-row `handleFallbackJoin`
  fallback. Turns an N-row `findMany` from `1 + N` queries into
  `1 + (joined models)`, verified against the official conformance suite's
  `joins` suite and dedicated unit tests asserting the query is batched.
- `advanced.database.joins`-driven `db.orm.*.include(...)` is intentionally
  **not** used — the adapter has no access to a contract's declared ORM
  relations, only the column pair Better Auth already resolves, so batching
  (not a single SQL `JOIN`) is the safe primitive here. Documented in the
  README's known-limitations section.
- `test:offline` npm script — the full mocked suite, excluding the live
  conformance suite, so `prepublishOnly` never depends on `LIVE_PG_URL`
  pointing at a real database.
- A connection preflight in the live conformance suite: a bad `LIVE_PG_URL`
  now fails immediately with the actual cause (password redacted) instead of
  four `Caused by:` levels deep in a "Database error while reading contract
  marker" message. Also warns with an estimated runtime when round-trip
  latency is high, since the suite's cost is entirely per-statement (~10,000
  sequential statements — a hosted database an ocean away can look
  indistinguishable from a hang).
- README: a configuration-options reference table (`provider`, `schema`,
  `debugLogs`, `usePlural`, `transaction`).

### Fixed
- **`in`/`not_in` ignored `mode: "insensitive"`.** `insensitive` was computed
  but never applied in those branches — `not_in` silently *failed to exclude*
  differently-cased rows, the auth-bypass direction. Now expanded to one
  `ILIKE` per member, with wildcard escaping preserved.
- **`select` was never mapped from schema field names to column names.** The
  factory pre-maps `where[].field` but hands `select` through as raw schema
  keys; any model using Better Auth's `fields` remapping (e.g.
  `email → email_address`) crashed on every `select`. Fixed in `findOne`,
  `findMany`, and `create`.
- **`supportsArrays` was left at the factory's `false` default** despite this
  package's own generators emitting native Postgres array columns
  (`String[]` / `field.text().many()`), so Better Auth JSON-stringified
  arrays into `text[]` columns and crashed with a bare
  `Cannot read properties of undefined (reading 'codecId')`. Now declared
  `true` on `postgresql`.
- **Packaging: `@prisma/orm-postgres` was only a devDependency**, despite
  `src/prisma8-adapter.ts` having a runtime *value* import from
  `@prisma/orm-postgres/orm-client` (`and`/`or`/`not`). Moved to
  `peerDependencies` — this was a ship-blocker for anyone installing under
  pnpm's isolated `node_modules` layout.
- README/`package.json` drift: the peer-dependency table didn't reflect the
  `@prisma/orm-postgres` fix above.

### Testing
- The official conformance suite (`official-adapter-suite.integration.test.ts`)
  now derives both its DDL and its Prisma contract from
  `getAuthTables(options)` on every schema change, instead of a fixed
  four-model script. This closed 78 previously-skipped tests and fixed 96
  failing ones (fixture bugs: leaked connection pool per schema change,
  FK columns typed as the id type even when referencing a non-`id` column,
  a missing `issuer` column required by Better Auth 1.7.2, `onDelete`
  defaulting to `NO ACTION` instead of `cascade`). Wired up the two suites
  the package exports but this fixture never ran (`joinsTestSuite`,
  `authFlowTestSuite`). Result: **460/460**, nothing skipped, across every
  suite `@better-auth/test-utils/adapter` exports.
- Added unit regression tests for the `in`/`not_in`/`select`/array/UUID-id
  fixes above, and for the native join batching (asserting the joined-model
  query log shows `.in(...)`, never a per-row `.eq(...)`). 721 tests total
  across the mocked suite; 460/460 in the live conformance suite.

## 0.3.3

TypeScript contract merging (`generate` re-runs against an existing
`contract.ts`) now merges automatically via the real TypeScript compiler API,
for the recognized shape — closing the last gap left by 0.3.2. Anything
outside that recognized shape still fails loudly with paste-by-hand
instructions rather than guessing.

## 0.3.2

**Data-loss fix.** `0.2.0`–`0.3.1` assumed `@better-auth/cli`'s `generate`
would *append* new models when a `createSchema` hook returned `append: true`.
It doesn't — it always overwrites the whole file with whatever `code` is
returned, no append step at all. This could silently replace an existing
`contract.prisma`/`contract.ts` with only the newly-added models, losing
everything else in it. Fixed: PSL merges into a complete file before
returning it; TypeScript merging fell back to failing loudly with
paste-by-hand instructions instead of writing anything (full auto-merge for
TypeScript arrived in 0.3.3).

If `generate` ever overwrote a contract for you on `0.2.0`–`0.3.1`, restore
it from git history and re-run on `0.3.2` or later.

## 0.1.0 – 0.3.1

`0.1.0` was published against an incorrect reading of the Prisma 8 API
entirely (wrong model path, non-existent import paths). There is no
migration path from `0.1.0` other than upgrading past it.
