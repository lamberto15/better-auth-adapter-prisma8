import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { BetterAuthDBSchema } from "@better-auth/core/db";
import { afterAll, describe, expect, it, vi } from "vitest";
vi.mock("@prisma/orm-postgres/orm-client", () => ({
	and: () => 1,
	or: () => 1,
	not: () => 1,
}));
import { generateContractTypeScript } from "./typescript-contract-generator";

/**
 * Community plugins are free to declare relation graphs this repo's own core
 * schema never exercises — self-references (hierarchical data: nested
 * categories, org trees, threaded comments) and repeated FKs to the same
 * target. These are compiled and executed against the real builder rather
 * than asserted by string matching, since a plausible-looking but broken
 * relation graph is what `toContain` can't catch.
 */
describe("relation graphs a plugin might introduce", () => {
	const directory = join(process.cwd(), "node_modules", ".contract-check-relations");
	mkdirSync(directory, { recursive: true });
	afterAll(() => rmSync(directory, { recursive: true, force: true }));

	function compileAndExecute(name: string, code: string) {
		const path = join(directory, name);
		writeFileSync(path, code, "utf8");
		execFileSync(
			process.execPath,
			[
				join(process.cwd(), "node_modules", "typescript", "bin", "tsc"),
				"--noEmit",
				"--strict",
				"--target",
				"ES2022",
				"--module",
				"ESNext",
				"--moduleResolution",
				"Bundler",
				"--skipLibCheck",
				path,
			],
			{ stdio: "pipe", encoding: "utf8" },
		);
		return import(/* @vite-ignore */ path);
	}

	it("a model with a foreign key referencing itself (nested categories)", async () => {
		// `const Category = model(...).sql(({cols,constraints}) => ({
		// ...Category.refs.id...}))` fails to typecheck (TS7022: implicitly
		// has type 'any' because it ... is referenced ... in its own
		// initializer), even though the callback itself runs lazily at
		// runtime. The generator must split self-referencing models into a
		// `<Name>Base` + `<Name>` pair to break the cycle.
		const tables = {
			category: {
				modelName: "category",
				fields: {
					name: { type: "string", required: true },
					parentId: {
						type: "string",
						required: false,
						references: { model: "category", field: "id", onDelete: "set null" },
					},
				},
			},
		} satisfies BetterAuthDBSchema;

		const code = generateContractTypeScript({ tables, provider: "postgresql" });
		expect(code).toContain("const CategoryBase = model(");
		expect(code).toContain("CategoryBase.refs.id");

		const mod: any = await compileAndExecute("self-ref.ts", code);
		expect((mod.contract ?? mod.default).domain).toBeDefined();
	}, 30_000);

	it("a model with both a self-referencing FK and a normal cross-model FK", async () => {
		const tables = {
			user: { modelName: "user", fields: {} },
			comment: {
				modelName: "comment",
				fields: {
					body: { type: "string", required: true },
					authorId: {
						type: "string",
						required: true,
						references: { model: "user", field: "id" },
					},
					parentCommentId: {
						type: "string",
						required: false,
						references: { model: "comment", field: "id", onDelete: "cascade" },
					},
				},
			},
		} satisfies BetterAuthDBSchema;

		const code = generateContractTypeScript({ tables, provider: "postgresql" });
		// The cross-model FK still targets the other model's real const —
		// only the self-referencing one is redirected to the `Base` token.
		expect(code).toContain("User.refs.id");
		expect(code).toContain("CommentBase.refs.id");

		const mod: any = await compileAndExecute("mixed.ts", code);
		expect((mod.contract ?? mod.default).domain).toBeDefined();
	}, 30_000);

	it("two foreign keys from the same child to the same parent (audit log pattern)", async () => {
		// Unlike PSL — which structurally infers relation identity from field
		// pairs and needs an explicit @relation(name) to disambiguate two
		// relations to the same target — the TS builder's relations are keyed
		// by object property name, so this needs no special handling at all
		// (this test would fail to compile otherwise).
		const tables = {
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
		} satisfies BetterAuthDBSchema;

		const code = generateContractTypeScript({ tables, provider: "postgresql" });
		const mod: any = await compileAndExecute("double-fk.ts", code);
		expect((mod.contract ?? mod.default).domain).toBeDefined();
	}, 30_000);
});
