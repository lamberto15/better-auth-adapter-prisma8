import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
	discoverContract,
	modeFromExtension,
	parseContractPathFromConfig,
} from "./contract-discovery";

/**
 * Real temp directories throughout — discovery is entirely about what is on
 * disk, so mocking `fs` would only test the mock. Each test gets a fresh
 * project root so probe order can't leak between cases.
 */
let dir: string;

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "contract-discovery-"));
});

afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

/** Writes a file, creating parent directories as needed. */
async function write(relativePath: string, contents: string): Promise<string> {
	const absolute = join(dir, relativePath);
	await mkdir(join(absolute, ".."), { recursive: true });
	await writeFile(absolute, contents, "utf8");
	return absolute;
}

/** A realistic prisma.config.ts pointing `contract` at `contractPath`. */
function configSource(contractPath: string): string {
	return [
		'import { definePrismaConfig } from "prisma/config";',
		'import { defineConfig as ormConfig } from "@prisma/orm-postgres/config";',
		"",
		"export default definePrismaConfig({",
		"	orm: ormConfig({",
		`		contract: "${contractPath}",`,
		"	}),",
		"});",
		"",
	].join("\n");
}

describe("modeFromExtension", () => {
	it("maps .ts/.mts/.cts to the TypeScript builder", () => {
		expect(modeFromExtension("prisma/contract.ts")).toBe("typescript");
		expect(modeFromExtension("prisma/contract.mts")).toBe("typescript");
		expect(modeFromExtension("prisma/contract.cts")).toBe("typescript");
	});

	it("maps .prisma — and anything unrecognised — to PSL", () => {
		expect(modeFromExtension("prisma/contract.prisma")).toBe("psl");
		// The generator can only emit PSL, so an unknown extension has to fall
		// there rather than invent a dialect.
		expect(modeFromExtension("prisma/contract")).toBe("psl");
	});

	it("is not fooled by .ts appearing mid-path", () => {
		expect(modeFromExtension("src/ts/contract.prisma")).toBe("psl");
	});
});

describe("step 1 — an explicit --output always wins", () => {
	it("beats a prisma.config.ts that says otherwise", async () => {
		await write("prisma.config.ts", configSource("./db/schema/contract.ts"));

		const result = await discoverContract({
			file: "custom/my-contract.prisma",
			cwd: dir,
		});

		expect(result).toMatchObject({
			path: "custom/my-contract.prisma",
			mode: "psl",
			source: "explicit",
		});
	});

	it("beats an existing contract on disk", async () => {
		await write("prisma/contract.prisma", "model User {}\n");

		const result = await discoverContract({ file: "other.prisma", cwd: dir });
		expect(result.source).toBe("explicit");
		expect(result.path).toBe("other.prisma");
	});

	it("takes its mode from the extension the user gave", async () => {
		const result = await discoverContract({ file: "db/contract.ts", cwd: dir });
		expect(result.mode).toBe("typescript");
	});

	it("is returned verbatim, absolute paths included", async () => {
		const absolute = join(dir, "somewhere", "contract.prisma");
		const result = await discoverContract({ file: absolute, cwd: dir });
		expect(result.path).toBe(absolute);
	});

	it("treats an empty/whitespace --output as not passed", async () => {
		const result = await discoverContract({ file: "   ", cwd: dir });
		expect(result.source).toBe("default");
	});
});

describe("step 2 — prisma.config.ts", () => {
	it("reads the declared path and folder", async () => {
		await write("prisma.config.ts", configSource("./prisma/contract.prisma"));

		expect(await discoverContract({ cwd: dir })).toMatchObject({
			path: "prisma/contract.prisma",
			mode: "psl",
			source: "config",
		});
	});

	it("detects TypeScript mode from the declared extension", async () => {
		await write("prisma.config.ts", configSource("./prisma/contract.ts"));

		expect(await discoverContract({ cwd: dir })).toMatchObject({
			path: "prisma/contract.ts",
			mode: "typescript",
			source: "config",
		});
	});

	it("resolves a path outside the default folder, relative to the config", async () => {
		// The whole point of step 2: a project keeping its contract at
		// db/schema/ must not get a second one written to prisma/.
		await write("prisma.config.ts", configSource("./db/schema/contract.ts"));

		expect(await discoverContract({ cwd: dir })).toMatchObject({
			path: "db/schema/contract.ts",
			mode: "typescript",
			source: "config",
		});
	});

	it("handles a declared path with no leading ./", async () => {
		await write("prisma.config.ts", configSource("db/contract.prisma"));
		expect((await discoverContract({ cwd: dir })).path).toBe("db/contract.prisma");
	});

	it("beats an existing contract sitting in the conventional location", async () => {
		await write("prisma/contract.prisma", "model User {}\n");
		await write("prisma.config.ts", configSource("./db/contract.ts"));

		const result = await discoverContract({ cwd: dir });
		expect(result.source).toBe("config");
		expect(result.path).toBe("db/contract.ts");
	});

	it("accepts .mts, .cts, .js and .mjs config files", async () => {
		for (const [filename, declared] of [
			["prisma.config.mts", "./a/contract.prisma"],
			["prisma.config.cts", "./b/contract.prisma"],
			["prisma.config.js", "./c/contract.prisma"],
			["prisma.config.mjs", "./d/contract.prisma"],
		] as const) {
			const root = await mkdtemp(join(tmpdir(), "contract-discovery-cfg-"));
			await writeFile(join(root, filename), configSource(declared), "utf8");

			const result = await discoverContract({ cwd: root });
			expect(result.source).toBe("config");
			expect(result.path).toBe(declared.slice(2));

			await rm(root, { recursive: true, force: true });
		}
	});

	it("accepts single quotes, backticks and sprawling whitespace", async () => {
		await write(
			"prisma.config.ts",
			"export default definePrismaConfig({ orm: ormConfig({\n\tcontract\n\t\t:   './db/single.prisma' }) });\n",
		);
		expect((await discoverContract({ cwd: dir })).path).toBe("db/single.prisma");

		await write(
			"prisma.config.ts",
			"export default { orm: ormConfig({ contract: `./db/tick.ts` }) };\n",
		);
		expect((await discoverContract({ cwd: dir })).path).toBe("db/tick.ts");
	});

	it("ignores a decoy inside // and /* */ comments", async () => {
		await write(
			"prisma.config.ts",
			[
				'import { definePrismaConfig } from "prisma/config";',
				"",
				"export default definePrismaConfig({",
				"	orm: ormConfig({",
				'		// contract: "./old/decoy.prisma",',
				"		/* contract: './older/decoy.ts' */",
				'		contract: "./db/real.ts",',
				"	}),",
				"});",
			].join("\n"),
		);

		expect(await discoverContract({ cwd: dir })).toMatchObject({
			path: "db/real.ts",
			mode: "typescript",
			source: "config",
		});
	});

	it("falls through when the only contract: is commented out", async () => {
		await write(
			"prisma.config.ts",
			'export default definePrismaConfig({\n\t// contract: "./db/decoy.prisma",\n});\n',
		);

		expect((await discoverContract({ cwd: dir })).source).toBe("default");
	});

	it("falls through when the value is a variable rather than a literal", async () => {
		await write(
			"prisma.config.ts",
			'const contractPath = "./db/contract.ts";\nexport default definePrismaConfig({ orm: ormConfig({ contract: contractPath }) });\n',
		);

		// Guessing here is how you end up with two contract sources; not
		// answering is the safe failure.
		expect((await discoverContract({ cwd: dir })).source).toBe("default");
	});

	it("falls through when the value is a path.join(...) call", async () => {
		await write(
			"prisma.config.ts",
			'import path from "node:path";\nexport default definePrismaConfig({ orm: ormConfig({ contract: path.join("db", "contract.prisma") }) });\n',
		);

		expect((await discoverContract({ cwd: dir })).source).toBe("default");
	});

	it("falls through when the value is an interpolated template literal", async () => {
		await write(
			"prisma.config.ts",
			"export default definePrismaConfig({ orm: ormConfig({ contract: `${root}/contract.prisma` }) });\n",
		);

		expect((await discoverContract({ cwd: dir })).source).toBe("default");
	});

	it("still finds an existing file when the config is unparseable", async () => {
		await write("prisma.config.ts", "export default { orm: ormConfig({}) };\n");
		await write("prisma/contract.ts", "export const contract = {};\n");

		const result = await discoverContract({ cwd: dir });
		expect(result.source).toBe("existing-file");
		expect(result.path).toBe("prisma/contract.ts");
	});

	it("does not mistake a similarly-named key for contract", async () => {
		await write(
			"prisma.config.ts",
			'export default { orm: ormConfig({ myContract: "./db/nope.prisma" }) };\n',
		);

		expect((await discoverContract({ cwd: dir })).source).toBe("default");
	});
});

describe("parseContractPathFromConfig", () => {
	it("returns undefined for a config with no contract key at all", () => {
		expect(parseContractPathFromConfig("export default {};")).toBeUndefined();
	});

	it("does not strip a // that lives inside a string literal", () => {
		expect(
			parseContractPathFromConfig(
				'const url = "https://example.com"; export default { contract: "./db/x.prisma" };',
			),
		).toBe("./db/x.prisma");
	});
});

describe("step 3 — an existing contract on disk", () => {
	it("finds prisma/contract.prisma", async () => {
		await write("prisma/contract.prisma", "model User {}\n");

		expect(await discoverContract({ cwd: dir })).toMatchObject({
			path: "prisma/contract.prisma",
			mode: "psl",
			source: "existing-file",
		});
	});

	it("finds prisma/contract.ts and reports TypeScript mode", async () => {
		await write("prisma/contract.ts", "export const contract = {};\n");

		expect(await discoverContract({ cwd: dir })).toMatchObject({
			path: "prisma/contract.ts",
			mode: "typescript",
			source: "existing-file",
		});
	});

	it("finds a root-level contract.prisma", async () => {
		await write("contract.prisma", "model User {}\n");

		expect(await discoverContract({ cwd: dir })).toMatchObject({
			path: "contract.prisma",
			source: "existing-file",
		});
	});

	it("finds a root-level contract.ts", async () => {
		await write("contract.ts", "export const contract = {};\n");

		expect(await discoverContract({ cwd: dir })).toMatchObject({
			path: "contract.ts",
			mode: "typescript",
			source: "existing-file",
		});
	});

	it("prefers .prisma when both a .prisma and a .ts exist", async () => {
		// Documented tie-break: PSL wins. Our generator emits PSL, so writing
		// there merges into the user's contract; picking the .ts could only
		// produce a hand-port reference file.
		await write("prisma/contract.prisma", "model User {}\n");
		await write("prisma/contract.ts", "export const contract = {};\n");

		expect(await discoverContract({ cwd: dir })).toMatchObject({
			path: "prisma/contract.prisma",
			mode: "psl",
			source: "existing-file",
		});
	});

	it("prefers a root .prisma over a prisma/ .ts", async () => {
		// Extension is the stronger signal: getting the *mode* wrong is worse
		// than getting the folder wrong.
		await write("contract.prisma", "model User {}\n");
		await write("prisma/contract.ts", "export const contract = {};\n");

		expect((await discoverContract({ cwd: dir })).path).toBe("contract.prisma");
	});

	it("prefers prisma/ over the project root within one extension", async () => {
		await write("prisma/contract.ts", "export const contract = {};\n");
		await write("contract.ts", "export const contract = {};\n");

		expect((await discoverContract({ cwd: dir })).path).toBe("prisma/contract.ts");
	});

	it("ignores a directory that happens to be named contract.prisma", async () => {
		await mkdir(join(dir, "prisma", "contract.prisma"), { recursive: true });

		expect((await discoverContract({ cwd: dir })).source).toBe("default");
	});
});

describe("step 4 — the default", () => {
	it("returns prisma/contract.prisma for an empty project", async () => {
		expect(await discoverContract({ cwd: dir })).toMatchObject({
			path: "prisma/contract.prisma",
			mode: "psl",
			source: "default",
		});
	});

	it("carries no existingSource when nothing is there", async () => {
		const result = await discoverContract({ cwd: dir });
		expect(result.existingSource).toBeUndefined();
		expect("existingSource" in result).toBe(false);
	});
});

describe("existingSource", () => {
	it("is populated for an explicit --output that already exists", async () => {
		await write("custom/contract.prisma", "model User {\n\tid String @id\n}\n");

		const result = await discoverContract({
			file: "custom/contract.prisma",
			cwd: dir,
		});
		expect(result.existingSource).toContain("model User {");
	});

	it("is populated for a config-declared path that already exists", async () => {
		await write("prisma.config.ts", configSource("./db/schema/contract.ts"));
		await write("db/schema/contract.ts", "export const contract = 1;\n");

		const result = await discoverContract({ cwd: dir });
		expect(result).toMatchObject({ path: "db/schema/contract.ts", source: "config" });
		expect(result.existingSource).toBe("export const contract = 1;\n");
	});

	it("is absent for a config-declared path that does not exist yet", async () => {
		await write("prisma.config.ts", configSource("./db/schema/contract.ts"));

		const result = await discoverContract({ cwd: dir });
		expect(result.source).toBe("config");
		expect(result.existingSource).toBeUndefined();
	});

	it("is populated for a discovered existing file", async () => {
		await write("prisma/contract.prisma", "model Session {}\n");

		const result = await discoverContract({ cwd: dir });
		expect(result.existingSource).toBe("model Session {}\n");
	});
});
