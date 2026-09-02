import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// The adapter imports the predicate combinators from
// `@prisma/orm-postgres/orm-client`, which is supplied by the consuming Prisma 8
// app. None of these tests build a predicate, but importing the adapter pulls
// the module in, so it has to resolve to something.
vi.mock("@prisma/orm-postgres/orm-client", () => ({
	and: (...conditions: unknown[]) => conditions.every(Boolean),
	or: (...conditions: unknown[]) => conditions.some(Boolean),
	not: (condition: unknown) => !condition,
}));

import type { BetterAuthOptions } from "@better-auth/core";
import { prisma8Adapter } from "./index";
import type { Prisma8AdapterConfig, PrismaNextDb } from "./prisma8-adapter";

/**
 * These tests exercise the path `@better-auth/cli generate` actually takes:
 * resolve the adapter → call `createSchema` → write `code` to `path`. The
 * schema-generator unit tests cover emission in isolation; what is verified
 * here is the *wiring* — that the adapter exposes the hook at all, forwards
 * the right config into it, and reads an existing contract off disk so a
 * re-run merges instead of clobbering.
 */

// `createSchema` never touches the ORM, so a client with no models is enough.
const fakeDb: PrismaNextDb = {
	orm: {},
	transaction: async <T>(callback: (tx: { orm: unknown }) => Promise<T>) =>
		callback({ orm: {} }),
};

function buildAdapter(
	config: Partial<Prisma8AdapterConfig> = {},
	options: BetterAuthOptions = {},
) {
	return prisma8Adapter(fakeDb, { provider: "postgresql", ...config })(options);
}

let dir: string;

beforeAll(async () => {
	dir = await mkdtemp(join(tmpdir(), "prisma8-adapter-"));
});

afterAll(async () => {
	await rm(dir, { recursive: true, force: true });
});

describe("createSchema (the CLI generate path)", () => {
	it("is exposed on the factory-wrapped adapter", () => {
		expect(buildAdapter().createSchema).toBeTypeOf("function");
	});

	it("emits a complete contract for the four core Better Auth models", async () => {
		const adapter = buildAdapter();
		const result = await adapter.createSchema!({}, join(dir, "fresh.prisma"));

		for (const model of ["User", "Session", "Account", "Verification"]) {
			expect(result.code).toContain(`model ${model} {`);
		}
		// The physical table names Better Auth queries are singular and
		// lowercase; the contract model is PascalCase because that is how the
		// adapter addresses it (`db.orm.public.User`).
		expect(result.code).toContain('@@map("user")');
		expect(result.code).toContain(
			"user      User     @relation(fields: [userId], references: [id], onDelete: Cascade)",
		);
		// Contract-first: the provider lives in prisma.config.ts, so emitting a
		// datasource block here would be a Prisma 7 habit. Match on a block
		// *declaration* — the header comment explains the omission and so
		// legitimately contains both words.
		expect(result.code).not.toMatch(/^datasource\s/m);
		expect(result.code).not.toMatch(/^generator\s/m);
	});

	it("writes to the file the CLI passed, and to prisma/contract.prisma otherwise", async () => {
		const adapter = buildAdapter();
		expect((await adapter.createSchema!({}, "db/my-contract.prisma")).path).toBe(
			"db/my-contract.prisma",
		);
		expect((await adapter.createSchema!({}, undefined)).path).toBe(
			"prisma/contract.prisma",
		);
	});

	it("writes a fresh file, and merges a complete file when one already exists", async () => {
		const fresh = await buildAdapter().createSchema!(
			{},
			join(dir, "does-not-exist.prisma"),
		);
		// No file existed, so there's nothing to warn about overwriting.
		expect(fresh).toMatchObject({ overwrite: false });

		const existing = join(dir, "partial.prisma");
		await writeFile(existing, "model User {\n  id String @id\n}\n", "utf8");
		const merged = await buildAdapter().createSchema!({}, existing);
		expect(merged).toMatchObject({ overwrite: true });

		// `@better-auth/cli` never appends — it always does one unconditional
		// `fs.writeFile(path, code)`. Simulating that exact write is what
		// proves the pre-existing User model survives, not just that the
		// returned object looks right.
		await writeFile(existing, merged.code, "utf8");
		const onDisk = await readFile(existing, "utf8");
		expect(onDisk).toMatch(/^model User \{/m);
		expect(onDisk).toMatch(/^model Session \{/m);
	});

	it("reports 'already up to date' by returning empty code on a second run", async () => {
		const path = join(dir, "roundtrip.prisma");
		const first = await buildAdapter().createSchema!({}, path);
		await writeFile(path, first.code, "utf8");

		// The CLI keys its "Your schema is already up to date." branch off a
		// falsy `code`, which is what makes re-running generate idempotent.
		const second = await buildAdapter().createSchema!({}, path);
		expect(second.code).toBe("");

		// And the file it would have written is still the one we wrote.
		expect(await readFile(path, "utf8")).toBe(first.code);
	});

	it("honours usePlural in both the model name and the table mapping", async () => {
		const result = await buildAdapter({ usePlural: true }).createSchema!(
			{},
			join(dir, "plural.prisma"),
		);
		// Better Auth pluralizes the model name before the adapter ever sees it,
		// so the contract model must be pluralized too or `db.orm.public.Users` would
		// not resolve at runtime.
		expect(result.code).toContain("model Users {");
		expect(result.code).toContain('@@map("users")');
	});

	it("emits integer ids when the app asks the database to mint them", async () => {
		const result = await buildAdapter(
			{},
			{ advanced: { database: { generateId: "serial" } } },
		).createSchema!({}, join(dir, "serial.prisma"));

		expect(result.code).toContain("id        Int      @id @default(autoincrement())");
		// Better Auth types every foreign key as a string regardless; the
		// generator has to override that or Prisma rejects the relation for
		// mismatched scalar types.
		expect(result.code).toContain("userId    Int");
		expect(result.code).not.toContain("userId    String");
	});

	it("emits a database-generated uuid id when the app asks for generateId: \"uuid\" on postgresql", async () => {
		const result = await buildAdapter(
			{ provider: "postgresql" },
			{ advanced: { database: { generateId: "uuid" } } },
		).createSchema!({}, join(dir, "uuid.prisma"));

		expect(result.code).toContain("@default(uuid(7))");
		// Unlike `serial`, the id column stays `String`, so foreign keys need
		// no matching override — this only holds because `supportsUUIDs` is
		// declared `true` for postgresql (see `prisma8-adapter.ts`); wiring
		// this from the wrong provider would silently emit an id Better Auth
		// then tries to fill in itself with no defaultValue configured.
		expect(result.code).toContain("userId    String");
	});

	it("does not emit a uuid default on sqlite, which has no matching supportsUUIDs declaration", async () => {
		const result = await buildAdapter(
			{ provider: "sqlite" },
			{ advanced: { database: { generateId: "uuid" } } },
		).createSchema!({}, join(dir, "uuid-sqlite.prisma"));

		expect(result.code).not.toContain("uuid(7)");
		expect(result.code).toContain("id            String    @id");
	});
});

/**
 * Prisma 8 has two authoring modes and the file extension selects between
 * them. A project authoring in TypeScript (`defineContract` from
 * `@prisma/orm-postgres/contract-builder`) must get TypeScript — writing PSL
 * into its `.ts` file would produce a file that is neither language.
 */
describe("TypeScript-authored contracts (contract.ts)", () => {
	it("emits TypeScript, not PSL, for a .ts target", async () => {
		const result = await buildAdapter().createSchema!({}, "prisma/contract.ts");

		// The path is honoured as given — no redirect to a sibling .prisma.
		expect(result.path).toBe("prisma/contract.ts");
		expect(result.code).toContain(
			'from "@prisma/orm-postgres/contract-builder"',
		);
		expect(result.code).toContain("defineContract(");
		// PSL block syntax must not appear anywhere.
		expect(result.code).not.toMatch(/^model User \{/m);
		expect(result.code).not.toContain("@@map(");
	});

	it("still emits PSL for a .prisma target", async () => {
		const result = await buildAdapter().createSchema!({}, "prisma/contract.prisma");

		expect(result.path).toBe("prisma/contract.prisma");
		expect(result.code).toMatch(/^model User \{/m);
		expect(result.code).not.toContain("defineContract(");
	});

	it("treats .mts and .cts as TypeScript too", async () => {
		for (const path of ["db/contract.mts", "db/contract.cts"]) {
			const result = await buildAdapter().createSchema!({}, path);
			expect(result.path).toBe(path);
			expect(result.code).toContain("defineContract(");
		}
	});

	it("maps every core model through the TypeScript builder", async () => {
		const result = await buildAdapter().createSchema!({}, "prisma/contract.ts");

		for (const model of ["User", "Session", "Account", "Verification"]) {
			expect(result.code).toContain(`model("${model}"`);
		}
		// Physical table names are pinned via .sql({ table }), the TS analogue
		// of PSL's @@map.
		expect(result.code).toContain('table: "user"');
		// Relations use typed model tokens, not string names.
		expect(result.code).toContain("rel.belongsTo(");
		expect(result.code).toContain("rel.hasMany(");
	});

	it("refuses to merge into an existing .ts contract rather than risk clobbering it", async () => {
		// `@better-auth/cli` always does one unconditional `fs.writeFile(path,
		// code)` whenever `code` is non-empty — there is no append path. This
		// generator has no TypeScript parser, so it cannot safely splice new
		// declarations into an existing `defineContract(...)` factory the way
		// it pastes additional PSL `model` blocks. Returning the missing-models
		// fragment as `code` here would silently replace the user's real
		// contract with just that fragment — which is exactly what v0.3.1 did.
		const existing = join(dir, "existing-contract.ts");
		await writeFile(
			existing,
			[
				'import { defineContract } from "@prisma/orm-postgres/contract-builder";',
				"export const contract = defineContract({}, ({ field, model }) => {",
				'  const UserFields = model("User", { fields: { id: field.text().id() } });',
				'  const User = UserFields.sql({ table: "user" });',
				"  return { models: { User } };",
				"});",
			].join("\n"),
			"utf8",
		);

		await expect(buildAdapter().createSchema!({}, existing)).rejects.toThrow(
			/cannot safely auto-merge/,
		);

		// And, critically, the user's file was never touched.
		expect(await readFile(existing, "utf8")).toContain('model("User"');
	});
});

describe("contract path comes from prisma.config.ts, not a hardcoded default", () => {
	const withCwd = async <T>(at: string, run: () => Promise<T>): Promise<T> => {
		const previous = process.cwd();
		process.chdir(at);
		try {
			return await run();
		} finally {
			process.chdir(previous);
		}
	};

	it("writes where the config points, even outside prisma/", async () => {
		const project = await mkdtemp(join(tmpdir(), "prisma8-project-"));
		await writeFile(
			join(project, "prisma.config.ts"),
			[
				'import { definePrismaConfig } from "prisma/config";',
				'import { defineConfig as ormConfig } from "@prisma/orm-postgres/config";',
				"",
				"export default definePrismaConfig({",
				'  orm: ormConfig({ contract: "./db/schema/contract.prisma" }),',
				"});",
			].join("\n"),
			"utf8",
		);

		const result = await withCwd(project, () =>
			buildAdapter().createSchema!({}, undefined),
		);

		expect(result.path).toBe("db/schema/contract.prisma");
		expect(result.path).not.toBe("prisma/contract.prisma");
		await rm(project, { recursive: true, force: true });
	});

	it("merges into the configured contract rather than emitting a duplicate", async () => {
		const project = await mkdtemp(join(tmpdir(), "prisma8-project-"));
		await mkdir(join(project, "db"), { recursive: true });
		await writeFile(
			join(project, "prisma.config.ts"),
			'export default { orm: { contract: "./db/contract.prisma" } };',
			"utf8",
		);
		const contractPath = join(project, "db", "contract.prisma");
		// The project's real contract already declares its own model plus User.
		await writeFile(
			contractPath,
			"model Invoice {\n  id String @id\n}\n\nmodel User {\n  id String @id\n}\n",
			"utf8",
		);

		const result = await withCwd(project, () =>
			buildAdapter().createSchema!({}, undefined),
		);

		expect(result.path).toBe("db/contract.prisma");
		expect(result).toMatchObject({ overwrite: true });
		// `code` is the complete file — the CLI overwrites unconditionally, so
		// this is what has to contain everything, not just what's new.
		expect(result.code).toContain("model Invoice");
		expect(result.code).toMatch(/^model User \{/m);
		expect(result.code).toMatch(/^model Session \{/m);

		// Simulate the real CLI write and confirm nothing was lost.
		await writeFile(contractPath, result.code, "utf8");
		const onDisk = await readFile(contractPath, "utf8");
		expect(onDisk).toContain("model Invoice");
		expect(onDisk).toMatch(/^model User \{/m);
		expect(onDisk).toMatch(/^model Session \{/m);

		await rm(project, { recursive: true, force: true });
	});

	it("emits TypeScript when the config points at a .ts contract", async () => {
		const project = await mkdtemp(join(tmpdir(), "prisma8-project-"));
		await writeFile(
			join(project, "prisma.config.ts"),
			'export default { orm: { contract: "./db/schema/contract.ts" } };',
			"utf8",
		);

		const result = await withCwd(project, () =>
			buildAdapter().createSchema!({}, undefined),
		);

		// Both halves at once: the config decides *where*, and its extension
		// decides *which language*.
		expect(result.path).toBe("db/schema/contract.ts");
		expect(result.code).toContain("defineContract(");
		expect(result.code).not.toMatch(/^model User \{/m);
		await rm(project, { recursive: true, force: true });
	});

	it("still lets an explicit --output win over the config", async () => {
		const project = await mkdtemp(join(tmpdir(), "prisma8-project-"));
		await writeFile(
			join(project, "prisma.config.ts"),
			'export default { orm: { contract: "./db/contract.prisma" } };',
			"utf8",
		);

		const result = await withCwd(project, () =>
			buildAdapter().createSchema!({}, "somewhere/else.prisma"),
		);

		expect(result.path).toBe("somewhere/else.prisma");
		await rm(project, { recursive: true, force: true });
	});
});
