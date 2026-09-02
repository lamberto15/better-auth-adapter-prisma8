import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { BetterAuthDBSchema } from "@better-auth/core/db";
import { afterAll, describe, expect, it } from "vitest";
import type { GenerateContractOptions } from "./schema-generator";
import { generateContractTypeScript } from "./typescript-contract-generator";

/**
 * A minimal stand-in for `getAuthTables()`'s core tables, deliberately small so
 * each test asserts on exact emitted text rather than a wall of unrelated
 * fields.
 */
const coreTables = {
	user: {
		modelName: "user",
		order: 1,
		fields: {
			name: { type: "string", required: true },
			email: { type: "string", required: true, unique: true },
			emailVerified: { type: "boolean", required: true, defaultValue: false },
			image: { type: "string", required: false },
			createdAt: { type: "date", required: true },
			updatedAt: { type: "date", required: true, onUpdate: () => new Date() },
		},
	},
	session: {
		modelName: "session",
		order: 2,
		fields: {
			token: { type: "string", required: true, unique: true },
			expiresAt: { type: "date", required: true },
			userId: {
				type: "string",
				required: true,
				references: { model: "user", field: "id", onDelete: "cascade" },
			},
		},
	},
} satisfies BetterAuthDBSchema;

function generate(overrides: Partial<GenerateContractOptions> = {}): string {
	return generateContractTypeScript({
		tables: coreTables,
		provider: "postgresql",
		...overrides,
	});
}

/** Extracts one `const X = …;` declaration, for focused assertions. */
function declaration(source: string, name: string): string {
	const start = source.indexOf(`const ${name} = `);
	expect(start, `const ${name} not found in:\n${source}`).toBeGreaterThan(-1);
	const end = source.indexOf("\n\n", start);
	return source.slice(start, end === -1 ? source.length : end);
}

/**
 * Extracts one model's entry in the `models` map — either a bare `Name,` or
 * the full `Name: Name.relations({...}),` call — for focused assertions on
 * relations, which under the single-const shape live only in the map, not on
 * the model's own `const` declaration.
 */
function mapEntry(source: string, name: string): string {
	const relStart = source.indexOf(`${name}: ${name}.relations({`);
	if (relStart === -1) {
		const bareIndex = source.indexOf(`${name},`);
		expect(bareIndex, `${name} not found as a map entry in:\n${source}`).toBeGreaterThan(-1);
		return `${name},`;
	}
	let depth = 0;
	let i = relStart;
	for (; i < source.length; i++) {
		if (source[i] === "{") depth++;
		else if (source[i] === "}") {
			depth--;
			if (depth === 0) {
				i++;
				break;
			}
		}
	}
	while (source[i] === ")" || source[i] === ",") i++;
	return source.slice(relStart, i);
}

describe("file shape", () => {
	it("imports only defineContract, from the Postgres builder", () => {
		// The scalar helpers (`field.text`, `field.json`, …) are pack-derived —
		// the module-level `field` export carries only `column`/`generated`/
		// `namedType` — so they can only come from the factory's helpers.
		const code = generate();
		expect(code).toContain(
			'import { defineContract } from "@prisma/orm-postgres/contract-builder";',
		);
		expect(code).not.toMatch(/^import .*\bfield\b/m);
	});

	it("uses the scaffold + factory overload so pack helpers are in scope", () => {
		expect(generate()).toContain(
			"export const contract = defineContract({}, ({ field, model, rel }) => {",
		);
	});

	it("exports a named `contract`, matching what create-prisma scaffolds", () => {
		// Verified against the installed loader
		// (@prisma/orm-family-sql's typescriptContractFromPath: `mod.default ??
		// mod.contract`) — both work, but the named export is what a project's
		// own contract.ts already looks like.
		expect(generate()).toMatch(/^export const contract = defineContract\(/m);
	});

	it("omits `rel` from the helper list when nothing relates", () => {
		const code = generateContractTypeScript({
			tables: { user: coreTables.user },
			provider: "postgresql",
		});
		expect(code).toContain("({ field, model }) => {");
	});

	it("declares no datasource or generator", () => {
		const code = generate();
		expect(code).not.toMatch(/^datasource\b/m);
		expect(code).not.toMatch(/^generator\b/m);
	});

	it("ends with a trailing newline and is byte-stable across runs", () => {
		const code = generate();
		expect(code.endsWith("});\n")).toBe(true);
		expect(code).toBe(generate());
	});

	it("returns the models in Better Auth's `order`, then declaration order", () => {
		const code = generateContractTypeScript({
			// Deliberately reversed input order.
			tables: { session: coreTables.session, user: coreTables.user },
			provider: "postgresql",
		});
		expect(code.indexOf("const User")).toBeLessThan(
			code.indexOf("const Session"),
		);
		expect(code.indexOf("User: User.relations({")).toBeLessThan(
			code.indexOf("Session: Session.relations({"),
		);
	});
});

describe("model naming", () => {
	it("capitalizes the physical table name and pins the table", () => {
		const code = generate();
		expect(code).toContain('const User = model("User", {');
		expect(code).toContain('.sql({ table: "user" });');
		expect(code).toContain('const Session = model("Session", {');
	});

	it("honours usePlural on both the model name and the pinned table", () => {
		// Better Auth's factory applies `getModelName` before the adapter sees
		// the name, so the contract model is the capitalized *plural*.
		const code = generate({ usePlural: true });
		expect(code).toContain('model("Users", {');
		expect(code).toContain('table: "users"');
		expect(code).toContain('model("Sessions", {');
	});

	it("derives the model from a custom modelName, first letter only", () => {
		const code = generateContractTypeScript({
			tables: { user: { ...coreTables.user, modelName: "auth_user" } },
			provider: "postgresql",
		});
		// Not `AuthUser` — the adapter's `toContractModelName` uppercases the
		// first character and nothing else.
		expect(code).toContain('model("Auth_user", {');
		expect(code).toContain('.sql({ table: "auth_user" });');
	});

	it("skips tables that opted out of migrations", () => {
		const code = generateContractTypeScript({
			tables: {
				user: coreTables.user,
				session: { ...coreTables.session, disableMigrations: true },
			},
			provider: "postgresql",
		});
		expect(code).not.toContain('model("Session"');
		// …and the dangling foreign key is not emitted either.
		expect(code).not.toContain("rel.hasMany");
	});

	it("emits a valid empty contract for an empty schema", () => {
		const code = generateContractTypeScript({
			tables: {},
			provider: "postgresql",
		});
		expect(code).toContain("return { models: {} };");
		expect(code.endsWith("});\n")).toBe(true);
	});
});

describe("field types", () => {
	function fieldsOf(overrides: Record<string, unknown>): string {
		return generateContractTypeScript({
			tables: {
				thing: {
					modelName: "thing",
					fields: overrides as BetterAuthDBSchema[string]["fields"],
				},
			},
			provider: "postgresql",
		});
	}

	it("maps every Better Auth scalar type", () => {
		const code = fieldsOf({
			s: { type: "string", required: true },
			n: { type: "number", required: true },
			big: { type: "number", required: true, bigint: true },
			b: { type: "boolean", required: true },
			d: { type: "date", required: true },
			j: { type: "json", required: true },
			sl: { type: "string[]", required: true },
			nl: { type: "number[]", required: true },
			lit: { type: ["active", "revoked"], required: true },
		});
		expect(code).toContain("s: field.text(),");
		expect(code).toContain("n: field.int(),");
		expect(code).toContain("big: field.bigint(),");
		expect(code).toContain("b: field.boolean(),");
		expect(code).toContain("d: field.dateTime(),");
		expect(code).toContain("j: field.json(),");
		// `.many()` is the scalar-list modifier on the field builder.
		expect(code).toContain("sl: field.text().many(),");
		expect(code).toContain("nl: field.int().many(),");
		// A literal union is a plain text column plus a note — a synthesized
		// enum would be invalid for the many plugin schemas whose literals are
		// not bare identifiers.
		expect(code).toContain("lit: field.text(), // one of: active, revoked");
	});

	it("degrades json and scalar lists on SQLite, with a note", () => {
		const code = generateContractTypeScript({
			tables: {
				thing: {
					modelName: "thing",
					fields: {
						j: { type: "json", required: true },
						sl: { type: "string[]", required: true },
					},
				},
			},
			provider: "sqlite",
		});
		expect(code).toContain('from "@prisma/orm-sqlite/contract-builder"');
		expect(code).toContain("j: field.text(), // json — SQLite");
		expect(code).toContain("sl: field.text(), // string[] — SQLite");
	});

	it("treats `required` as true unless explicitly false", () => {
		const code = fieldsOf({
			implicit: { type: "string" },
			explicitTrue: { type: "string", required: true },
			explicitFalse: { type: "string", required: false },
		});
		expect(code).toContain("implicit: field.text(),");
		expect(code).toContain("explicitTrue: field.text(),");
		expect(code).toContain("explicitFalse: field.text().optional(),");
	});

	it("never makes a scalar list optional", () => {
		// `.many().optional()` is the array-of-null shape, not the PSL `String[]`
		// the sibling generator emits; PSL rejects `String[]?` outright.
		const code = fieldsOf({ tags: { type: "string[]", required: false } });
		expect(code).toContain("tags: field.text().many(),");
		expect(code).not.toContain(".many().optional()");
	});

	it("emits .unique() for a unique field", () => {
		expect(fieldsOf({ email: { type: "string", unique: true } })).toContain(
			"email: field.text().unique(),",
		);
	});

	it("emits literal defaults and never calls a thunk", () => {
		let called = false;
		const code = fieldsOf({
			flag: { type: "boolean", defaultValue: false },
			count: { type: "number", defaultValue: 3 },
			label: { type: "string", defaultValue: 'he said "hi"' },
			computed: {
				type: "date",
				defaultValue: () => {
					called = true;
					return new Date();
				},
			},
		});
		expect(called).toBe(false);
		expect(code).toContain("flag: field.boolean().default(false),");
		expect(code).toContain("count: field.int().default(3),");
		expect(code).toContain('label: field.text().default("he said \\"hi\\""),');
		// A thunk is per-write, not a column default — noted, never emitted.
		expect(code).toContain(
			"computed: field.dateTime(), // default is computed by Better Auth on write",
		);
	});

	it("uses the updatedAt preset for an onUpdate timestamp", () => {
		expect(generate()).toContain("updatedAt: field.temporal.updatedAt(),");
	});

	it("keys fields by the physical name and pins the rename with .column()", () => {
		// The adapter indexes the ORM field proxy with the *physical* name, so
		// the contract field key has to be that name for queries to resolve.
		const code = fieldsOf({
			accountId: { type: "string", fieldName: "account_id" },
		});
		expect(code).toContain('account_id: field.text().column("account_id"),');
		expect(code).not.toContain("accountId:");
	});

	it("quotes field keys that are not bare identifiers", () => {
		const code = fieldsOf({ weird: { type: "string", fieldName: "a-b" } });
		expect(code).toContain('"a-b": field.text().column("a-b"),');
	});

	it("notes a sortable field", () => {
		expect(fieldsOf({ name: { type: "string", sortable: true } })).toContain(
			"name: field.text(), // sortable",
		);
	});
});

describe("ids", () => {
	it("emits an application-generated text id by default", () => {
		expect(generate()).toContain("id: field.text().id(),");
		expect(generate()).toContain("// id is generated by Better Auth");
	});

	it("emits an integer identity id under useNumberId", () => {
		const code = generate({ useNumberId: true });
		expect(code).toContain('id: field.int().id().defaultSql("autoincrement()"),');
	});

	it("retypes foreign keys to match a numeric id", () => {
		// Better Auth types every FK as `string` because it never sees the
		// column type; Prisma rejects a relation whose scalars disagree.
		expect(generate({ useNumberId: true })).toContain("userId: field.int(),");
		expect(generate()).toContain("userId: field.text(),");
	});

	it("emits a database-generated uuid id under useUUID", () => {
		const code = generate({ useUUID: true });
		expect(code).toContain("id: field.id.uuidv7String(),");
		expect(code).not.toContain("// id is generated by Better Auth");
	});

	it("leaves foreign keys as text under useUUID, unlike useNumberId", () => {
		// The id column stays `field.text()` under `useUUID` (only the default
		// changes), so — unlike `useNumberId` — no foreign key needs a
		// matching override.
		expect(generate({ useUUID: true })).toContain("userId: field.text(),");
	});

	it("prefers useNumberId when both useNumberId and useUUID are set", () => {
		// The two are driven by the same mutually exclusive `generateId`
		// setting and should never both be true in practice, but the
		// generator still has to pick one deterministically rather than
		// emitting something inconsistent.
		const code = generate({ useNumberId: true, useUUID: true });
		expect(code).toContain('id: field.int().id().defaultSql("autoincrement()"),');
		expect(code).not.toContain("gen_random_uuid()");
	});
});

describe("relations", () => {
	it("emits belongsTo on the child and hasMany back on the parent", () => {
		const code = generate();
		expect(mapEntry(code, "Session")).toContain(
			'user: rel.belongsTo(User, { from: "userId", to: "id" }),',
		);
		expect(mapEntry(code, "User")).toContain(
			'sessions: rel.hasMany(Session, { by: "userId" }),',
		);
	});

	it("declares one const per model, and defers every .relations() call to the models map", () => {
		// `.relations({...})` returns a *new* builder rather than mutating in
		// place, and a `.sql(...)` FK constraint only needs the *other* model's
		// bare token — so relations are called once, inside the `return {
		// models: {...} } }` object literal, which is textually after every
		// model's `const`. There is no separate fields-only token.
		const code = generate();
		expect(code).toContain('const User = model("User", {');
		expect(code).not.toContain("UserFields");
		expect(code).not.toContain("const User = User");
		// The relation call sits in the map entry, not on the model's own const.
		expect(declaration(code, "User")).not.toContain("rel.hasMany");
		expect(code).toContain("User: User.relations({");
		// The typed token form also avoids Prisma's
		// PN_CONTRACT_TYPED_FALLBACK_AVAILABLE warning for string targets.
		expect(code).not.toContain('rel.belongsTo("User"');
	});

	it("emits the foreign key against the target's typed field ref", () => {
		expect(declaration(generate(), "Session")).toContain("User.refs.id,");
	});

	it("maps every Better Auth onDelete spelling to the builder's camelCase", () => {
		// Three spellings for one concept: Better Auth uses lowercase-spaced,
		// PSL uses PascalCase, the TS builder uses camelCase.
		const actions = {
			"no action": "noAction",
			restrict: "restrict",
			cascade: "cascade",
			"set null": "setNull",
			"set default": "setDefault",
		} as const;
		for (const [betterAuth, builder] of Object.entries(actions)) {
			const code = generateContractTypeScript({
				tables: {
					user: coreTables.user,
					session: {
						modelName: "session",
						fields: {
							userId: {
								type: "string",
								// `set null` needs a nullable column to validate.
								required: false,
								references: {
									model: "user",
									field: "id",
									onDelete: betterAuth as "cascade",
								},
							},
						},
					},
				},
				provider: "postgresql",
			});
			expect(code).toContain(`{ onDelete: "${builder}" },`);
		}
	});

	it("defaults onDelete to cascade, matching Better Auth", () => {
		const code = generateContractTypeScript({
			tables: {
				user: coreTables.user,
				session: {
					modelName: "session",
					fields: {
						userId: {
							type: "string",
							references: { model: "user", field: "id" },
						},
					},
				},
			},
			provider: "postgresql",
		});
		expect(code).toContain('{ onDelete: "cascade" },');
	});

	it("notes, rather than emits, a reference to a model that is not emitted", () => {
		const code = generateContractTypeScript({
			tables: {
				session: {
					modelName: "session",
					fields: {
						userId: {
							type: "string",
							references: { model: "user", field: "id" },
						},
					},
				},
			},
			provider: "postgresql",
		});
		expect(code).toContain("// references user.id (model not emitted)");
		expect(code).not.toContain("foreignKeys");
	});

	it("disambiguates two relations between the same pair of models", () => {
		const code = generateContractTypeScript({
			tables: {
				user: coreTables.user,
				audit: {
					modelName: "audit",
					fields: {
						actorId: {
							type: "string",
							references: { model: "user", field: "id" },
						},
						subjectId: {
							type: "string",
							references: { model: "user", field: "id" },
						},
					},
				},
			},
			provider: "postgresql",
		});
		expect(code).toContain("actor: rel.belongsTo(User,");
		expect(code).toContain("subject: rel.belongsTo(User,");
		expect(code).toContain("audits: rel.hasMany(Audit,");
		expect(code).toContain("audits_subjectId: rel.hasMany(Audit,");
	});
});

describe("indexes", () => {
	it("emits a field-level index in the SQL stage", () => {
		const code = generateContractTypeScript({
			tables: {
				session: {
					modelName: "session",
					fields: { token: { type: "string", index: true } },
				},
			},
			provider: "postgresql",
		});
		expect(code).toContain("constraints.index([cols.token]),");
	});

	it("emits a compound unique as a model attribute, not an index", () => {
		const code = generateContractTypeScript({
			tables: {
				account: {
					modelName: "account",
					fields: {
						providerId: { type: "string" },
						accountId: { type: "string", fieldName: "account_id" },
					},
					indexes: [{ fields: ["providerId", "accountId"], unique: true }],
				},
			},
			provider: "postgresql",
		});
		// Resolved through the physical column names, matching `@@unique`.
		expect(code).toContain(
			"uniques: [\n        constraints.unique([fields.providerId, fields.account_id]),",
		);
		expect(code).not.toContain("unique: true");
	});

	it("emits a non-unique compound index with its physical name", () => {
		const code = generateContractTypeScript({
			tables: {
				session: {
					modelName: "session",
					fields: { a: { type: "string" }, b: { type: "string" } },
					indexes: [{ fields: ["a", "b"], name: "session_a_b_idx" }],
				},
			},
			provider: "postgresql",
		});
		// `map` is the verbatim physical name, which is what `DBTableIndex.name`
		// documents; the builder's `name` would be hashed into a wire name.
		expect(code).toContain(
			'constraints.index([cols.a, cols.b], { map: "session_a_b_idx" }),',
		);
	});

	it("orders table-level indexes before field-level ones", () => {
		const code = generateContractTypeScript({
			tables: {
				session: {
					modelName: "session",
					fields: { a: { type: "string", index: true }, b: { type: "string" } },
					indexes: [{ fields: ["b"] }],
				},
			},
			provider: "postgresql",
		});
		expect(code.indexOf("cols.b")).toBeLessThan(code.indexOf("cols.a"));
	});
});

describe("merging into an existing TypeScript contract", () => {
	const existing = [
		'import { defineContract } from "@prisma/orm-postgres/contract-builder";',
		"export default defineContract({}, ({ field, model }) => {",
		'  const UserFields = model("User", { fields: { id: field.text().id() } });',
		'  const User = UserFields.sql({ table: "user" });',
		"  return { models: { User } };",
		"});",
	].join("\n");

	it("emits only the models the file is missing", () => {
		const code = generate({ existingSchema: existing });
		expect(code).not.toContain('model("User"');
		expect(code).toContain('model("Session"');
	});

	it("returns an empty string when nothing is missing", () => {
		// This is how the Better Auth CLI is told "already up to date".
		const code = generate({
			existingSchema: `${existing}\n// model("Session"`,
		});
		expect(code).toBe("");
	});

	it("never rewrites the user's file — it emits a paste-ready snippet", () => {
		const code = generate({ existingSchema: existing });
		expect(code).toContain("// Paste these declarations inside the");
		expect(code).not.toContain("export const contract = defineContract");
	});

	it("calls out back-relations that belong on an existing model", () => {
		const code = generate({ existingSchema: existing });
		expect(code).toContain(
			"// Add these back-relations by hand — they belong on models this file",
		);
		expect(code).toContain(
			"Add this to User's entry in the `models` map: User: User.relations({ sessions: rel.hasMany(Session, { by: \"userId\" }) }),",
		);
		expect(code).toContain("or if it already has `.relations(...)`, add the `sessions` property to it.");
	});

	it("shows the exact map entry to add for each new model", () => {
		const code = generate({ existingSchema: existing });
		expect(code).toContain("//   Session: Session.relations({");
		expect(code).toContain('//     user: rel.belongsTo(User, { from: "userId", to: "id" }),');
	});

	it("detects model names under any quote style and loose whitespace", () => {
		for (const declared of [
			'model("Session", {',
			"model('Session', {",
			"model( `Session` , {",
			"model(\n  'Session',",
		]) {
			const code = generate({ existingSchema: `${existing}\n${declared}` });
			expect(code, declared).not.toContain('model("Session"');
		}
	});
});

/**
 * The only assertion that actually proves the generator works: `toContain`
 * cannot tell a valid builder chain from a plausible-looking one. These write
 * the generated source into the repo (so `@prisma/orm-postgres` resolves the
 * way it would in a real project), run the real `tsc` over it, and then
 * *execute* it so `defineContract` builds and semantically validates the
 * contract for real.
 */
describe("the generated contract compiles and builds against the real builder", () => {
	const directory = join(process.cwd(), "node_modules", ".contract-check");
	mkdirSync(directory, { recursive: true });
	afterAll(() => rmSync(directory, { recursive: true, force: true }));

	/** A schema wide enough to exercise every emitter branch at once. */
	const wide = {
		user: coreTables.user,
		session: {
			modelName: "session",
			order: 2,
			fields: {
				token: { type: "string", required: true, unique: true },
				expiresAt: { type: "date", required: true },
				ipAddress: { type: "string", required: false },
				userId: {
					type: "string",
					required: true,
					index: true,
					references: { model: "user", field: "id", onDelete: "cascade" },
				},
			},
			indexes: [
				{ fields: ["token", "userId"], unique: true, name: "session_token_user" },
			],
		},
		account: {
			modelName: "account",
			order: 3,
			fields: {
				accountId: { type: "string", required: true, fieldName: "account_id" },
				scopes: { type: "string[]", required: false },
				metadata: { type: "json", required: false },
				usageCount: { type: "number", required: true, bigint: true },
				status: { type: ["active", "revoked"], required: false },
				userId: {
					type: "string",
					// Nullable, because `setNull` on a NOT NULL column is a
					// semantic error the builder rejects at build time.
					required: false,
					references: { model: "user", field: "id", onDelete: "set null" },
				},
			},
		},
	} satisfies BetterAuthDBSchema;

	function write(name: string, options: Partial<GenerateContractOptions>) {
		const source = generateContractTypeScript({
			tables: wide,
			provider: "postgresql",
			...options,
		});
		const path = join(directory, name);
		writeFileSync(path, source, "utf8");
		return path;
	}

	it("type-checks under tsc --noEmit", () => {
		const paths = [
			write("contract.ts", {}),
			write("contract-number-id.ts", { useNumberId: true }),
			write("contract-uuid.ts", { useUUID: true }),
			write("contract-plural.ts", { usePlural: true }),
		];
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
	}, 180_000);

	it("builds a real contract when executed", async () => {
		const path = write("contract-run.ts", {});
		const module = (await import(/* @vite-ignore */ path)) as {
			contract: { domain?: unknown; storage?: unknown };
		};
		// `defineContract` runs the full lowering + semantic validation pipeline
		// (it throws `CONTRACT.VALIDATION_FAILED` on a bad contract), so getting
		// a built contract back is the end-to-end proof. Read from the named
		// `contract` export — see `typescriptContractFromPath` in the installed
		// `@prisma/orm-family-sql` package, which checks `mod.default ??
		// mod.contract`.
		expect(module.contract).toBeTypeOf("object");
		expect(module.contract.domain).toBeDefined();
		expect(module.contract.storage).toBeDefined();
	}, 60_000);

	it("builds Better Auth's real shape: one parent with two back-relations to two different children", async () => {
		// Not the toy blog example's one-parent-one-child shape: `User` has
		// `sessions` (cascade FK) and `accounts` (set-null FK) — two distinct
		// `hasMany` back-relations to two distinct child models, each with its
		// own `belongsTo` pointing back. This is exactly the shape that made the
		// old two-const-per-model split seem necessary; proving it builds under
		// the single-const shape is the point of this test.
		const path = write("contract-two-children.ts", {});
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
		const models = module.contract.domain.namespaces.public!.models;
		expect(Object.keys(models).sort()).toEqual(["Account", "Session", "User"]);
		expect(models.User!.relations.sessions).toMatchObject({
			to: { model: "Session" },
			cardinality: "1:N",
		});
		expect(models.User!.relations.accounts).toMatchObject({
			to: { model: "Account" },
			cardinality: "1:N",
		});
		expect(models.Session!.relations.user).toMatchObject({
			to: { model: "User" },
			cardinality: "N:1",
		});
		expect(models.Account!.relations.user).toMatchObject({
			to: { model: "User" },
			cardinality: "N:1",
		});
	}, 60_000);
});
