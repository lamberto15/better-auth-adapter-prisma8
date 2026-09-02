import { open, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
// Step 4's fallback. Imported rather than re-declared so the literal has
// exactly one home — see the note on it in ./schema-generator for why it is a
// last resort rather than the normal way a contract path is chosen.
import { DEFAULT_CONTRACT_PATH } from "./schema-generator";

/**
 * Prisma 8 has two contract authoring modes and the *file extension* is what
 * selects between them:
 *
 *   - `psl`        → `contract.prisma`, Prisma Schema Language (the mode
 *                    `create-prisma` scaffolds, and what our generator emits)
 *   - `typescript` → `contract.ts`, the `defineContract` builder from
 *                    `@prisma/orm-postgres/contract-builder`
 *
 * A project declares exactly ONE contract source. Guessing wrong doesn't just
 * produce a file in the wrong dialect — it produces a *second* contract, which
 * Prisma's docs explicitly warn against.
 */
export type ContractAuthoringMode = "psl" | "typescript";

export interface DiscoveredContract {
	/**
	 * Where to write. Paths are **relative to `cwd`** (POSIX separators), which
	 * is what `@better-auth/cli` expects and what the adapter already returns
	 * for its default. The one exception is an explicit `--output`: that string
	 * is handed back verbatim, absolute or not, because the user named the file
	 * and rewriting their argument would be surprising. A discovered path that
	 * escapes `cwd` (a config pointing at `../shared/contract.prisma`) also
	 * stays absolute, since there is no sane relative form for it.
	 */
	path: string;
	mode: ContractAuthoringMode;
	/** How this was determined — for logging and for the emitted file header. */
	source: "explicit" | "config" | "existing-file" | "default";
	/** Contents of the existing contract, when one is already there. */
	existingSource?: string | undefined;
}

/**
 * Where a project keeps `prisma.config.ts`. Only the project root is searched:
 * that is the only place Prisma itself looks for it.
 *
 * `.cjs` is accepted alongside `.js`/`.mjs` purely because reading a file that
 * might not be there is free — we never execute any of these.
 */
const CONFIG_FILENAMES = [
	"prisma.config.ts",
	"prisma.config.mts",
	"prisma.config.cts",
	"prisma.config.js",
	"prisma.config.mjs",
	"prisma.config.cjs",
] as const;

/**
 * Conventional contract locations, probed in order — the first hit wins.
 *
 * The ordering encodes the both-files-exist tie-break: **`.prisma` beats
 * `.ts`**. Reaching this step at all means there was no parseable
 * `prisma.config.ts`, so a project with both files on disk is already
 * ambiguous and we have to pick. PSL wins because (a) it is Prisma's
 * recommended mode and what `create-prisma` scaffolds, and (b) our generator
 * emits PSL natively, so writing there *merges* into the user's contract,
 * whereas targeting the `.ts` file can only ever produce the
 * "port this by hand" redirect. Guessing PSL and being wrong costs the user a
 * stale reference file; guessing TypeScript and being wrong costs them a
 * missed merge. Within each extension, `prisma/` beats the project root.
 */
const CONVENTIONAL_PATHS = [
	"prisma/contract.prisma",
	"contract.prisma",
	"prisma/contract.ts",
	"contract.ts",
] as const;


/**
 * `.ts`/`.mts`/`.cts` mean the TypeScript builder; everything else is treated
 * as PSL. Unknown extensions fall to PSL deliberately: the generator emits
 * PSL, so that is the only mode we can honour without inventing a dialect.
 */
export function modeFromExtension(filePath: string): ContractAuthoringMode {
	return /\.[mc]?ts$/i.test(filePath) ? "typescript" : "psl";
}

/**
 * Checks and reads through the *same* open file descriptor, rather than
 * `stat(path)` followed by a separate `readFile(path)` — CodeQL flags that
 * pairing as a TOCTOU race (`js/file-system-race`): between the two calls,
 * whatever the path resolves to can change (swapped for a symlink, replaced
 * entirely), and the read would silently operate on something other than
 * what was just checked. A `FileHandle` pins both operations to the exact
 * inode that was opened, independent of anything that happens to the path
 * afterward.
 */
async function readIfExists(absolutePath: string): Promise<string | undefined> {
	let handle;
	try {
		handle = await open(absolutePath, "r");
		const info = await handle.stat();
		if (!info.isFile()) return undefined;
		return await handle.readFile("utf8");
	} catch {
		// ENOENT / ENOTDIR / EACCES all mean the same thing here: nothing to
		// merge into. Discovery must never be the thing that fails codegen.
		return undefined;
	} finally {
		await handle?.close();
	}
}

/**
 * Strips `//` and `/* *\/` comments while respecting string literals, so a
 * decoy inside a comment (`// contract: "./old/contract.ts"`) is removed but
 * a `//` inside a URL string is not. A full JS parse would be overkill; the
 * only thing downstream cares about is one `contract:` key.
 */
function stripComments(source: string): string {
	let out = "";
	let index = 0;
	// One of: null (code), '"' / "'" / "`" (inside that string), "line", "block".
	let state: string | null = null;

	while (index < source.length) {
		const char = source[index] as string;
		const next = source[index + 1];

		if (state === "line") {
			if (char === "\n") {
				state = null;
				out += char;
			}
			index += 1;
			continue;
		}
		if (state === "block") {
			if (char === "*" && next === "/") {
				state = null;
				index += 2;
			} else {
				// Keep newlines so line/column-ish reasoning stays sane.
				if (char === "\n") out += char;
				index += 1;
			}
			continue;
		}
		if (state !== null) {
			// Inside a string literal: copy through, honouring escapes.
			out += char;
			if (char === "\\") {
				const escaped = source[index + 1];
				if (escaped !== undefined) out += escaped;
				index += 2;
				continue;
			}
			if (char === state) state = null;
			index += 1;
			continue;
		}
		if (char === "/" && next === "/") {
			state = "line";
			index += 2;
			continue;
		}
		if (char === "/" && next === "*") {
			state = "block";
			index += 2;
			continue;
		}
		if (char === '"' || char === "'" || char === "`") {
			state = char;
			out += char;
			index += 1;
			continue;
		}
		out += char;
		index += 1;
	}

	return out;
}

/**
 * Pulls the `contract:` string out of a `prisma.config.ts` **without executing
 * it**. Running a project's config in a codegen path means importing packages
 * that may not resolve (and running arbitrary user code) for the sake of one
 * string.
 *
 * The key is matched wherever it appears — top level or nested inside
 * `ormConfig({ ... })` — with any quoting and any whitespace. A value that
 * isn't a static string literal (an identifier, `path.join(...)`, a template
 * literal with an interpolation) is reported as *not found*: a wrong guess
 * here creates the duplicate-contract situation this module exists to prevent,
 * so falling through to disk probing is strictly safer.
 *
 * Exported for tests.
 */
export function parseContractPathFromConfig(
	configSource: string,
): string | undefined {
	const code = stripComments(configSource);
	// `contract` as a whole word, then `:`, then immediately a quote. Anything
	// else after the colon (identifier, call expression) simply fails to match.
	const match = /(?:^|[^\w$])contract\s*:\s*(["'`])((?:\\.|(?!\1)[^\\])*)\1/.exec(
		code,
	);
	if (!match) return undefined;

	const quote = match[1] as string;
	const raw = match[2] as string;

	// A template literal with `${...}` is computed at runtime — unresolvable.
	if (quote === "`" && /\$\{/.test(raw)) return undefined;
	// Multi-line values are never a plausible path; bail rather than guess.
	if (raw.includes("\n")) return undefined;

	const value = raw.trim();
	return value.length > 0 ? value : undefined;
}

/** Renders an absolute path the way `DiscoveredContract.path` promises. */
function toCwdRelative(cwd: string, absolutePath: string): string {
	const rel = relative(cwd, absolutePath);
	// Empty (the path *is* cwd) or escaping upwards → keep it absolute.
	if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return absolutePath;
	return rel.split(sep).join("/");
}

async function finalize(
	cwd: string,
	returnedPath: string,
	mode: ContractAuthoringMode,
	source: DiscoveredContract["source"],
): Promise<DiscoveredContract> {
	const absolute = isAbsolute(returnedPath)
		? returnedPath
		: resolve(cwd, returnedPath);
	const existingSource = await readIfExists(absolute);
	// `exactOptionalPropertyTypes` — only attach the key when there is a value,
	// so `"existingSource" in result` stays meaningful.
	return existingSource === undefined
		? { path: returnedPath, mode, source }
		: { path: returnedPath, mode, source, existingSource };
}

/**
 * Works out which contract source a Prisma 8 project actually uses, so
 * `createSchema` writes into it instead of inventing a second one.
 *
 * Precedence, highest first:
 *
 *   1. `file`            — the user passed `--output`; always wins.
 *   2. `prisma.config.ts` — the authoritative declaration. Gives us both the
 *                          folder (no duplicates) and the mode (extension).
 *   3. an existing file  — conventional locations probed on disk.
 *   4. default           — `prisma/contract.prisma`.
 */
export async function discoverContract(opts: {
	/** The `--output` path, when the user passed one. Always wins. */
	file?: string | undefined;
	/** Defaults to `process.cwd()`. */
	cwd?: string | undefined;
}): Promise<DiscoveredContract> {
	const cwd = opts.cwd ?? process.cwd();

	// ── 1. Explicit --output ────────────────────────────────────────────────
	// Returned verbatim: the user named the file, so neither the config nor
	// anything on disk gets a vote.
	const explicit = opts.file?.trim();
	if (explicit !== undefined && explicit.length > 0) {
		return finalize(cwd, explicit, modeFromExtension(explicit), "explicit");
	}

	// ── 2. prisma.config.ts ─────────────────────────────────────────────────
	for (const filename of CONFIG_FILENAMES) {
		const configPath = join(cwd, filename);
		const configSource = await readIfExists(configPath);
		if (configSource === undefined) continue;

		const declared = parseContractPathFromConfig(configSource);
		// A config that exists but declares nothing resolvable is not an error;
		// it just doesn't answer the question. Keep looking, then fall through.
		if (declared === undefined) continue;

		// Relative to the *config file's* directory, not to cwd — that is how
		// Prisma resolves it. `resolve` absorbs a leading "./" for free and
		// leaves an already-absolute value alone.
		const absolute = resolve(dirname(configPath), declared);
		return finalize(
			cwd,
			toCwdRelative(cwd, absolute),
			modeFromExtension(absolute),
			"config",
		);
	}

	// ── 3. An existing contract on disk ─────────────────────────────────────
	for (const candidate of CONVENTIONAL_PATHS) {
		const absolute = resolve(cwd, candidate);
		const info = await stat(absolute).catch(() => undefined);
		if (info?.isFile() !== true) continue;
		return finalize(cwd, candidate, modeFromExtension(candidate), "existing-file");
	}

	// ── 4. Default ──────────────────────────────────────────────────────────
	return finalize(cwd, DEFAULT_CONTRACT_PATH, "psl", "default");
}
