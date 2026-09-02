import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi, afterAll } from "vitest";
vi.mock("@prisma/orm-postgres/orm-client", () => ({ and: () => 1, or: () => 1, not: () => 1 }));
import { generateContractTypeScript } from "./typescript-contract-generator";
import { mergeTypeScriptContract } from "./typescript-contract-merge";
import type { BetterAuthDBSchema } from "@better-auth/core/db";

const directory = join(process.cwd(), "node_modules", ".contract-check-prove");
const tscArgs = (path: string) => [
	join(process.cwd(), "node_modules", "typescript", "bin", "tsc"),
	"--noEmit", "--strict", "--target", "ES2022", "--module", "ESNext",
	"--moduleResolution", "Bundler", "--skipLibCheck", path,
];

const madeUpSchema = {
	widget: {
		modelName: "widget",
		fields: {
			serialNumber: { type: "string", required: true, unique: true, fieldName: "serial_no" },
			wattage: { type: "number", required: true },
			isRecalled: { type: "boolean", required: false, defaultValue: false },
			purchasedAt: { type: "date", required: true },
			manufacturerId: { type: "string", required: true, references: { model: "manufacturer", field: "id", onDelete: "restrict" } },
		},
	},
	manufacturer: { modelName: "manufacturer", fields: { legalName: { type: "string", required: true }, country: { type: "string", required: false } } },
} satisfies BetterAuthDBSchema;

describe("proves the generator is schema-generic, not hardcoded to Better Auth's core tables", () => {
	mkdirSync(directory, { recursive: true });
	afterAll(() => rmSync(directory, { recursive: true, force: true }));

	it("generates a correct fresh contract for field/model names it has never seen", () => {
		const code = generateContractTypeScript({ tables: madeUpSchema, provider: "postgresql" });
		expect(code).toContain('model("Widget"');
		expect(code).toContain('model("Manufacturer"');
		expect(code).toContain("serial_no: field.text().unique()");
		expect(code).toContain('.column("serial_no")');
		expect(code).toContain("wattage: field.int()");
		expect(code).toContain("isRecalled: field.boolean().optional()");
		expect(code).toContain("rel.belongsTo(Manufacturer");
		expect(code).toContain("rel.hasMany(Widget");
		expect(code).toContain('onDelete: "restrict"');

		const path = join(directory, "fresh.ts");
		writeFileSync(path, code, "utf8");
		execFileSync(process.execPath, tscArgs(path), { stdio: "pipe", encoding: "utf8" });
	});

	it("merges a NEW made-up model into a hand-written contract with unfamiliar field names", async () => {
		const existing = [
			"import { defineContract } from '@prisma/orm-postgres/contract-builder';",
			"export const contract = defineContract({}, ({ field, model }) => {",
			"  const Manufacturer = model('Manufacturer', {",
			"    fields: { id: field.text().id(), legalName: field.text(), notes: field.text().optional() },",
			"  });",
			"  return { models: { Manufacturer } };",
			"});",
		].join("\n");

		const result = await mergeTypeScriptContract({
			existingSource: existing,
			generatorOptions: { tables: madeUpSchema, provider: "postgresql" },
		});

		expect(result.unsupportedReason).toBeUndefined();
		expect(result.code).toBeTruthy();
		expect(result.code).toContain("notes: field.text().optional()"); // untouched
		expect(result.code).toContain('model("Widget"');
		expect(result.code).toContain("rel.hasMany(Widget");

		const path = join(directory, "merged.ts");
		writeFileSync(path, result.code!, "utf8");
		execFileSync(process.execPath, tscArgs(path), { stdio: "pipe", encoding: "utf8" });

		const mod: any = await import(/* @vite-ignore */ path);
		expect((mod.contract ?? mod.default).domain).toBeDefined();
	}, 30_000);
});
