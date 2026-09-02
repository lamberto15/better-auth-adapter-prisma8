import type {
	BetterAuthDBSchema,
	DBFieldAttribute,
	DBTableIndex,
} from "@better-auth/core/db";
import type { DBAdapterSchemaCreation } from "@better-auth/core/db/adapter";
import { BetterAuthError } from "@better-auth/core/error";
import type { ContractAuthoringMode } from "./contract-discovery";
import { modeFromExtension } from "./contract-discovery";
import { mergeTypeScriptContract } from "./typescript-contract-merge";
import { generateContractTypeScript } from "./typescript-contract-generator";

/**
 * Last-resort fallback only — **not** how the contract path is normally
 * decided.
 *
 * A Prisma 8 project declares exactly one contract source, and
 * `prisma.config.ts` names it (`contract: "./prisma/contract.prisma"`). That
 * path is the project's decision, and it can be anywhere: `db/schema/`, the
 * repo root, a `.ts` file rather than a `.prisma` one. Resolving it is
 * `discoverContract()`'s job in `./contract-discovery`, which the adapter's
 * `createSchema` calls before it gets here — writing to a hardcoded path
 * would plant a second, competing contract beside the project's real one.
 *
 * This constant is what `discoverContract` itself falls back to when there is
 * no config, no `--output`, and no contract file already on disk: it matches
 * what `create-prisma` scaffolds, so it is the right guess for a fresh
 * project. It stays exported because the generator can be called directly,
 * without an adapter or a project around it.
 */
export const DEFAULT_CONTRACT_PATH = "prisma/contract.prisma";

export interface GenerateContractOptions {
	/** The resolved Better Auth schema (`getAuthTables(options)`). */
	tables: BetterAuthDBSchema;
	/**
	 * Which SQL target the contract is for. Prisma Next configures the
	 * provider in `prisma.config.ts`, not in the contract, so this only
	 * changes *type* selection here (scalar lists and `Json` are Postgres-only).
	 */
	provider: "postgresql" | "sqlite";
	/** Mirrors `Prisma8AdapterConfig.usePlural`. @default false */
	usePlural?: boolean | undefined;
	/** Path the user passed to `generate`. @default DEFAULT_CONTRACT_PATH */
	file?: string | undefined;
	/** Existing `contract.prisma` source, when merging into a user's file. */
	existingSchema?: string | undefined;
	/**
	 * Mirrors `advanced.database.useNumberId`. Better Auth's `id` column is
	 * not part of `tables[x].fields`, so the caller has to tell us which of
	 * the two id shapes to emit. `false` emits an application-generated
	 * `String @id`; `true` emits `Int @id @default(autoincrement())`.
	 * @default false
	 */
	useNumberId?: boolean | undefined;
	/**
	 * Mirrors `advanced.database.generateId === "uuid"` combined with the
	 * adapter's `supportsUUIDs: true` on PostgreSQL. Emits
	 * `String @id @default(uuid(7))` instead of a bare `String @id` — the ORM
	 * runtime mints a time-ordered (v7) UUID before the insert, instead of
	 * Better Auth generating one in application code.
	 *
	 * `uuid(7)` is a registered default function on the Postgres target
	 * (`postgresDefaultFunctionRegistryEntries` in
	 * `@prisma/orm-target-postgres`'s control adapter — confirmed by reading
	 * that source directly, since `uuid(7)` never appears in Prisma 8's
	 * published docs), and it lowers to the exact same
	 * `{ kind: "generator", id: "uuidv7" }` representation as the TypeScript
	 * builder's `field.id.uuidv7String()` (see
	 * `typescript-contract-generator.ts`'s `idExpressionFor`), so the two
	 * authoring modes generate ids identically.
	 *
	 * Kept a `String` column (not a native `Uuid` type) deliberately: every
	 * foreign key Better Auth declares is typed `String` (it never sees the
	 * referenced column's real type). This does *not* need the same
	 * foreign-key override `useNumberId` needs below — verified directly that
	 * Postgres's "character" type family (which is what this actually
	 * resolves to on the Postgres target) interoperates with plain `String`
	 * foreign keys for both the FK constraint and equality lookups, unlike
	 * `Int` vs `String`, which Postgres rejects outright.
	 * Ignored if `useNumberId` is also `true` — the two are driven by the same
	 * mutually exclusive `generateId` setting and should never both be set.
	 * @default false
	 */
	useUUID?: boolean | undefined;
}

/**
 * Prisma Next referential actions. Better Auth spells its `onDelete` values
 * as lowercase, space-separated strings; Prisma spells them PascalCase.
 */
const REFERENTIAL_ACTIONS: Record<string, string> = {
	"no action": "NoAction",
	restrict: "Restrict",
	cascade: "Cascade",
	"set null": "SetNull",
	"set default": "SetDefault",
};

/**
 * Mirrors `toContractModelName` in `src/prisma8-adapter.ts` exactly — that
 * function is what resolves a Better Auth model name to a `db.orm.<Model>`
 * root at runtime, so the contract this generator emits has to agree with it
 * character for character. Note it is a *first-letter uppercase*, not a
 * general PascalCase: a custom `modelName: "auth_user"` becomes `Auth_user`,
 * not `AuthUser`.
 *
 * Also note what gets capitalized: Better Auth's adapter factory applies
 * `getModelName` (custom `modelName` + `usePlural`) *before* handing the name
 * to the adapter, so the contract model is derived from the physical table
 * name, and `@@map` then pins that same physical name as the table.
 */
function toContractModelName(model: string): string {
	return model.length === 0 ? model : model[0]!.toUpperCase() + model.slice(1);
}

function lowerFirst(value: string): string {
	return value.length === 0 ? value : value[0]!.toLowerCase() + value.slice(1);
}

/** The physical table name Better Auth will address this model by. */
function tableNameFor(
	modelKey: string,
	table: BetterAuthDBSchema[string],
	usePlural: boolean,
): string {
	const base = table.modelName || modelKey;
	return usePlural ? `${base}s` : base;
}

/**
 * The physical column name. This doubles as the *contract field name*: the
 * adapter resolves fields through `getFieldName` (which returns the physical
 * `fieldName`) and then indexes the ORM field proxy with it, so the contract
 * must declare fields under their physical names for `.where((u) => u.x…)` to
 * resolve. `@map` is still emitted when the logical and physical names differ,
 * so the mapping stays visible (and pinned) in the contract.
 */
function columnNameFor(fieldKey: string, field: DBFieldAttribute): string {
	return field.fieldName || fieldKey;
}

interface EmittedField {
	name: string;
	type: string;
	attributes: string[];
	/** Trailing `// …` note, without the slashes. */
	note?: string | undefined;
}

interface ResolvedModel {
	/** Better Auth's logical schema key, e.g. `user`. */
	key: string;
	/** Physical table name, e.g. `users`. */
	tableName: string;
	/** Contract model name, e.g. `Users`. */
	contractName: string;
	fields: EmittedField[];
	/** `@@unique` / `@@index` lines, already rendered. */
	blockAttributes: string[];
	/** Back-relation fields other models contribute to this one. */
	backRelations: EmittedField[];
}

/**
 * The Prisma scalar for a Better Auth field type, plus an optional note when
 * the provider forces a lossy choice.
 */
function scalarTypeFor(
	field: DBFieldAttribute,
	provider: GenerateContractOptions["provider"],
): { type: string; note?: string; isList: boolean } {
	const type = field.type;

	// `Array<LiteralString>` — a string-literal union (e.g. ["active","revoked"]).
	// Deliberately emitted as `String` on both providers rather than a Prisma
	// `enum` block: Better Auth's literals are arbitrary strings (hyphens,
	// dots, spaces all occur in plugin schemas) and PSL enum members must be
	// bare identifiers, so a generated enum would be invalid for a large
	// fraction of real schemas. The allowed values are recorded in a comment.
	if (Array.isArray(type)) {
		return {
			type: "String",
			note: `one of: ${type.join(", ")}`,
			isList: false,
		};
	}

	switch (type) {
		case "string":
			return { type: "String", isList: false };
		case "number":
			return { type: field.bigint ? "BigInt" : "Int", isList: false };
		case "boolean":
			return { type: "Boolean", isList: false };
		case "date":
			return { type: "DateTime", isList: false };
		case "json":
			// SQLite has no first-class Json in the Prisma Next type system;
			// store the serialized document as TEXT instead of emitting a type
			// the contract can't satisfy.
			return provider === "postgresql"
				? { type: "Json", isList: false }
				: {
						type: "String",
						note: "json — SQLite has no native Json type; stored as serialized TEXT",
						isList: false,
					};
		case "string[]":
		case "number[]": {
			const element = type === "string[]" ? "String" : "Int";
			// Scalar lists are a Postgres-only feature in Prisma.
			return provider === "postgresql"
				? { type: `${element}[]`, isList: true }
				: {
						type: "String",
						note: `${type} — SQLite has no scalar lists; stored as a serialized TEXT value`,
						isList: false,
					};
		}
		default: {
			// Exhaustive over the documented `DBFieldType` union. A future core
			// release adding a type lands here rather than emitting nothing.
			const exhaustive: never = type;
			throw new Error(
				`Unsupported Better Auth field type: ${String(exhaustive)}`,
			);
		}
	}
}

/**
 * Renders a literal `defaultValue` as a Prisma `@default(...)`.
 *
 * Better Auth's own doc comment says `defaultValue` "will not create a default
 * value on the database level" — it applies it at write time. We still emit
 * `@default(...)` for *literal* primitives, because a literal is exactly the
 * thing a column default can express, and having it in the contract means a
 * column added by a later migration backfills instead of failing on existing
 * rows. Thunks (`() => new Date()`, `() => crypto.randomUUID()`) are never
 * called at generate time and never emitted — their value is per-write and
 * not a column default.
 */
function defaultAttributeFor(field: DBFieldAttribute): string | undefined {
	const value = field.defaultValue;
	if (typeof value === "function") return undefined;
	if (value === undefined || value === null) return undefined;
	if (typeof value === "boolean") return `@default(${value})`;
	if (typeof value === "number") return `@default(${value})`;
	if (typeof value === "string") return `@default(${JSON.stringify(value)})`;
	// Dates, arrays and JSON documents have no portable literal spelling in
	// PSL; leave them to Better Auth's write-time default.
	return undefined;
}

function renderIndex(
	index: DBTableIndex,
	resolveColumn: (logicalField: string) => string,
): string {
	const columns = index.fields.map(resolveColumn).join(", ");
	// `map:` names the physical constraint/index in the database, which is
	// what `DBTableIndex.name` documents ("portable database index name of at
	// most 63 UTF-8 bytes"). `name:` would only rename the client-side field.
	const mapArgument = index.name ? `, map: ${JSON.stringify(index.name)}` : "";
	return index.unique
		? `@@unique([${columns}]${mapArgument})`
		: `@@index([${columns}]${mapArgument})`;
}

/**
 * Resolves every table into the fields/attributes that will be emitted,
 * including the relation fields that one model contributes to another.
 */
function resolveModels(opts: GenerateContractOptions): ResolvedModel[] {
	const { tables, provider } = opts;
	const usePlural = opts.usePlural ?? false;
	const useNumberId = opts.useNumberId ?? false;
	const useUUID = !useNumberId && (opts.useUUID ?? false);
	const idType = useNumberId ? "Int" : "String";

	const keys = Object.keys(tables);
	// Deterministic model order: Better Auth's own `order` first (user=1,
	// session=2, account=3, verification=4), then the declaration order of the
	// remaining plugin tables. Stable for identical input, so the emitted file
	// is byte-identical across runs and diffs cleanly.
	const orderedKeys = keys
		.map((key, index) => ({ key, index }))
		.sort((a, b) => {
			const orderA = tables[a.key]!.order ?? Number.MAX_SAFE_INTEGER;
			const orderB = tables[b.key]!.order ?? Number.MAX_SAFE_INTEGER;
			if (orderA !== orderB) return orderA - orderB;
			return a.index - b.index;
		})
		.map((entry) => entry.key);

	const models = new Map<string, ResolvedModel>();
	for (const key of orderedKeys) {
		const table = tables[key]!;
		// A table opted out of migrations owns its own DDL; emitting a model
		// for it would make `prisma migrate` try to manage it anyway.
		if (table.disableMigrations) continue;
		const tableName = tableNameFor(key, table, usePlural);
		models.set(key, {
			key,
			tableName,
			contractName: toContractModelName(tableName),
			fields: [
				{
					name: "id",
					type: idType,
					attributes: useNumberId
						? ["@id", "@default(autoincrement())"]
						: useUUID
							? ["@id", "@default(uuid(7))"]
							: ["@id"],
					note:
						useNumberId || useUUID
							? undefined
							: "id is generated by Better Auth, not the database",
				},
			],
			blockAttributes: [],
			backRelations: [],
		});
	}

	const columnResolverFor = (modelKey: string) => (logicalField: string) => {
		if (logicalField === "id") return "id";
		const attribute = tables[modelKey]?.fields[logicalField];
		return attribute ? columnNameFor(logicalField, attribute) : logicalField;
	};

	for (const key of orderedKeys) {
		const model = models.get(key);
		if (!model) continue;
		const table = tables[key]!;
		const fieldIndexes: string[] = [];
		const relationFields: EmittedField[] = [];

		// Prisma requires an explicit `@relation("Name", ...)` — matched on
		// both sides — whenever a model has more than one relation to the
		// *same* target model (verified against Prisma's own documented rule:
		// "Ambiguous relation detected" / "Ambiguous self relation detected").
		// Two distinct target models each getting one relation is never
		// ambiguous (e.g. Session -> User and Account -> User don't collide
		// with each other), so this is a per-target count, not a per-model
		// one. A self-relation is *always* ambiguous even with a single field,
		// because Prisma still sees two endpoints (the scalar side and the
		// inferred list side) on the same model. Counted in its own pass
		// because a field processed early can't otherwise know a later field
		// will collide with it.
		const targetCounts = new Map<string, number>();
		for (const field of Object.values(table.fields)) {
			if (!field.references) continue;
			targetCounts.set(
				field.references.model,
				(targetCounts.get(field.references.model) ?? 0) + 1,
			);
		}
		const needsRelationName = (targetModelKey: string) =>
			targetModelKey === key || (targetCounts.get(targetModelKey) ?? 0) > 1;

		for (const [fieldKey, field] of Object.entries(table.fields)) {
			const column = columnNameFor(fieldKey, field);
			const scalar = scalarTypeFor(field, provider);
			const attributes: string[] = [];

			// Prisma rejects an optional scalar list (`String[]?`), so the `?`
			// only applies to non-list types.
			const optional = field.required === false && !scalar.isList;
			if (field.unique) attributes.push("@unique");
			const defaultAttribute = defaultAttributeFor(field);
			if (defaultAttribute) attributes.push(defaultAttribute);
			// `onUpdate` is documented as creating a database-level on-update
			// trigger, which is exactly `@updatedAt` for a timestamp column.
			if (field.onUpdate && scalar.type === "DateTime") {
				attributes.push("@updatedAt");
			}
			if (column !== fieldKey) {
				attributes.push(`@map(${JSON.stringify(column)})`);
			}

			const notes: string[] = [];
			if (scalar.note) notes.push(scalar.note);
			if (typeof field.defaultValue === "function") {
				notes.push("default is computed by Better Auth on write");
			}
			if (field.sortable) {
				// Postgres `text` already sorts and indexes fine; recording the
				// hint rather than emitting `@db.VarChar(n)` avoids inventing a
				// length the schema never specified.
				notes.push("sortable");
			}

			// The foreign-key side of a relation: the FK scalar is the field
			// being built here; the `@relation` field goes after all scalars,
			// and the matching list field lands on the referenced model.
			const references = field.references;
			const target = references ? models.get(references.model) : undefined;
			if (references && !target) {
				// The referenced table is disabled or absent — note it on the FK
				// column rather than emitting a dangling relation.
				notes.push(
					`references ${references.model}.${references.field} (model not emitted)`,
				);
			} else if (references && target) {
				// Better Auth always declares foreign keys as `type: "string"`,
				// even under `useNumberId`, because it never sees the column
				// type. Prisma requires the FK scalar to match the referenced
				// column exactly, so the id type wins here.
				if (references.field === "id") scalar.type = idType;
				const action =
					REFERENTIAL_ACTIONS[references.onDelete ?? "cascade"] ?? "Cascade";
				const targetColumn = columnResolverFor(references.model)(
					references.field,
				);

				// `userId` -> `user`; anything else falls back to the target
				// model name so the field is still readable.
				const stem = column.endsWith("Id")
					? column.slice(0, -2)
					: lowerFirst(target.contractName);
				const taken = new Set(
					[...model.fields, ...relationFields].map((f) => f.name),
				);
				let relationName =
					stem.length > 0 ? stem : lowerFirst(target.contractName);
				if (taken.has(relationName) || relationName === column) {
					relationName = `${relationName}Ref`;
				}

				// The disambiguation name Prisma requires whenever this model
				// has more than one relation to `target` — including a
				// self-relation, which always needs one. Keyed by FK column
				// (unique within a model by definition) rather than just the
				// model name, so two relations between the *same* pair (e.g.
				// an audit table's `actorId` and `subjectId`, both -> `user`)
				// get genuinely distinct names — reusing one name for both
				// would fail to disambiguate them from each other. Passed
				// verbatim to the matching back-relation below, so both sides
				// agree, which is Prisma's actual requirement.
				const disambiguationName = needsRelationName(references.model)
					? JSON.stringify(`${model.contractName}_${column}`)
					: undefined;
				const relationTag = disambiguationName ? `${disambiguationName}, ` : "";

				relationFields.push({
					name: relationName,
					type: `${target.contractName}${optional ? "?" : ""}`,
					attributes: [
						`@relation(${relationTag}fields: [${column}], references: [${targetColumn}], onDelete: ${action})`,
					],
				});

				target.backRelations.push({
					name: backRelationName(target, model.tableName, column),
					type: `${model.contractName}[]`,
					attributes: disambiguationName ? [`@relation(${disambiguationName})`] : [],
				});
			}

			model.fields.push({
				name: column,
				type: `${scalar.type}${optional ? "?" : ""}`,
				attributes,
				note: notes.length > 0 ? notes.join("; ") : undefined,
			});

			if (field.index) fieldIndexes.push(`@@index([${column}])`);
		}

		model.fields.push(...relationFields);

		const resolveColumn = columnResolverFor(key);
		for (const index of table.indexes ?? []) {
			model.blockAttributes.push(renderIndex(index, resolveColumn));
		}
		// Field-level `index: true` after table-level indexes, so a table that
		// declares both still emits in a fixed order.
		model.blockAttributes.push(...fieldIndexes);
	}

	return orderedKeys
		.map((key) => models.get(key))
		.filter((model): model is ResolvedModel => model !== undefined);
}

/**
 * Names the list field on the referenced model. Two models can be joined more
 * than once (e.g. an audit table with `actorId` and `subjectId` both pointing
 * at `user`), so a collision falls back to including the FK column.
 */
function backRelationName(
	target: ResolvedModel,
	referencingTableName: string,
	fkColumn: string,
): string {
	const base = lowerFirst(referencingTableName);
	const plural = base.endsWith("s") ? base : `${base}s`;
	const taken = new Set([
		...target.fields.map((f) => f.name),
		...target.backRelations.map((f) => f.name),
	]);
	if (!taken.has(plural)) return plural;
	return `${plural}_${fkColumn}`;
}

/** Renders one model block with column-aligned fields, Prisma-format style. */
function renderModel(model: ResolvedModel): string {
	const fields = [...model.fields, ...model.backRelations];
	const nameWidth = Math.max(...fields.map((f) => f.name.length));
	const typeWidth = Math.max(...fields.map((f) => f.type.length));

	const lines = fields.map((field) => {
		const head = `  ${field.name.padEnd(nameWidth)} ${field.type.padEnd(
			typeWidth,
		)}`;
		const tail = [
			field.attributes.join(" "),
			field.note ? `// ${field.note}` : "",
		]
			.filter((part) => part.length > 0)
			.join(" ");
		return (tail.length > 0 ? `${head} ${tail}` : head).replace(/\s+$/, "");
	});

	const blockAttributes = [
		...model.blockAttributes,
		`@@map(${JSON.stringify(model.tableName)})`,
	].map((attribute) => `  ${attribute}`);

	return [
		`model ${model.contractName} {`,
		...lines,
		"",
		...blockAttributes,
		"}",
	].join("\n");
}

const HEADER = [
	"// Generated by better-auth-adapter-prisma8 via `@better-auth/cli generate`.",
	"//",
	"// This is a Prisma Next (Prisma 8) data contract. Unlike a Prisma 7",
	"// `schema.prisma` it declares no `datasource` or `generator` block: the",
	"// provider and connection are configured in `prisma.config.ts`, and the",
	"// artifacts come from `npx prisma contract emit`.",
	"//",
	"// Model names are the PascalCase form of Better Auth's table names, because",
	"// that is how the adapter addresses them (`db.orm.User`); `@@map` pins the",
	"// physical table name Better Auth expects.",
	"",
	"// use prisma-next",
].join("\n");

/** Model names already declared in an existing contract source. */
function existingModelNames(schema: string): Set<string> {
	const names = new Set<string>();
	// Line-anchored so a `model` mentioned inside a comment or a string
	// doesn't register as a declaration.
	const pattern = /^\s*model\s+([A-Za-z_][A-Za-z0-9_]*)\s*\{/gm;
	let match = pattern.exec(schema);
	while (match) {
		names.add(match[1]!);
		match = pattern.exec(schema);
	}
	return names;
}

/**
 * Renders the contract source.
 *
 * With no `existingSchema` this is a complete, self-contained contract
 * (header + every model). With an `existingSchema` it renders *only* the
 * models that file is missing, so the caller can append them and keep the
 * user's own header and hand-written models intact — returns `""` when
 * nothing is missing.
 */
export function generateContractPrisma(opts: GenerateContractOptions): string {
	const models = resolveModels(opts);

	if (opts.existingSchema === undefined) {
		if (models.length === 0) return `${HEADER}\n`;
		return `${HEADER}\n\n${models.map(renderModel).join("\n\n")}\n`;
	}

	const present = existingModelNames(opts.existingSchema);
	const missing = models.filter((model) => !present.has(model.contractName));
	if (missing.length === 0) return "";

	// Back-relations that belong on a model the user already has can't be
	// appended into that (existing) block, so they're called out instead of
	// being silently dropped.
	const orphanedBackRelations: string[] = [];
	for (const model of models) {
		if (!present.has(model.contractName)) continue;
		for (const backRelation of model.backRelations) {
			if (!missing.some((m) => backRelation.type.startsWith(m.contractName))) {
				continue;
			}
			orphanedBackRelations.push(
				`//   model ${model.contractName} { ${backRelation.name} ${backRelation.type} }`,
			);
		}
	}

	const preamble = [
		"// Added by better-auth-adapter-prisma8 via `@better-auth/cli generate`.",
	];
	if (orphanedBackRelations.length > 0) {
		preamble.push(
			"// Add these back-relation fields to your existing models by hand — they",
			"// belong inside model blocks this file already declares:",
			...orphanedBackRelations,
		);
	}

	return `${preamble.join("\n")}\n\n${missing.map(renderModel).join("\n\n")}\n`;
}

/**
 * The `createSchema` hook's return value.
 *
 * **`append` is dead — do not rely on it.** `DBAdapterSchemaCreation` (and
 * its docstring) suggest `append: true` makes the CLI append `code` to an
 * existing file. It does not. Read from the installed
 * `@better-auth/cli@1.4.21` package itself
 * (`dist/index.mjs`'s `generate` command and
 * `dist/generators-*.mjs`'s `generateSchema`), not from any doc:
 *
 * - `generateSchema()` for a custom adapter reads back only `{ code, path,
 *   overwrite }` from `createSchema(...)` — `append` is never even
 *   destructured.
 * - The CLI's own write path is unconditional: whenever `code` is non-empty
 *   it ends in exactly one `fs.writeFile(path, code)`. There is a dead
 *   `else fs.appendFile(...)` branch, but it sits inside `if (schema.overwrite)`
 *   — already-true by the time it's reached — so it can never run.
 *
 * So **`code` must always be the complete file to write**, never a
 * fragment, whenever it is non-empty — matching how the built-in
 * `generatePrismaSchema` behaves: it merges the missing models into the
 * existing schema *text* itself before returning, and sets
 * `overwrite: schemaExists && changed`. This function does the same:
 *
 * - Nothing missing → `code: ""` (the CLI prints "already up to date").
 * - No existing file → `code` is the complete new contract, `overwrite:
 *   false` (matches the CLI's non-`overwrite` prompt wording — "Do you want
 *   to generate the schema…" rather than "already exists, overwrite?").
 * - An existing **PSL** file with missing models → `code` is the existing
 *   text with the missing models appended, `overwrite: true`. Safe: the
 *   returned `code` already contains everything.
 * - An existing **TypeScript** file with missing models → attempts a
 *   structural merge via `mergeTypeScriptContract` (`./typescript-contract-merge`),
 *   which parses the file with the real TypeScript compiler API and only ever
 *   returns `code` when it can identify, with certainty, exactly where every
 *   new declaration and relation belongs. When the file's shape doesn't match
 *   what that merger can safely reason about, it reports why instead of
 *   guessing, and this function falls back to throwing — never returning a
 *   fragment as `code`. Returning a fragment here is exactly the bug this
 *   comment exists to prevent — it silently replaces the user's real
 *   contract with only the newly-added models. The thrown error names what's
 *   missing (and why the auto-merge declined) and includes the snippet to
 *   paste in by hand.
 */
export async function createPrisma8Schema(
	opts: GenerateContractOptions & { mode?: ContractAuthoringMode | undefined },
): Promise<DBAdapterSchemaCreation> {
	// Prisma 8 has two authoring modes, and a project uses exactly one. The
	// caller normally resolves it from `prisma.config.ts` (see
	// `discoverContract`); falling back to the file extension keeps direct
	// callers working, since that is what selects the mode for Prisma too.
	const path = opts.file || DEFAULT_CONTRACT_PATH;
	const mode = opts.mode ?? modeFromExtension(path);
	const hasExisting = opts.existingSchema !== undefined;

	if (mode === "typescript") {
		const missing = generateContractTypeScript({ ...opts, file: path });
		if (missing === "") return { code: "", path, overwrite: false };
		if (!hasExisting) {
			// No file to preserve: `missing` is the complete, self-contained
			// contract (see `generateContractTypeScript`'s own doc).
			return { code: missing, path, overwrite: false };
		}

		// An existing file with missing models: try a structural merge first —
		// it only ever succeeds when it can identify, with certainty, exactly
		// where every new declaration and relation belongs (real TS AST, exact
		// source-position splices, never a reprint of the user's file). Fall
		// back to the manual-paste throw when it can't.
		const attempt = await mergeTypeScriptContract({
			existingSource: opts.existingSchema!,
			generatorOptions: { ...opts, file: path },
		});
		if (attempt.code !== undefined) {
			// `code` is now the complete file — same reasoning as the PSL merge
			// path below: safe for the CLI's unconditional overwrite.
			return { code: attempt.code, path, overwrite: true };
		}

		throw new BetterAuthError(
			[
				`[prisma8] ${path} is missing model(s) Better Auth needs, and this generator cannot safely auto-merge into the existing TypeScript contract: ${attempt.unsupportedReason}.`,
				"",
				`Paste the following into the defineContract(...) factory in ${path} by hand — new consts before the factory body, each into the models map it returns — then re-run generate to confirm nothing is left:`,
				"",
				missing,
			].join("\n"),
		);
	}

	const missing = generateContractPrisma({ ...opts, file: path });
	if (missing === "") return { code: "", path, overwrite: false };
	if (!hasExisting) {
		// No file to preserve: `missing` is the complete, self-contained
		// contract (see `generateContractPrisma`'s own doc).
		return { code: missing, path, overwrite: false };
	}
	// PSL top-level declarations are order-independent, so appending the
	// missing models to the end of the user's own text is a safe, complete
	// merge — unlike the TypeScript case, no parser is needed for this.
	return {
		code: `${opts.existingSchema!.trimEnd()}\n\n${missing}`,
		path,
		overwrite: true,
	};
}

