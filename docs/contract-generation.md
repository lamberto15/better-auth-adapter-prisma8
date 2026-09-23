# Contract generation

How `@better-auth/cli generate` produces a Prisma 8 contract with this adapter,
and what happens when you run it again. For the quick version, see the
[README](../README.md#generating-the-contract).

## What gets generated

The contract covers Better Auth's core models plus every table your enabled
plugins contribute. It includes relations, `@@unique` / `@@index` (including
compound indexes), `@map` / `@@map`, and `onDelete` actions taken from Better
Auth's own schema.

It deliberately contains **no `datasource` or `generator` block**. In Prisma 8
those live in `prisma.config.ts`.

## Where it's written

A Prisma 8 project declares one contract source in `prisma.config.ts`, and the
generator writes to that path. A contract at `./db/schema/contract.ts` is
updated in place, not duplicated into `prisma/contract.prisma`.

The path is resolved in this order:

1. `--output`, if you passed one
2. the `contract:` path in `prisma.config.{ts,mts,cts,js,mjs,cjs}`
3. an existing contract file in the conventional locations
4. `prisma/contract.prisma` (what `create-prisma` scaffolds)

`prisma.config.ts` is parsed, never executed: the path must be a plain string
literal. A computed value (`path.join(...)`, a template with `${}`) can't be
resolved, so resolution moves on to the next step.

## PSL or TypeScript

The file extension picks the authoring mode:

| Contract | Mode | Emitted |
| --- | --- | --- |
| `contract.prisma` | PSL | `model User { … }` |
| `contract.ts` / `.mts` / `.cts` | TypeScript builder | `defineContract({}, ({ field, model, rel }) => …)` |

Both produce the same `contract.json`, so migrations and queries behave
identically. The TypeScript output uses typed model tokens for relations
(`rel.belongsTo(UserFields, …)`), which avoids Prisma's
`PN_CONTRACT_TYPED_FALLBACK_AVAILABLE` runtime warning for string targets.

## Running `generate` again

Re-running is safe. The Better Auth CLI always overwrites the whole file with
what the adapter returns, so the adapter always returns a **complete** contract:

- **No contract yet:** a complete file is written.
- **PSL contract with missing models:** the missing models are added to your
  existing contract and the full file is written. Nothing is lost.
- **TypeScript contract with missing models:** the file is parsed with the
  TypeScript compiler API and the new models are inserted. Your existing code,
  comments and formatting are left untouched. This needs `typescript`
  installed (an optional peer dependency).
- **Nothing missing:** the CLI prints *"Your schema is already up to date."*
  and changes nothing.

The TypeScript merge only runs when it recognizes the file's shape: a single
`defineContract(scaffold, ({ field, model, rel }) => { ... })` call with a
block body that ends in `return { models: { ... } }`, where each model is a
top-level `const Name = model("Name", {...})` (optionally chained with
`.sql(...)` / `.attributes(...)`) and appears in `models` as `Name,` or
`Name: Name.relations({...})`. That's the shape `create-prisma` scaffolds and
the generator itself emits.

If the file has been restructured (destructuring, a spread into `models`,
several `defineContract` calls, an implicit return), `generate` stops with an
error that lists the missing models and the code to paste in by hand. It
never guesses.

## Ids

String ids are the default.

- **`advanced.database.generateId: "serial"`** switches ids to
  `Int @id @default(autoincrement())` and retypes the foreign keys to match,
  since Prisma rejects a relation whose key types disagree.
- **`advanced.database.generateId: "uuid"`** (PostgreSQL) generates
  time-ordered UUIDv7 ids: `@default(uuid(7))` in PSL,
  `field.id.uuidv7String()` in TypeScript. See
  [internals](internals.md#uuid-ids) for details.

## Plugin relations

The generator reads whatever `getAuthTables(options)` returns, so plugin
tables are included automatically, in any order. Two relation shapes that
plugins commonly use are handled specially:

- **A model that references itself** (nested categories, org trees, threaded
  comments). PSL gets explicit `@relation("Name", ...)` names on both sides,
  which Prisma requires. In TypeScript the model is split into a
  `<Name>Base` + `<Name>` pair so it typechecks.
- **Two foreign keys on one model pointing at the same table** (for example
  an audit log's `actorId` and `subjectId`, both pointing at `user`). PSL gets
  a distinct relation name per foreign key. TypeScript needs nothing extra.

A relation to a model that isn't generated (a disabled plugin, for example)
is left as a comment on the foreign-key column instead of a broken reference.

## Enum fields

Enum-typed fields (Better Auth's `Array<LiteralString>`) are emitted as
`String` with a `// one of: …` comment rather than a Prisma `enum`, because
enum members must be bare identifiers and plugin values often contain
hyphens and dots.

## Calling the generator directly

```ts
import {
  createPrisma8Schema,        // picks the mode, returns what the CLI consumes
  generateContractPrisma,     // PSL source
  generateContractTypeScript, // TypeScript-builder source
  discoverContract,           // resolves path + mode from prisma.config.ts
} from "better-auth-adapter-prisma8";
```
