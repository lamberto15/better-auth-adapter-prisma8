# better-auth-adapter-prisma8

[![CI](https://github.com/lamberto15/better-auth-adapter-prisma8/actions/workflows/ci.yml/badge.svg)](https://github.com/lamberto15/better-auth-adapter-prisma8/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/better-auth-adapter-prisma8.svg)](https://www.npmjs.com/package/better-auth-adapter-prisma8)
[![license](https://img.shields.io/npm/l/better-auth-adapter-prisma8.svg)](LICENSE)
[![OpenSSF Scorecard](https://api.scorecard.dev/projects/github.com/lamberto15/better-auth-adapter-prisma8/badge)](https://scorecard.dev/viewer/?uri=github.com/lamberto15/better-auth-adapter-prisma8)
[![OpenSSF Best Practices](https://www.bestpractices.dev/projects/14766/badge)](https://www.bestpractices.dev/projects/14766)

A [Better Auth](https://better-auth.com) database adapter for **Prisma 8**
(Prisma Next, the contract-first version of Prisma).

- Stores users, sessions, accounts and plugin data through Prisma 8's
  `db.orm` runtime on PostgreSQL.
- Generates your Prisma contract (PSL or TypeScript) with
  `@better-auth/cli generate`, and adds to an existing contract without
  overwriting your own models.
- Passes Better Auth's official adapter test suite in full, with nothing
  skipped, against a real PostgreSQL database on every change.

## Install

```bash
pnpm add better-auth-adapter-prisma8
```

`@better-auth/core` and `@prisma/orm-postgres` are peer dependencies, which a
Prisma 8 PostgreSQL app already has. `typescript` is an optional peer
dependency, needed only if your contract is written in TypeScript.

## Quick start

```ts
import { betterAuth } from "better-auth";
import { prisma8Adapter } from "better-auth-adapter-prisma8";
import { db } from "./db"; // your Prisma 8 client, from '@prisma/orm-postgres/runtime'

export const auth = betterAuth({
  database: prisma8Adapter(db, {
    provider: "postgresql",
    transaction: true, // recommended, see Transactions below
  }),
});
```

### Configuration options

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `provider` | `"postgresql" \| "sqlite"` | *required* | The database your Prisma client uses. Use `"postgresql"`; see [Limitations](#limitations). |
| `schema` | `string` | `"public"` | The PostgreSQL schema your auth models live in (`db.orm.<schema>.<Model>`). |
| `transaction` | `boolean` | `false` | Run Better Auth's multi-step writes in a real database transaction. **Recommended: `true`.** |
| `usePlural` | `boolean` | `false` | Set if your model/table names are plural. |
| `debugLogs` | `DBAdapterDebugLogOption` | `false` | Passed through to Better Auth's adapter debug logging. |

## Generating the contract

Let the Better Auth CLI write the auth models into your Prisma contract, then
run Prisma's usual migration steps:

```bash
npx @better-auth/cli generate    # writes to the contract in prisma.config.ts

npx prisma contract emit
npx prisma migration plan
npx prisma db migrate
```

- **The file type sets the format:** `contract.prisma` gets PSL, and
  `contract.ts` gets Prisma's TypeScript builder. Use `--output <path>` to
  pick a different file.
- **Running it again is safe.** Missing models are added and everything else
  is left as it is. If a TypeScript contract has an unusual structure,
  `generate` stops and shows you what to paste in, rather than guessing.
- **Plugins are included:** tables from your enabled Better Auth plugins,
  with their relations and indexes.

Details: [contract generation](https://github.com/lamberto15/better-auth-adapter-prisma8/blob/main/docs/contract-generation.md).

## Transactions

Set `transaction: true`. With the default `false`, Better Auth runs multi-step
writes without a transaction (that's Better Auth's own default), so a failure
partway through can leave some writes behind. With `true`, they run in a real
database transaction and roll back together on error.

## Limitations

- **PostgreSQL only.** `provider: "sqlite"` exists for when Prisma 8 adds
  SQLite, but it's untested until then. MongoDB isn't supported.
- **Migrations go through Prisma.** Use `generate` plus Prisma's own
  migration commands; Better Auth's built-in migrate command isn't supported.
- **Joins are batched, not a single SQL `JOIN`.** With
  `advanced.database.joins: true`, each joined model is fetched in one extra
  query for all rows.
- **Enum fields become `String`** with a comment listing the allowed values.

More on how it works: [internals](https://github.com/lamberto15/better-auth-adapter-prisma8/blob/main/docs/internals.md).

## Development

See [CONTRIBUTING.md](CONTRIBUTING.md) for setup, running the tests (including
the live PostgreSQL suite), and how releases work. Report security issues
privately as described in [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE)
