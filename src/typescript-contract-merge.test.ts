import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { BetterAuthDBSchema } from "@better-auth/core/db";
import { afterAll, describe, expect, it } from "vitest";
import type { GenerateContractOptions } from "./schema-generator";
import { generateContractTypeScript } from "./typescript-contract-generator";
import { mergeTypeScriptContract } from "./typescript-contract-merge";

/** Better Auth's real shape: one parent, two children, one unrelated model. */
const fullTables = {
	user: {
		modelName: "user",
		order: 1,
		fields: {
			name: { type: "string", required: true },
			email: { type: "string", required: true, unique: true },
		},
	},
	session: {
		modelName: "session",
		order: 2,
		fields: {
			token: { type: "string", required: true, unique: true },
			userId: {
				type: "string",
				required: true,
				references: { model: "user", field: "id", onDelete: "cascade" },
			},
		},
	},
	account: {
		modelName: "account",
		order: 3,
		fields: {
			providerId: { type: "string", required: true },
			userId: {
				type: "string",
				required: true,
				references: { model: "user", field: "id", onDelete: "cascade" },
			},
		},
	},
	verification: {
		modelName: "verification",
		order: 4,
		fields: {
			identifier: { type: "string", required: true },
			value: { type: "string", required: true },
		},
	},
} satisfies BetterAuthDBSchema;

function tablesSubset(...keys: (keyof typeof fullTables)[]): BetterAuthDBSchema {
	const subset: Record<string, (typeof fullTables)[keyof typeof fullTables]> = {};
	for (const key of keys) subset[key] = fullTables[key];
	return subset as BetterAuthDBSchema;
}

function generatorOptions(tables: BetterAuthDBSchema = fullTables): GenerateContractOptions {
	return { tables, provider: "postgresql" };
}

describe("mergeTypeScriptContract — structural recognition", () => {
	it("rejects a file with zero defineContract(...) calls", async () => {
		const source = "export const contract = 42;\n";
		const result = await mergeTypeScriptContract({
			existingSource: source,
			generatorOptions: generatorOptions(),
		});
		expect(result.code).toBeUndefined();
		expect(result.unsupportedReason).toContain("no defineContract(...) call");
		// Pure function: the input string is untouched (strings are immutable,
		// but this also proves nothing was written to disk from this module).
		expect(source).toBe("export const contract = 42;\n");
	});

	it("rejects a file with two defineContract(...) calls", async () => {
		const source = [
			'import { defineContract } from "@prisma/orm-postgres/contract-builder";',
			'export const a = defineContract({}, ({ field, model }) => ({ models: {} }));',
			'export const b = defineContract({}, ({ field, model }) => ({ models: {} }));',
		].join("\n");
		const result = await mergeTypeScriptContract({
			existingSource: source,
			generatorOptions: generatorOptions(),
		});
		expect(result.code).toBeUndefined();
		expect(result.unsupportedReason).toContain("found 2 defineContract(...) calls");
	});

	it("rejects an implicit-return arrow factory (no block body)", async () => {
		const source = [
			'import { defineContract } from "@prisma/orm-postgres/contract-builder";',
			"export default defineContract({}, ({ field, model }) => ({ models: {} }));",
		].join("\n");
		const result = await mergeTypeScriptContract({
			existingSource: source,
			generatorOptions: generatorOptions(),
		});
		expect(result.code).toBeUndefined();
		expect(result.unsupportedReason).toContain("implicit-return arrow functions are not supported");
	});

	it("rejects a `models` map built via spread", async () => {
		const source = [
			'import { defineContract } from "@prisma/orm-postgres/contract-builder";',
			"const extra = {};",
			"export const contract = defineContract({}, ({ field, model }) => {",
			'  const User = model("User", { fields: { id: field.text().id() } }).sql({ table: "user" });',
			"  return { models: { User, ...extra } };",
			"});",
		].join("\n");
		const result = await mergeTypeScriptContract({
			existingSource: source,
			generatorOptions: generatorOptions(),
		});
		expect(result.code).toBeUndefined();
		expect(result.unsupportedReason).toContain("cannot statically identify");
		expect(source).toContain("...extra");
	});

	it("rejects a `models` property that is not an object literal", async () => {
		const source = [
			'import { defineContract } from "@prisma/orm-postgres/contract-builder";',
			"const models = {};",
			"export const contract = defineContract({}, ({ field, model }) => {",
			"  return { models };",
			"});",
		].join("\n");
		const result = await mergeTypeScriptContract({
			existingSource: source,
			generatorOptions: generatorOptions(),
		});
		expect(result.code).toBeUndefined();
		expect(result.unsupportedReason).toContain("not an object literal");
	});

	it("rejects when it can't find the backing const for a map entry", async () => {
		const source = [
			'import { defineContract } from "@prisma/orm-postgres/contract-builder";',
			"export const contract = defineContract({}, ({ field, model }) => {",
			"  return { models: { User } };",
			"});",
		].join("\n");
		const result = await mergeTypeScriptContract({
			existingSource: source,
			generatorOptions: generatorOptions(),
		});
		expect(result.code).toBeUndefined();
		expect(result.unsupportedReason).toContain('could not find a top-level "const User = model(...)"');
	});

	it("reports unsupported (not a guess) when a needed back-relation targets an opaque entry", async () => {
		const source = [
			'import { defineContract } from "@prisma/orm-postgres/contract-builder";',
			"const cond = true;",
			"export const contract = defineContract({}, ({ field, model, rel }) => {",
			'  const User = model("User", { fields: { id: field.text().id() } }).sql({ table: "user" });',
			"  return { models: { User: cond ? User : User } };",
			"});",
		].join("\n");
		const result = await mergeTypeScriptContract({
			existingSource: source,
			generatorOptions: generatorOptions(tablesSubset("user", "session")),
		});
		expect(result.code).toBeUndefined();
		expect(result.unsupportedReason).toContain('"User" entry in the models map is not a bare reference or a ".relations({...})" call');
	});

	it("is a no-op when everything Better Auth needs is already present", async () => {
		const source = generateContractTypeScript(generatorOptions(tablesSubset("user")));
		const result = await mergeTypeScriptContract({
			existingSource: source,
			generatorOptions: generatorOptions(tablesSubset("user")),
		});
		expect(result.unsupportedReason).toBeUndefined();
		expect(result.code).toBe(source);
	});
});

/**
 * The only assertion that actually proves a merge is safe: write the merged
 * `code` to a temp file, run the real `tsc --noEmit` over it, then execute it
 * so `defineContract`'s real lowering + validation pipeline runs — the same
 * pattern `typescript-contract-generator.test.ts` uses for the generator
 * itself.
 */
describe("mergeTypeScriptContract — real compile and execute", () => {
	const directory = join(process.cwd(), "node_modules", ".contract-merge-check");
	mkdirSync(directory, { recursive: true });
	afterAll(() => rmSync(directory, { recursive: true, force: true }));

	function typeCheck(paths: string[]) {
		execFileSync(
			process.execPath,
			[
				join(process.cwd(), "node_modules", "typescript", "bin", "tsc"),
				"--noEmit",
				"--strict",
				"--exactOptionalPropertyTypes",
				"--target",
				"ES2022",
				"--module",
				"ESNext",
				"--moduleResolution",
				"Bundler",
				"--skipLibCheck",
				...paths,
			],
			{ stdio: "pipe", encoding: "utf8" },
		);
	}

	async function compileAndRun(name: string, code: string) {
		const path = join(directory, name);
		writeFileSync(path, code, "utf8");
		typeCheck([path]);
		const module = (await import(/* @vite-ignore */ path)) as {
			contract: {
				domain: {
					namespaces: Record<
						string,
						{
							models: Record<
								string,
								{ relations: Record<string, { to: { model: string }; cardinality: string }> }
							>;
						}
					>;
				};
			};
		};
		expect(module.contract).toBeTypeOf("object");
		return module.contract.domain.namespaces.public!.models;
	}

	it("adds a model with no relations to other new/existing models (Verification-shape)", async () => {
		const existing = generateContractTypeScript(generatorOptions(tablesSubset("user")));
		const attempt = await mergeTypeScriptContract({
			existingSource: existing,
			generatorOptions: generatorOptions(tablesSubset("user", "verification")),
		});
		expect(attempt.unsupportedReason).toBeUndefined();
		expect(attempt.code).toBeDefined();
		expect(attempt.code).toContain('const Verification = model("Verification"');
		expect(attempt.code).toMatch(/\n\s*Verification,\n/);

		const models = await compileAndRun("verification-shape.ts", attempt.code!);
		expect(Object.keys(models).sort()).toEqual(["User", "Verification"]);
	}, 60_000);

	it("adds a model whose relation targets an existing bare entry, rewriting it to .relations({...})", async () => {
		// Better Auth's real starting point: a contract that only has `User`,
		// generated fresh so its `User` entry is a bare reference (no relations
		// yet — there was nothing to relate to).
		const existing = generateContractTypeScript(generatorOptions(tablesSubset("user")));
		expect(existing).toMatch(/\n\s*User,\n/);

		const attempt = await mergeTypeScriptContract({
			existingSource: existing,
			generatorOptions: generatorOptions(tablesSubset("user", "session")),
		});
		expect(attempt.unsupportedReason).toBeUndefined();
		expect(attempt.code).toBeDefined();
		expect(attempt.code).toContain("User: User.relations({");
		expect(attempt.code).toContain('sessions: rel.hasMany(Session, { by: "userId" }),');
		expect(attempt.code).toContain('const Session = model("Session"');

		const models = await compileAndRun("bare-to-relations.ts", attempt.code!);
		expect(Object.keys(models).sort()).toEqual(["Session", "User"]);
		expect(models.User!.relations.sessions).toMatchObject({
			to: { model: "Session" },
			cardinality: "1:N",
		});
		expect(models.Session!.relations.user).toMatchObject({
			to: { model: "User" },
			cardinality: "N:1",
		});
	}, 60_000);

	it("adds a model whose target already has .relations({...}), inserting into it without overwriting", async () => {
		// Contract already has User + Session (User's entry is already
		// `.relations({ sessions: ... })`); add Account, another child of User.
		const existing = generateContractTypeScript(generatorOptions(tablesSubset("user", "session")));
		expect(existing).toContain("User: User.relations({");
		expect(existing).toContain("sessions: rel.hasMany(Session,");

		const attempt = await mergeTypeScriptContract({
			existingSource: existing,
			generatorOptions: generatorOptions(tablesSubset("user", "session", "account")),
		});
		expect(attempt.unsupportedReason).toBeUndefined();
		expect(attempt.code).toBeDefined();
		// The existing `sessions` relation must survive untouched.
		expect(attempt.code).toContain('sessions: rel.hasMany(Session, { by: "userId" }),');
		expect(attempt.code).toContain('accounts: rel.hasMany(Account, { by: "userId" }),');
		expect(attempt.code).toContain('const Account = model("Account"');

		const models = await compileAndRun("insert-into-existing-relations.ts", attempt.code!);
		expect(Object.keys(models).sort()).toEqual(["Account", "Session", "User"]);
		expect(models.User!.relations.sessions).toMatchObject({ to: { model: "Session" } });
		expect(models.User!.relations.accounts).toMatchObject({ to: { model: "Account" } });
	}, 60_000);

	it("round-trips: merging the rest into a User-only file matches generating everything at once", async () => {
		const existing = generateContractTypeScript(generatorOptions(tablesSubset("user")));
		const attempt = await mergeTypeScriptContract({
			existingSource: existing,
			generatorOptions: generatorOptions(),
		});
		expect(attempt.unsupportedReason).toBeUndefined();
		expect(attempt.code).toBeDefined();

		const merged = await compileAndRun("round-trip-merged.ts", attempt.code!);
		expect(Object.keys(merged).sort()).toEqual(["Account", "Session", "User", "Verification"]);
		expect(merged.User!.relations.sessions).toMatchObject({ to: { model: "Session" }, cardinality: "1:N" });
		expect(merged.User!.relations.accounts).toMatchObject({ to: { model: "Account" }, cardinality: "1:N" });
		expect(merged.Session!.relations.user).toMatchObject({ to: { model: "User" }, cardinality: "N:1" });
		expect(merged.Account!.relations.user).toMatchObject({ to: { model: "User" }, cardinality: "N:1" });
		expect(merged.Verification!.relations).toEqual({});

		const fresh = generateContractTypeScript(generatorOptions());
		const direct = await compileAndRun("round-trip-direct.ts", fresh);
		expect(Object.keys(direct).sort()).toEqual(Object.keys(merged).sort());
	}, 60_000);
});
