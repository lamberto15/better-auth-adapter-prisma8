# better-auth-adapter-prisma8

[![CI](https://github.com/lamberto15/better-auth-adapter-prisma8/actions/workflows/ci.yml/badge.svg)](https://github.com/lamberto15/better-auth-adapter-prisma8/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/better-auth-adapter-prisma8.svg)](https://www.npmjs.com/package/better-auth-adapter-prisma8)
[![license](https://img.shields.io/npm/l/better-auth-adapter-prisma8.svg)](LICENSE)

A [Better Auth](https://better-auth.com) database adapter for **Prisma 8**
("Prisma Next", the contract-first data layer — `contract.prisma` + `db.orm` /
`db.sql`), written against that runtime from scratch rather than adapted from
the classic `@prisma/client` adapter.

> ### ⚠️ Upgrade to 0.3.3 — earlier versions could destroy your contract
>
> **`0.2.0`–`0.3.1`: `generate` could silently replace your existing
> `contract.prisma`/`contract.ts` with only the newly-added models, losing
> everything else in it.** Those versions assumed the Better Auth CLI would
> *append* new models when a `createSchema` hook returned `append: true`. It
> doesn't — reading the installed `@better-auth/cli` source directly shows it
> always overwrites the whole file with whatever `code` is returned, with no
> append step at all. `0.3.2` fixed the data loss: PSL merges into a complete
> file before returning it, and TypeScript merging fell back to failing loudly
> with paste-by-hand instructions instead of writing anything. `0.3.3` closes
> that last gap — TypeScript contracts now merge automatically too, via the
> real TypeScript compiler API, for the recognized shape (see "Re-running
> `generate`" below); anything outside it still fails loudly rather than
> guessing. If `generate` ever overwrote a contract for you, restore it from
> git history and re-run on `0.3.3` or later.
>
> `0.1.0` was separately broken for an unrelated reason: it was published
> against an incorrect reading of the Prisma 8 API entirely (wrong model
> path, non-existent import paths). There is no migration path from `0.1.0`
> other than upgrading.

## Install

```bash
pnpm add better-auth-adapter-prisma8
```

`@better-auth/core` and `@prisma/orm-postgres` are peer dependencies — a
Prisma 8 Postgres app already has both. `typescript` is an **optional** peer
dependency, used only to structurally merge new models into an existing
`contract.ts` (a project with a TypeScript contract already has it installed;
PSL-only projects don't need it).

`@prisma/orm-postgres` is where the adapter's runtime types and the standalone
filter combinators come from:

| What | Import path |
| --- | --- |
| client factory | `@prisma/orm-postgres/runtime` |
| `and` / `or` / `not` | `@prisma/orm-postgres/orm-client` |
| `AsyncIterableResult` | `@prisma/orm-postgres/components/runtime` |

## Usage

```ts
import { betterAuth } from "better-auth";
import { prisma8Adapter } from "better-auth-adapter-prisma8";
import { db } from "./db"; // postgres<Contract>(...) from '@prisma/orm-postgres/runtime'

export const auth = betterAuth({
  database: prisma8Adapter(db, {
    provider: "postgresql",
    schema: "public",  // PostgreSQL namespace; models resolve as db.orm[schema].User
    transaction: true, // recommended — see "Transactions" below: the default is not atomic
  }),
});
```

On PostgreSQL, models live under a schema namespace: `db.orm.public.User`, not
`db.orm.User`. `schema` defaults to `"public"`; set it if your contract puts the
auth models in another namespace.

### Configuration options

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `provider` | `"postgresql" \| "sqlite"` | *required* | Which Prisma Next target `db` was built from. `"sqlite"` is speculative — see [Scope and known limitations](#scope-and-known-limitations). |
| `schema` | `string` | `"public"` | The PostgreSQL namespace models are addressed under (`db.orm.<schema>.<Model>`). |
| `debugLogs` | `DBAdapterDebugLogOption` | `false` | Forwarded straight to the Better Auth factory's own debug logging — see the core `DBAdapter` docs for the accepted shapes. |
| `usePlural` | `boolean` | `false` | Match a contract whose model/table names are pluralized. |
| `transaction` | `boolean` | `false` | Wrap the factory-level `adapter.transaction(cb)` entry point in a real `db.transaction(...)`. **Recommended: `true`.** The `false` default is not atomic — see [Transactions](#transactions) for exactly which operations this does and doesn't affect. |

## Generating the contract

`@better-auth/cli generate` works exactly as it does on the v7 adapter — the
difference is the artifact. Prisma 7 emits a `schema.prisma` that Prisma then
migrates from; Prisma 8 is contract-first, so this adapter emits a **contract**,
in whichever of the two authoring modes your project uses:

```bash
npx @better-auth/cli generate                        # -> the contract prisma.config.ts names
npx @better-auth/cli generate --output db/contract.prisma   # PSL
npx @better-auth/cli generate --output db/contract.ts       # TypeScript builder
```

Then run it through Prisma's own pipeline:

```bash
npx prisma contract emit
npx prisma migration plan
npx prisma db migrate
```

The emitted contract covers the core models plus anything your enabled plugins
contributed, with relations, `@@unique` / `@@index` (including compound
indexes), `@map` / `@@map`, and `onDelete` actions derived from Better Auth's
own schema. It deliberately emits **no `datasource` or `generator` block** —
in Prisma 8 those live in `prisma.config.ts`.

Re-running `generate` is idempotent, and merging is handled differently per
mode because of how the CLI actually writes files: reading the installed
`@better-auth/cli` source (not its docs) shows `generate` always does one
unconditional overwrite of the whole file with whatever `code` a `createSchema`
hook returns — there is no append step, regardless of what you might expect
from the `append` field on the return type.

- **No contract yet** → a complete file is written.
- **PSL contract exists, models are missing** → since PSL's `model` blocks are
  order-independent, the missing ones are safely appended *in memory* and the
  **complete** merged file — your existing models plus the new ones — is what
  gets written. Nothing is lost.
- **TypeScript contract exists, models are missing** → this generator parses
  the file with the real TypeScript compiler API (`typescript`, an optional
  peer dependency — only needed for this path), locates the
  `defineContract(...)` factory, and splices in new `const <Model> = model(...)`
  declarations plus new/updated entries in the `models: {...}` map it returns.
  Your existing code — including fields, comments, formatting — is untouched
  outside the exact insertion points. This only proceeds when the file's shape
  is one the merger can reason about with certainty (see below); otherwise
  `generate` **fails with an error** rather than guessing, naming what's
  missing and including the snippet to paste in by hand.

  Recognized shape: one `defineContract(scaffold, ({ field, model, rel }) => {
  ... })` call with a block body, ending in `return { models: { ... } } }`
  where `models` is a plain object literal. Each model is a top-level
  `const Name = model("Name", {...})`, optionally chained with `.sql(...)` /
  `.attributes(...)`; its entry in the `models` map is either a bare `Name,`
  or `Name: Name.relations({...})`. This is exactly the shape `create-prisma`
  scaffolds and what this generator itself emits. A hand-restructured file
  (destructured bindings, a spread into `models`, multiple `defineContract`
  calls, an implicit-return factory) falls back to the manual-paste error
  rather than being guessed at.
- **Nothing missing** → the CLI prints *"Your schema is already up to date."*
  and touches nothing.

You can also call the generator directly:

```ts
import {
  createPrisma8Schema,      // picks the mode, returns what the CLI consumes
  generateContractPrisma,   // PSL source
  generateContractTypeScript, // TypeScript-builder source
  discoverContract,         // resolves path + mode from prisma.config.ts
} from "better-auth-adapter-prisma8";
```

### Where the contract is written, and in which language

Both are the *project's* decision, read from your setup rather than assumed:

**Where.** A Prisma 8 project declares exactly one contract source in
`prisma.config.ts`. That path is resolved and used as-is, so a contract at
`./db/schema/contract.ts` is written there — not duplicated into
`prisma/contract.prisma`. Resolution order:

1. `--output`, if you passed one
2. the `contract:` path in `prisma.config.{ts,mts,cts,js,mjs,cjs}`
3. an existing contract file in the conventional locations
4. `prisma/contract.prisma` (what `create-prisma` scaffolds)

The config is **parsed, never executed** — comments are stripped and the path
is matched as a static string literal. A computed value (`path.join(...)`, a
template with `${}`) can't be resolved, so it falls through to the next step
rather than being guessed at.

**Which language.** The file extension selects the authoring mode, for Prisma
and for this generator:

| Contract | Mode | Emitted |
| --- | --- | --- |
| `contract.prisma` | PSL | `model User { … }` |
| `contract.ts` / `.mts` / `.cts` | TypeScript builder | `defineContract({}, ({ field, model, rel }) => …)` |

Both emit the same `contract.json`, so migrations, verification and the query
API behave identically either way. The TypeScript output uses typed model
tokens for relations (`rel.belongsTo(UserFields, …)`, `UserFields.refs.id`)
rather than string names, which avoids the runtime
`PN_CONTRACT_TYPED_FALLBACK_AVAILABLE` warning Prisma emits for string targets.

Both modes merge automatically into a complete file when the existing
contract's shape is recognized — see "Re-running `generate`" above for exactly
what TypeScript's structural merge does and does not handle; outside that, it
falls back to telling you what to paste in by hand rather than guessing. An
up-to-date contract returns empty
output either way, so the CLI reports *"Your schema is already up to date."*


### Ids

String ids are the default. Setting `advanced.database.generateId: "serial"`
switches the contract to `Int @id @default(autoincrement())` and — importantly —
overrides the foreign-key scalars too. Better Auth types every FK as a string
regardless of the id strategy, and Prisma rejects a relation whose FK and PK
types disagree.

### Relations from community plugins

The generator is schema-generic — it reads whatever `getAuthTables(options)`
resolves, including plugin-contributed tables, not a hardcoded list. There is
no ordering requirement: a plugin's tables can be registered in any order
relative to what they reference, in either authoring mode (verified — a
model declared textually before the table it references works the same as
one declared after).

Two relation shapes plugins commonly introduce needed dedicated handling,
each confirmed with a real compile against the installed Prisma 8 builder:

- **A model referencing itself** (hierarchical data — nested categories, org
  trees, threaded comments). Prisma's PSL rejects this outright without an
  explicit `@relation("Name", ...)` on both sides ("Ambiguous self relation
  detected"), so the PSL generator now names every self-relation. The
  TypeScript builder has a different failure mode: chaining `.sql(...)`
  straight onto a model's own `const` while referencing that same `const`
  inside the callback fails to typecheck (`TS7022`), even though the callback
  itself runs lazily at runtime — so a self-referencing model is split into a
  `<Name>Base` + `<Name>` pair to break the cycle. Every other model is
  unaffected by this split.
- **Two foreign keys on one model pointing at the same target** (an audit
  log's `actorId` + `subjectId`, both → `user`). PSL requires the same
  `@relation("Name", ...)` disambiguation here too — now emitted, keyed by FK
  column so the two relations get genuinely distinct names. The TypeScript
  builder needs no special handling for this one: its relations are keyed by
  object property name in the `models` map, not inferred from field-pair
  matching, so there's nothing to disambiguate.

A relation to a target model that isn't emitted (a disabled plugin, or a
table the schema doesn't declare) is noted in a comment on the FK column
rather than emitted as a dangling reference.

### Transactions

`config.transaction` (default `false`) controls the factory-level
`adapter.transaction(cb)` entry point Better Auth and plugins use for
multi-step atomic writes. **The default is not atomic.** This isn't a gap in
this adapter — it's Better Auth's own factory behavior when no transaction
implementation is configured: `adapter.transaction(cb)` just calls
`cb(adapter)` directly, with no wrapping and no rollback capability, so a
failure partway through a multi-step write leaves the earlier steps
committed (confirmed by reading `@better-auth/core`'s factory source, not
assumed). Set `transaction: true` if anything using this adapter — Better
Auth internals, or a plugin — relies on a multi-step operation being all-or-
nothing.

With `transaction: true`, `adapter.transaction(cb)` opens a real
`db.transaction(...)` and a thrown error inside `cb` rolls back every write
made through it, verified with a fake that actually snapshots and restores
state on failure (unlike a shared-mutable-object fake, which can't
distinguish real rollback from "nothing happened to run into a bug yet").
The single-row guarded primitives (`consumeOne`, `incrementOne`, `update`,
`delete`) always try to open their own transaction when called standalone —
independent of `config.transaction` — because their correctness depends on
the read and the guarded write happening together; called from inside an
already-open transaction, they reuse it rather than opening a second one.

Better Auth's own transaction-callback type (`DBTransactionAdapter`) is the
full adapter *minus* `transaction` itself, so a plugin cannot call
`.transaction(...)` again from inside an already-open one through the typed
API — there's no "nested transaction from a plugin" case to support.

## Why this isn't a port of the v7 adapter

Prisma Next's query surface is structurally different from the classic
`PrismaClient` that `better-auth`'s own `prismaAdapter` targets:

- **Model access is namespace-qualified.** `db.orm.public.User` on PostgreSQL,
  not `prisma.user`. (MongoDB uses lowercase-plural collection roots with no
  namespace — `db.orm.users` — which is one reason Mongo is out of scope here.)
- **Predicates are lambdas over a field accessor**, not nested filter objects:
  `.where((u) => u.email.eq(x))` rather than `{ email: { equals: x } }`.
  Comparison operators hang off the field: `eq`, `neq`, `gt`, `lt`, `gte`,
  `lte`, `like`, `ilike`, `in`, `notIn`, `isNull`, `isNotNull`. `ilike` is
  registered by the Postgres adapter. `and` / `or` / `not` are standalone
  combinators imported from `@prisma/orm-postgres/orm-client`.
- **Mutation terminals come in three forms**, and picking the right one *is*
  the API — there is no `WhereUniqueInput` distinction to branch on:

  | Form | Affects | Returns |
  | --- | --- | --- |
  | `create` / `update` / `delete` | one record | the affected record (`Row \| null` for update/delete) |
  | `createAll` / `updateAll` / `deleteAll` | every match | the affected records (`AsyncIterableResult<Row>`) |
  | `createAndCount` / `updateAndCount` / `deleteAndCount` | every match | the number affected |

  Note the spelling: the installed `@prisma/orm-family-sql` declares
  `updateAndCount` / `deleteAndCount` / `createAndCount`. Prisma's own "Writing
  data" docs say `updateCount` / `deleteCount` / `createCount`, which is wrong
  for this package version — calling those is how `0.3.0` silently returned
  `undefined` from `updateMany` / `deleteMany`.

  `update()` and `delete()` change exactly one row even when the filter matches
  many; on PostgreSQL the runtime narrows by identity (a `SELECT … LIMIT 1` over
  the current filters, then acts on that row). So the adapter's `updateOne` /
  `deleteOne` map straight onto them — no read-then-write guard is needed, and
  the one this package shipped in `0.1.0` has been removed.
- **Reads return an `AsyncIterableResult`.** `.all()` is awaitable to an array
  *or* streamable with `for await`, but only once — switching consumption mode
  on an already-consumed result throws `RUNTIME.ITERATOR_CONSUMED`. Pagination
  is `take(n)` / `skip(n)`. `first()` accepts an inline filter on PostgreSQL:
  `db.orm.public.User.first({ email })`.
- **Counting goes through `aggregate`:**
  `aggregate((agg) => ({ total: agg.count() }))` resolves to a single object,
  and `count()` is always a number.
- **There is no `$transaction`.** Multi-step writes go inside a single
  `db.transaction(...)` callback.
- **There is no `{ field: { increment: n } }` shorthand** — every mutation takes
  literal values, so `incrementOne` and `consumeOne` are transactional
  read → recompute → write.

## Scope and known limitations

- **PostgreSQL is the target.** Prisma 8 ships PostgreSQL (primary) and
  MongoDB; per Prisma's docs, "SQLite support is planned next, then MySQL".
- **`provider: "sqlite"` is speculative.** The option exists and the contract
  generator has a SQLite lane (no native `Json`, no scalar lists — both degrade
  to `String` with an inline comment), but SQLite is not a Prisma 8 target yet,
  so nothing in that lane has been exercised against a real runtime. Treat it
  as unsupported until Prisma ships the target.
- **Mongo is out of scope.** Different model roots (`db.orm.users`), a
  different transaction story, and no `db.sql`.
- **No `migrationConnection`.** Prisma Next owns migrations via the contract;
  bridging Better Auth's ad-hoc raw-SQL migration engine underneath a
  contract-first tool would fight the framework. Use `generate` + Prisma's own
  migration workflow, as above.
- **Case-insensitive matching** uses `ilike`, which the Postgres adapter
  registers. On any other provider it degrades to `like`.
- **Enum-typed fields** (Better Auth's `Array<LiteralString>`) emit as `String`
  with a `// one of: …` comment rather than a Prisma `enum` block — PSL enum
  members must be bare identifiers, and plugin literals routinely contain
  hyphens and dots.
- **Verified against a live database.** The adapter passes Better Auth's own
  official conformance suite (`@better-auth/test-utils/adapter`) in full —
  all 460 tests across every suite the package exports (`normal`,
  `transactions`, `case-insensitive`, `number-id`, `uuid`, `joins`,
  `auth-flow`), with nothing skipped, against a real PostgreSQL 16 through the
  real `@prisma/orm-postgres` runtime. See
  [Running the conformance suite](#running-the-conformance-suite).
- **`advanced.database.joins: true` gets a real batched join, not a real SQL
  `JOIN`.** With the (default) `joins: false`, the factory resolves a `join`
  clause itself via `handleFallbackJoin` — one follow-up query per joined
  model, *per base row*, entirely outside this adapter's control. With
  `joins: true`, the factory hands this adapter the resolved `on: {from, to}`
  columns directly, and `findOne`/`findMany` use them to fetch every related
  row in exactly one extra query per joined model — collecting every base
  row's `on.from` value and issuing a single `.where(f => f.to.in([...]))`,
  then grouping results back onto their base row in this process. That turns
  an N-row `findMany` from `1 + N` queries into `1 + (joined models)`,
  regardless of N.

  This is not a single SQL `JOIN` (Kysely's and Drizzle's official adapters
  build a real one; this adapter's structural, relation-agnostic design has
  no access to a contract's declared relations, only the column pair Better
  Auth already resolved) — so it doesn't collapse to a single round trip, and
  a to-many join with a per-row `limit` is truncated in this process rather
  than pushed into the query (there is no portable "top N per group" in the
  field-proxy predicate lane), which can over-fetch relative to what a real
  join would return. But it is a real, verified fix for the actual cost this
  option exists to avoid: query *count*, not row volume. Verified both by the
  conformance suite's `joins` suite (`advanced.database.joins: true`, 460/460
  passing) and by dedicated unit tests asserting the query is batched (a
  single `.in(...)` call, never one `.eq(...)` per row).
- **`Temporal` is required.** Prisma 8 rc's `dateTime` codec takes a TC39
  `Temporal.Instant` and rejects a native `Date`. This package converts at the
  boundary using `@js-temporal/polyfill`, reusing `globalThis.Temporal` when an
  app already installed one, so neither Better Auth nor your code ever sees a
  `Temporal` value.
- **`advanced.database.generateId: "uuid"` generates a time-ordered (v7) id,
  on PostgreSQL.** The adapter declares `supportsUUIDs: true` there — matching
  what `@better-auth/kysely-adapter`, `@better-auth/drizzle-adapter`, and
  `@better-auth/prisma-adapter` all declare for their own Postgres target —
  so Better Auth omits the id from the insert and leaves it to the ORM
  runtime. Both generators use Prisma 8's dedicated preset for this:
  `field.id.uuidv7String()` in the TypeScript builder, `@default(uuid(7))` in
  PSL. The two are not just similar — they lower to the identical internal
  representation (confirmed by reading `@prisma/orm-target-postgres`'s
  default-function registry directly: `uuid(7)` never appears in Prisma's
  published docs, only in that source), so a PSL-authored and a
  TypeScript-authored contract generate ids exactly the same way.

  Generation is **client-side** — the ORM runtime mints the id before the
  insert, the same mechanism the `createdAt`/`updatedAt` `instantNow`
  generator uses — not a database function, so there is no PostgreSQL
  version floor. v7 rather than v4: time-ordered ids give better B-tree index
  locality on an insert-heavy table than v4's fully-random layout. The
  generated id column is `character(36)` (not the plain `text` every foreign
  key gets) but, unlike `useNumberId`'s `Int` id, needs no FK retyping —
  verified directly that Postgres's "character" type family interoperates
  with `text` for both FK constraints and equality lookups, unlike
  `integer`/`text`, which Postgres rejects outright.

  `false` on SQLite — nothing in that lane emits a matching preset, so
  Better Auth keeps generating the id in application code there, same as
  before.

  If you hand-write a contract whose Postgres id column already uses a
  different default (`gen_random_uuid()`, `uuid_generate_v4()`, ...), that
  default is used exactly the same way — `supportsUUIDs: true` only tells
  Better Auth *not* to generate the id itself; it has no opinion on how the
  contract does.

## Development

```bash
pnpm install
pnpm test          # fully mocked — no real database needed
pnpm test:coverage
pnpm typecheck
pnpm build
```

The mocked suite covers:

- `src/prisma8-adapter.test.ts` — query translation, against a fake in-memory
  `db.orm.<schema>.<Model>`. Covers predicate/connector composition, null
  handling, LIKE-wildcard escaping (including per-member escaping for a
  case-insensitive `in` / `not_in`), `select` column-name mapping, array
  handling per provider, the one/All/Count mutation forms, `consumeOne` /
  `incrementOne`, and every transaction path.
- `src/schema-generator.test.ts` / `src/typescript-contract-*.test.ts` —
  contract emission in isolation: field types, relations, indexes, name
  mapping, merging, in both the PSL and TypeScript authoring modes.
- `src/create-schema.integration.test.ts` — the wired CLI path end to end:
  adapter → `createSchema` → merge against a real file on disk.

### Running the conformance suite

`src/official-adapter-suite.integration.test.ts` runs Better Auth's own
adapter conformance suite against a real database. It is opt-in — without
`LIVE_PG_URL` it is skipped, so `pnpm test` stays green with no database.

```bash
LIVE_PG_URL="postgres://user:pass@localhost:5432/dbname" pnpm test
```

The fixture derives both the DDL and the Prisma contract from
`getAuthTables(options)` on every schema change, so the ~30 tests that
introduce a mid-run schema change (an extra plugin model, an added field, a
renamed column or model, serial vs. string ids) all run for real rather than
being skipped.

> **Use a local database.** The suite issues on the order of ten thousand
> sequential round trips. Against a local Postgres that is ~80 seconds; against
> a hosted database on the other side of a ~270 ms round trip it is several
> *hours*, which looks exactly like a hang. This is a property of the suite, not
> of the adapter — latency is per statement and nothing here can batch it away.
>
> ```bash
> docker run -d --name ba-pg -e POSTGRES_PASSWORD=test -p 55432:5432 postgres:16-alpine
> LIVE_PG_URL="postgres://postgres:test@127.0.0.1:55432/postgres" pnpm test
> ```
