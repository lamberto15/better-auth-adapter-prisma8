import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BetterAuthDBSchema } from "@better-auth/core/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	createPrisma8Schema,
	DEFAULT_CONTRACT_PATH,
	generateContractPrisma,
	type GenerateContractOptions,
} from "./schema-generator";

/**
 * A minimal stand-in for `getAuthTables()`'s core four, kept small so each
 * test asserts on exact emitted text rather than a wall of unrelated fields.
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
	return generateContractPrisma({
		tables: coreTables,
		provider: "postgresql",
		...overrides,
	});
}

/** Extracts a single `model X { … }` block, for focused assertions. */
function modelBlock(source: string, name: string): string {
	const start = source.indexOf(`model ${name} {`);
	expect(start, `model ${name} not found in:\n${source}`).toBeGreaterThan(-1);
	const end = source.indexOf("\n}", start);
	return source.slice(start, end + 2);
}

describe("contract header", () => {
	it("declares no datasource or generator block", () => {
		// Prisma Next configures the provider in `prisma.config.ts`; a
		// `datasource` block in a contract is a Prisma 7 artifact.
		const code = generate();
		// Anchored: the header *mentions* both words in prose.
		expect(code).not.toMatch(/^datasource\b/m);
		expect(code).not.toMatch(/^generator\b/m);
	});

	it("marks the file as a Prisma Next contract and ends with a newline", () => {
		const code = generate();
		expect(code).toContain("// use prisma-next");
		expect(code.endsWith("}\n")).toBe(true);
	});

	it("is byte-stable across runs", () => {
		expect(generate()).toBe(generate());
	});
});

describe("model naming", () => {
	it("PascalCases the table name and pins it with @@map", () => {
		const code = generate();
		expect(code).toContain("model User {");
		expect(code).toContain('  @@map("user")');
		expect(code).toContain("model Session {");
		expect(code).toContain('  @@map("session")');
	});

	it("honours usePlural on both the model name and @@map", () => {
		// The adapter capitalizes the *pluralized* name, because Better Auth's
		// factory applies `getModelName` before calling the adapter.
		const code = generate({ usePlural: true });
		expect(code).toContain("model Users {");
		expect(code).toContain('  @@map("users")');
		expect(code).toContain("model Sessions {");
		expect(code).toContain('  @@map("sessions")');
	});

	it("honours a custom modelName", () => {
		const code = generateContractPrisma({
			provider: "postgresql",
			tables: {
				user: { modelName: "auth_user", fields: {} },
			},
		});
		// First-letter capitalization only — this must match the adapter's
		// `toContractModelName`, which is not a general PascalCase.
		expect(code).toContain("model Auth_user {");
		expect(code).toContain('  @@map("auth_user")');
	});

	it("combines a custom modelName with usePlural", () => {
		const code = generateContractPrisma({
			provider: "postgresql",
			usePlural: true,
			tables: { user: { modelName: "account_holder", fields: {} } },
		});
		expect(code).toContain("model Account_holders {");
		expect(code).toContain('  @@map("account_holders")');
	});

	it("orders models by Better Auth's `order`, then declaration order", () => {
		const code = generateContractPrisma({
			provider: "postgresql",
			tables: {
				zplugin: { modelName: "zplugin", fields: {} },
				aplugin: { modelName: "aplugin", fields: {} },
				session: { modelName: "session", order: 2, fields: {} },
				user: { modelName: "user", order: 1, fields: {} },
			},
		});
		const order = ["User", "Session", "Zplugin", "Aplugin"].map((name) =>
			code.indexOf(`model ${name} {`),
		);
		expect(order).toEqual([...order].sort((a, b) => a - b));
	});

	it("skips tables with disableMigrations", () => {
		const code = generateContractPrisma({
			provider: "postgresql",
			tables: {
				user: { modelName: "user", fields: {} },
				jwks: { modelName: "jwks", fields: {}, disableMigrations: true },
			},
		});
		expect(code).toContain("model User {");
		expect(code).not.toContain("model Jwks {");
	});
});

describe("id field", () => {
	it("emits a string id by default", () => {
		expect(modelBlock(generate(), "User")).toContain(
			"  id            String    @id",
		);
	});

	it("emits an autoincrementing int id with useNumberId", () => {
		const block = modelBlock(generate({ useNumberId: true }), "User");
		expect(block).toContain("Int");
		expect(block).toContain("@id @default(autoincrement())");
		expect(block).not.toContain("id            String");
	});

	it("types foreign keys to match a numeric id", () => {
		const block = modelBlock(generate({ useNumberId: true }), "Session");
		expect(block).toContain("userId    Int");
	});

	it("emits a database-generated uuid id with useUUID", () => {
		const block = modelBlock(generate({ useUUID: true }), "User");
		expect(block).toContain("@id @default(uuid(7))");
		expect(block).toContain("String");
		expect(block).not.toContain("id is generated by Better Auth");
	});

	it("leaves foreign keys as String under useUUID, unlike useNumberId", () => {
		// The id column stays `String` under `useUUID` (only the default
		// changes), so — unlike `useNumberId` — no foreign key needs
		// retyping to match.
		const block = modelBlock(generate({ useUUID: true }), "Session");
		expect(block).toContain("userId    String");
	});

	it("prefers useNumberId when both useNumberId and useUUID are set", () => {
		const block = modelBlock(generate({ useNumberId: true, useUUID: true }), "User");
		expect(block).toContain("@id @default(autoincrement())");
		expect(block).not.toContain("uuid(7)");
	});
});

describe("field types (postgresql)", () => {
	const typed = {
		thing: {
			modelName: "thing",
			fields: {
				s: { type: "string", required: true },
				n: { type: "number", required: true },
				big: { type: "number", required: true, bigint: true },
				b: { type: "boolean", required: true },
				d: { type: "date", required: true },
				j: { type: "json", required: true },
				sl: { type: "string[]", required: true },
				nl: { type: "number[]", required: true },
				lit: { type: ["active", "revoked"], required: true },
			},
		},
	} satisfies BetterAuthDBSchema;

	it("maps every scalar type", () => {
		const block = modelBlock(
			generateContractPrisma({ tables: typed, provider: "postgresql" }),
			"Thing",
		);
		expect(block).toContain("s   String");
		expect(block).toContain("n   Int");
		expect(block).toContain("big BigInt");
		expect(block).toContain("b   Boolean");
		expect(block).toContain("d   DateTime");
		expect(block).toContain("j   Json");
		expect(block).toContain("sl  String[]");
		expect(block).toContain("nl  Int[]");
	});

	it("emits a string-literal union as String with the allowed values", () => {
		const block = modelBlock(
			generateContractPrisma({ tables: typed, provider: "postgresql" }),
			"Thing",
		);
		expect(block).toContain("lit String   // one of: active, revoked");
	});
});

describe("field types (sqlite)", () => {
	const typed = {
		thing: {
			modelName: "thing",
			fields: {
				j: { type: "json", required: true },
				sl: { type: "string[]", required: true },
				nl: { type: "number[]", required: false },
			},
		},
	} satisfies BetterAuthDBSchema;

	const block = modelBlock(
		generateContractPrisma({ tables: typed, provider: "sqlite" }),
		"Thing",
	);

	it("degrades Json to String with an explanatory comment", () => {
		expect(block).toContain("j  String");
		// The word survives in the explanatory note, but never in the type column.
		expect(block).not.toMatch(/^\s+\w+\s+Json\b/m);
		expect(block).toContain("SQLite has no native Json type");
	});

	it("degrades scalar lists to String with an explanatory comment", () => {
		expect(block).not.toContain("String[]");
		expect(block).not.toContain("Int[]");
		expect(block).toContain("SQLite has no scalar lists");
	});

	it("keeps optionality on a degraded list", () => {
		expect(block).toContain("nl String?");
	});
});

describe("field attributes", () => {
	it("marks a field optional only when required is explicitly false", () => {
		const block = modelBlock(generate(), "User");
		expect(block).toContain("image         String?");
		// `required` absent defaults to true in Better Auth's core types.
		expect(block).toContain("\n  name          String\n");
	});

	it("never emits `?` on a scalar list, which Prisma rejects", () => {
		const code = generateContractPrisma({
			provider: "postgresql",
			tables: {
				thing: {
					modelName: "thing",
					fields: { tags: { type: "string[]", required: false } },
				},
			},
		});
		expect(code).toContain("String[]");
		expect(code).not.toContain("String[]?");
	});

	it("emits @unique", () => {
		expect(modelBlock(generate(), "User")).toContain("String    @unique");
	});

	it("emits @default for a literal defaultValue", () => {
		expect(modelBlock(generate(), "User")).toContain(
			"emailVerified Boolean   @default(false)",
		);
	});

	it("emits literal string and number defaults", () => {
		const code = generateContractPrisma({
			provider: "postgresql",
			tables: {
				thing: {
					modelName: "thing",
					fields: {
						role: { type: "string", required: true, defaultValue: "user" },
						count: { type: "number", required: true, defaultValue: 0 },
					},
				},
			},
		});
		expect(code).toContain('@default("user")');
		expect(code).toContain("@default(0)");
	});

	it("never calls a defaultValue thunk, and notes it instead", () => {
		let called = false;
		const code = generateContractPrisma({
			provider: "postgresql",
			tables: {
				thing: {
					modelName: "thing",
					fields: {
						createdAt: {
							type: "date",
							required: true,
							defaultValue: () => {
								called = true;
								return new Date();
							},
						},
					},
				},
			},
		});
		expect(called).toBe(false);
		expect(code).toContain("default is computed by Better Auth on write");
		expect(code).not.toContain("@default(");
	});

	it("emits @updatedAt for a date field with onUpdate", () => {
		expect(modelBlock(generate(), "User")).toContain("DateTime  @updatedAt");
	});

	it("maps a custom fieldName with @map", () => {
		const code = generateContractPrisma({
			provider: "postgresql",
			tables: {
				account: {
					modelName: "account",
					fields: {
						refreshToken: {
							type: "string",
							required: false,
							fieldName: "refresh_token",
						},
					},
				},
			},
		});
		// The contract field is named for the *physical* column, because the
		// adapter indexes the ORM field proxy with `getFieldName`'s output.
		expect(code).toContain('refresh_token String? @map("refresh_token")');
	});
});

describe("indexes", () => {
	it("emits @@index for a field-level index", () => {
		const code = generateContractPrisma({
			provider: "postgresql",
			tables: {
				thing: {
					modelName: "thing",
					fields: { key: { type: "string", required: true, index: true } },
				},
			},
		});
		expect(code).toContain("  @@index([key])");
	});

	it("emits compound @@unique and @@index, honouring name and fieldName", () => {
		const code = generateContractPrisma({
			provider: "postgresql",
			tables: {
				account: {
					modelName: "account",
					fields: {
						issuer: { type: "string", required: true },
						accountId: {
							type: "string",
							required: true,
							fieldName: "account_id",
						},
					},
					indexes: [
						{ fields: ["issuer", "accountId"], unique: true },
						{ fields: ["accountId"], name: "account_account_id_idx" },
					],
				},
			},
		});
		expect(code).toContain("  @@unique([issuer, account_id])");
		expect(code).toContain(
			'  @@index([account_id], map: "account_account_id_idx")',
		);
	});
});

describe("relations", () => {
	it("emits the FK scalar, the @relation field and the back-relation", () => {
		const code = generate();
		expect(modelBlock(code, "Session")).toContain(
			"user      User     @relation(fields: [userId], references: [id], onDelete: Cascade)",
		);
		expect(modelBlock(code, "User")).toContain("sessions      Session[]");
	});

	it("maps every Better Auth onDelete spelling to its Prisma action", () => {
		const actions = {
			"no action": "NoAction",
			restrict: "Restrict",
			cascade: "Cascade",
			"set null": "SetNull",
			"set default": "SetDefault",
		} as const;
		for (const [betterAuth, prisma] of Object.entries(actions)) {
			const code = generateContractPrisma({
				provider: "postgresql",
				tables: {
					user: { modelName: "user", fields: {} },
					session: {
						modelName: "session",
						fields: {
							userId: {
								type: "string",
								required: true,
								references: {
									model: "user",
									field: "id",
									onDelete: betterAuth as keyof typeof actions,
								},
							},
						},
					},
				},
			});
			expect(code).toContain(`onDelete: ${prisma}`);
		}
	});

	it("defaults onDelete to Cascade, matching Better Auth's default", () => {
		const code = generateContractPrisma({
			provider: "postgresql",
			tables: {
				user: { modelName: "user", fields: {} },
				session: {
					modelName: "session",
					fields: {
						userId: {
							type: "string",
							required: true,
							references: { model: "user", field: "id" },
						},
					},
				},
			},
		});
		expect(code).toContain("onDelete: Cascade");
	});

	it("makes the relation field optional when the FK is optional", () => {
		const code = generateContractPrisma({
			provider: "postgresql",
			tables: {
				user: { modelName: "user", fields: {} },
				thing: {
					modelName: "thing",
					fields: {
						userId: {
							type: "string",
							required: false,
							references: { model: "user", field: "id", onDelete: "set null" },
						},
					},
				},
			},
		});
		expect(code).toContain("userId String?");
		expect(code).toContain("user   User?   @relation");
	});

	it("references a non-id target field through its physical column name", () => {
		const code = generateContractPrisma({
			provider: "postgresql",
			tables: {
				user: {
					modelName: "user",
					fields: {
						email: { type: "string", unique: true, fieldName: "email_address" },
					},
				},
				thing: {
					modelName: "thing",
					fields: {
						ownerEmail: {
							type: "string",
							required: true,
							references: { model: "user", field: "email" },
						},
					},
				},
			},
		});
		expect(code).toContain(
			"@relation(fields: [ownerEmail], references: [email_address]",
		);
	});

	it("disambiguates two relations from the same model to the same target", () => {
		const code = generateContractPrisma({
			provider: "postgresql",
			tables: {
				user: { modelName: "user", fields: {} },
				audit: {
					modelName: "audit",
					fields: {
						actorId: {
							type: "string",
							required: true,
							references: { model: "user", field: "id" },
						},
						subjectId: {
							type: "string",
							required: true,
							references: { model: "user", field: "id" },
						},
					},
				},
			},
		});
		// Prisma rejects this schema outright without an explicit
		// `@relation("Name", ...)` on *both* sides ("Ambiguous relation
		// detected") whenever two relation fields on the same model refer to
		// the same target. The two names must differ from each other (one
		// shared name would not disambiguate `actor` from `subject`) and must
		// match exactly between the scalar side and the list side of each
		// relation.
		const audit = modelBlock(code, "Audit");
		expect(audit).toMatch(
			/\n {2}actor {5}User {3}@relation\("Audit_actorId", fields: \[actorId\], references: \[id\], onDelete: Cascade\)/,
		);
		expect(audit).toMatch(
			/\n {2}subject {3}User {3}@relation\("Audit_subjectId", fields: \[subjectId\], references: \[id\], onDelete: Cascade\)/,
		);
		const user = modelBlock(code, "User");
		expect(user).toMatch(/\n {2}audits\s+Audit\[\] @relation\("Audit_actorId"\)/);
		expect(user).toMatch(
			/\n {2}audits_subjectId\s+Audit\[\] @relation\("Audit_subjectId"\)/,
		);
	});

	it("does NOT add a relation name for two relations to different targets (never ambiguous)", () => {
		// Session -> User and Account -> User are two different (source,
		// target) pairs, so neither collides with the other — a name here
		// would just be unnecessary noise on the overwhelmingly common case.
		const code = generate({
			tables: {
				user: coreTables.user,
				session: coreTables.session,
				account: {
					modelName: "account",
					fields: {
						userId: {
							type: "string",
							required: true,
							references: { model: "user", field: "id" },
						},
					},
				},
			},
		});
		expect(modelBlock(code, "Session")).toContain(
			"@relation(fields: [userId], references: [id]",
		);
		expect(modelBlock(code, "Session")).not.toContain("@relation(\"");
		expect(modelBlock(code, "Account")).not.toContain("@relation(\"");
	});

	it("always names a self-relation, even with only one field", () => {
		// Prisma's rule here is stricter than the multi-relation case: a
		// self-relation needs a name even with a single FK field, because
		// Prisma still sees two endpoints (the scalar side and the inferred
		// list side) on the very same model ("Self-relations always require
		// the @relation attribute").
		const code = generateContractPrisma({
			provider: "postgresql",
			tables: {
				category: {
					modelName: "category",
					fields: {
						parentId: {
							type: "string",
							required: false,
							references: { model: "category", field: "id", onDelete: "set null" },
						},
					},
				},
			},
		});
		const category = modelBlock(code, "Category");
		expect(category).toMatch(
			/@relation\("Category_parentId", fields: \[parentId\], references: \[id\], onDelete: SetNull\)/,
		);
		expect(category).toMatch(/Category\[\] @relation\("Category_parentId"\)/);
	});

	it("notes, rather than emits, a reference to a model that is not emitted", () => {
		const code = generateContractPrisma({
			provider: "postgresql",
			tables: {
				session: {
					modelName: "session",
					fields: {
						userId: {
							type: "string",
							required: true,
							references: { model: "user", field: "id" },
						},
					},
				},
			},
		});
		expect(code).not.toContain("@relation");
		expect(code).toContain("references user.id (model not emitted)");
	});

	it("uses the pluralized model name for back-relations under usePlural", () => {
		const code = generate({ usePlural: true });
		expect(modelBlock(code, "Users")).toContain("sessions      Sessions[]");
	});
});

describe("plugin tables and fields", () => {
	it("emits plugin-added models and extra fields on core models", () => {
		const code = generateContractPrisma({
			provider: "postgresql",
			tables: {
				...coreTables,
				user: {
					...coreTables.user,
					fields: {
						...coreTables.user.fields,
						twoFactorEnabled: { type: "boolean", required: false },
					},
				},
				twoFactor: {
					modelName: "twoFactor",
					fields: {
						secret: { type: "string", required: true },
						userId: {
							type: "string",
							required: true,
							references: { model: "user", field: "id", onDelete: "cascade" },
						},
					},
				},
			},
		});
		expect(code).toContain("twoFactorEnabled Boolean?");
		expect(code).toContain("model TwoFactor {");
		expect(code).toContain('  @@map("twoFactor")');
		expect(modelBlock(code, "User")).toContain("twoFactors");
	});
});

describe("merging into an existing contract", () => {
	const existing = [
		"// use prisma-next",
		"",
		"model Todo {",
		"  id    String @id",
		"  title String",
		"}",
		"",
		"model User {",
		"  id    String @id",
		"  email String @unique",
		"",
		'  @@map("user")',
		"}",
		"",
	].join("\n");

	it("appends only the models the file is missing", () => {
		const code = generate({ existingSchema: existing });
		expect(code).toContain("model Session {");
		// Anchored: `model User { … }` still appears inside the back-relation
		// reminder comment, which is a note, not a declaration.
		expect(code).not.toMatch(/^model User \{/m);
		expect(code).not.toMatch(/^model Todo \{/m);
	});

	it("does not re-emit the header, so the user's own stays intact", () => {
		const code = generate({ existingSchema: existing });
		expect(code).not.toContain("// use prisma-next");
	});

	it("returns an empty string when nothing is missing", () => {
		const code = generate({
			existingSchema: `${existing}\nmodel Session {\n  id String @id\n}\n`,
		});
		expect(code).toBe("");
	});

	it("calls out back-relations that belong on an existing model", () => {
		const code = generate({ existingSchema: existing });
		expect(code).toContain("Add these back-relation fields");
		expect(code).toContain("model User { sessions Session[] }");
	});

	it("ignores a `model` keyword that only appears in a comment", () => {
		const code = generate({
			existingSchema: "// model Session { } was removed on purpose\n",
		});
		expect(code).toContain("model Session {");
	});
});

describe("createPrisma8Schema", () => {
	// The installed `@better-auth/cli@1.4.21` was read directly (dist/index.mjs
	// + dist/generators-*.mjs) to confirm this: for a custom adapter, the CLI
	// destructures only `{ code, path, overwrite }` from `createSchema(...)`'s
	// result — `append` is never read — and its write path is always exactly
	// one unconditional `fs.writeFile(path, code)` whenever `code` is
	// non-empty. So `code` must be the *complete* file every time, never a
	// fragment; these tests simulate that real write to prove it, rather than
	// only inspecting the returned object.
	const simulateCliWrite = async (
		result: Awaited<ReturnType<typeof createPrisma8Schema>>,
	): Promise<string> => {
		if (!result.code) return "";
		await writeFile(result.path, result.code, "utf8");
		return readFile(result.path, "utf8");
	};

	let dir: string;
	beforeAll(async () => {
		dir = await mkdtemp(join(tmpdir(), "prisma8-schema-gen-"));
	});
	afterAll(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	it("returns a whole-file write when there is no existing contract", async () => {
		const result = await createPrisma8Schema({
			tables: coreTables,
			provider: "postgresql",
		});
		expect(result.path).toBe(DEFAULT_CONTRACT_PATH);
		// No file exists yet, so there's nothing to warn about overwriting —
		// matches the built-in Prisma generator's own
		// `overwrite: schemaExists && changed`.
		expect(result.overwrite).toBe(false);
		expect(result.code).toContain("model User {");
	});

	it("honours the file the user passed to `generate`", async () => {
		const result = await createPrisma8Schema({
			tables: coreTables,
			provider: "postgresql",
			file: "db/contract.prisma",
		});
		expect(result.path).toBe("db/contract.prisma");
	});

	it("merges into a complete file, never a fragment, when the contract already exists", async () => {
		// The regression this guards: v0.3.1 returned only the missing models
		// as `code` with `append: true`, expecting the CLI to append. The CLI
		// does not append — it always overwrites the whole file with `code` —
		// so that fragment silently replaced the user's real contract,
		// destroying their existing models.
		const result = await createPrisma8Schema({
			tables: coreTables,
			provider: "postgresql",
			existingSchema: "model User {\n  id String @id\n}\n",
		});
		expect(result.overwrite).toBe(true);
		// `code` is provably the whole file: both the pre-existing model and
		// the newly-added ones are present in the single string we return.
		expect(result.code).toContain("model User {");
		expect(result.code).toContain("model Session {");

		// And simulating the CLI's actual write proves nothing is lost.
		const written = await simulateCliWrite({
			...result,
			path: join(dir, "merge-target.prisma"),
		});
		expect(written).toContain("model User {");
		expect(written).toContain("model Session {");
	});

	it("returns empty code when the contract is already up to date", async () => {
		// The CLI treats empty `code` as "your schema is already up to date"
		// and exits without touching the file.
		const result = await createPrisma8Schema({
			tables: coreTables,
			provider: "postgresql",
			existingSchema: "model User {}\nmodel Session {}\n",
		});
		expect(result.code).toBe("");
		expect(result.overwrite).toBe(false);
	});
});

describe("edge cases", () => {
	it("emits only the header for an empty schema", () => {
		const code = generateContractPrisma({ tables: {}, provider: "postgresql" });
		expect(code).toContain("// use prisma-next");
		expect(code).not.toContain("model ");
		expect(code.endsWith("\n")).toBe(true);
	});

	it("returns empty code for an empty schema merged into an existing file", () => {
		expect(
			generateContractPrisma({
				tables: {},
				provider: "postgresql",
				existingSchema: "model Todo {}\n",
			}),
		).toBe("");
	});

	it("emits a model with no fields but still maps its table", () => {
		const code = generateContractPrisma({
			provider: "postgresql",
			tables: { jwks: { modelName: "jwks", fields: {} } },
		});
		expect(code).toContain("model Jwks {");
		expect(code).toContain("  id String @id");
		expect(code).toContain('  @@map("jwks")');
	});

	it("indents block contents with two spaces and no tabs", () => {
		const code = generate();
		expect(code).not.toContain("\t");
		for (const line of code.split("\n")) {
			if (line.startsWith(" ")) expect(line.startsWith("  ")).toBe(true);
		}
	});

	it("leaves no trailing whitespace on any line", () => {
		for (const line of generate().split("\n")) {
			expect(line).toBe(line.replace(/\s+$/, ""));
		}
	});
});
