import type { DBFieldAttribute, DBTableIndex } from "@better-auth/core/db";
import type { GenerateContractOptions } from "./schema-generator";

/**
 * Emits a Prisma 8 **TypeScript** data contract (`contract.ts`), the sibling
 * of `generateContractPrisma` in `./schema-generator`.
 *
 * Prisma 8 has exactly two contract-authoring languages and the *file
 * extension* picks between them: `contract.prisma` is PSL, `contract.ts` is
 * the `defineContract()` builder from
 * `@prisma/orm-postgres/contract-builder`. Both lower to the same
 * `contract.json`, so this generator has to make the same decisions the PSL
 * generator makes — model names, column names, id shape, referential actions
 * — or the adapter's `db.orm.<Model>` lookups break at runtime.
 *
 * Everything below was written against the *installed* `8.0.0-rc.8` type
 * definitions (`@prisma/orm-family-sql/dist/contract-builder-*.d.mts` and the
 * family/target packs), not against documentation.
 */

/** Where the Better Auth CLI writes a TypeScript contract by default. */
export const DEFAULT_TS_CONTRACT_PATH = "prisma/contract.ts";

/**
 * The module the builder helpers come from. Prisma ships one authoring
 * package per target; the helper *names* are shared (they come from the SQL
 * family pack) but the scalar presets are target-derived, so the import has
 * to match the provider.
 *
 * Only the Postgres builder is verified against installed types here — it is
 * the one this repo depends on. The SQLite specifier follows Prisma's own
 * package naming.
 */
function builderModuleFor(provider: GenerateContractOptions["provider"]): string {
	return provider === "sqlite"
		? "@prisma/orm-sqlite/contract-builder"
		: "@prisma/orm-postgres/contract-builder";
}

/**
 * Better Auth spells referential actions as lowercase, space-separated
 * strings (`"set null"`). PSL spells them PascalCase (`SetNull`). The
 * TypeScript builder spells them **camelCase** (`setNull`) — see
 * `ForeignKeyOptions` in the family pack's `contract-builder-*.d.mts`. Three
 * spellings for one concept; this map owns the third.
 */
const REFERENTIAL_ACTIONS: Record<string, string> = {
	"no action": "noAction",
	restrict: "restrict",
	cascade: "cascade",
	"set null": "setNull",
	"set default": "setDefault",
};

/**
 * Mirrors `toContractModelName` in `src/prisma8-adapter.ts` (and its copy in
 * `src/schema-generator.ts`) exactly. First-letter uppercase only — *not*
 * general PascalCase — because that is the transform the adapter applies
 * before indexing `db.orm.<schema>.<Model>`.
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
	table: { modelName?: string | undefined },
	usePlural: boolean,
): string {
	const base = table.modelName || modelKey;
	return usePlural ? `${base}s` : base;
}

/**
 * The physical column name, which doubles as the *contract field key*: the
 * adapter resolves fields through `getFieldName` (returning the physical
 * `fieldName`) and then indexes the ORM field proxy with it, so a contract
 * that declared fields under their logical names would not resolve.
 */
function columnNameFor(fieldKey: string, field: DBFieldAttribute): string {
	return field.fieldName || fieldKey;
}

/** A bare JS identifier can be used as an unquoted object key / dot access. */
const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

function quote(value: string): string {
	return JSON.stringify(value);
}

/** Object-literal key: bare when it is a valid identifier, quoted otherwise. */
function objectKey(name: string): string {
	return IDENTIFIER.test(name) ? name : quote(name);
}

/** `cols.userId` vs `cols["user-id"]` — Better Auth field names are free-form. */
function memberAccess(object: string, name: string): string {
	return IDENTIFIER.test(name)
		? `${object}.${name}`
		: `${object}[${quote(name)}]`;
}

export interface EmittedField {
	/** Contract field key === physical column name. */
	name: string;
	/** The full builder chain, e.g. `field.text().optional()`. */
	expression: string;
	/** Trailing `// …` note, without the slashes. */
	note?: string | undefined;
}

export interface EmittedRelation {
	name: string;
	expression: string;
	/** The other model's contract name, for the merge path's orphan check. */
	target: string;
}

interface EmittedForeignKey {
	/** Source column on this model. */
	column: string;
	/** The target model's contract name — also its `const` identifier. */
	targetName: string;
	targetField: string;
	/** Already mapped to the builder's camelCase spelling. */
	onDelete: string;
}

interface EmittedIndex {
	columns: string[];
	unique: boolean;
	name?: string | undefined;
}

export interface ResolvedModel {
	key: string;
	tableName: string;
	/**
	 * The contract model name. Also the identifier of the single `const` this
	 * model is declared under (see `renderModelDeclaration`) — relations and
	 * foreign keys reference it directly, since `.relations({...})` returns a
	 * new builder rather than mutating in place and is only ever called from
	 * inside the `models` map (textually after every model's `const`, so every
	 * token — parent or child — is already in scope regardless of direction).
	 */
	contractName: string;
	fields: EmittedField[];
	relations: EmittedRelation[];
	foreignKeys: EmittedForeignKey[];
	indexes: EmittedIndex[];
	/** Compound `@@unique` equivalents — the `.attributes({ uniques })` stage. */
	uniques: EmittedIndex[];
}

/**
 * The builder expression for a Better Auth field type.
 *
 * Preset names come from the target pack (`field.text`, `int`, `bigint`,
 * `boolean`, `json`, `dateTime`, `temporal.*`), *not* from the runtime `field`
 * object — the runtime object only carries `column`/`generated`/`namedType`
 * and the scalar helpers are composed onto it at the type level from the
 * pack descriptors. They were read out of
 * `@prisma/orm-target-postgres/dist/pack-*.d.mts`.
 */
function baseExpressionFor(
	field: DBFieldAttribute,
	provider: GenerateContractOptions["provider"],
): { expression: string; note?: string; isList: boolean } {
	const type = field.type;

	// `Array<LiteralString>` — a string-literal union. Emitted as a plain text
	// column for the same reason the PSL generator refuses to synthesize an
	// `enum`: Better Auth's literals are arbitrary strings, and a generated
	// enum would be invalid for a large share of real plugin schemas.
	if (Array.isArray(type)) {
		return {
			expression: "field.text()",
			note: `one of: ${type.join(", ")}`,
			isList: false,
		};
	}

	switch (type) {
		case "string":
			return { expression: "field.text()", isList: false };
		case "number":
			return {
				expression: field.bigint ? "field.bigint()" : "field.int()",
				isList: false,
			};
		case "boolean":
			return { expression: "field.boolean()", isList: false };
		case "date": {
			// `onUpdate` is documented as a database-level on-update trigger,
			// which is exactly what the target pack's `temporal.updatedAt`
			// preset installs (execution defaults on both create and update).
			// It is a Postgres-pack preset, so other targets fall back to a
			// plain timestamp column.
			if (field.onUpdate && provider === "postgresql") {
				return { expression: "field.temporal.updatedAt()", isList: false };
			}
			return { expression: "field.dateTime()", isList: false };
		}
		case "json":
			return provider === "postgresql"
				? { expression: "field.json()", isList: false }
				: {
						expression: "field.text()",
						note: "json — SQLite has no native Json type; stored as serialized TEXT",
						isList: false,
					};
		case "string[]":
		case "number[]": {
			// `.many()` on the scalar field builder is the array modifier; like
			// PSL's `String[]` it is a Postgres-only feature.
			const element = type === "string[]" ? "field.text()" : "field.int()";
			return provider === "postgresql"
				? { expression: `${element}.many()`, isList: true }
				: {
						expression: "field.text()",
						note: `${type} — SQLite has no scalar lists; stored as a serialized TEXT value`,
						isList: false,
					};
		}
		default: {
			// Exhaustive over the documented `DBFieldType` union.
			const exhaustive: never = type;
			throw new Error(
				`Unsupported Better Auth field type: ${String(exhaustive)}`,
			);
		}
	}
}

/**
 * `.default(...)` for *literal* primitives only.
 *
 * Better Auth applies `defaultValue` at write time and explicitly does not
 * create a database default, but a literal is exactly what a column default
 * can express, and having it in the contract means a column added by a later
 * migration backfills instead of failing on existing rows. Thunks
 * (`() => new Date()`) are **never invoked** at generate time — their value is
 * per-write, not a column default.
 */
function defaultCallFor(field: DBFieldAttribute): string | undefined {
	const value = field.defaultValue;
	if (typeof value === "function") return undefined;
	if (value === undefined || value === null) return undefined;
	if (typeof value === "boolean") return `.default(${value})`;
	if (typeof value === "number") return `.default(${value})`;
	if (typeof value === "string") return `.default(${quote(value)})`;
	// Dates / arrays / JSON documents have no portable literal spelling here.
	return undefined;
}

/** The id column's builder chain. */
function idExpressionFor(useNumberId: boolean, useUUID: boolean): string {
	// `field.text().id()` is the TS spelling of PSL's `String @id` with no
	// default: Better Auth generates ids in application code, so the column
	// must not carry a generator.
	//
	// `useNumberId` is PSL's `Int @id @default(autoincrement())`. The builder
	// has no `autoincrement` preset, so the sequence default is spelled
	// through `.defaultSql()`, which lowers to the same
	// `{ kind: "function", expression }` column default PSL's
	// `@default(autoincrement())` produces.
	if (useNumberId) return 'field.int().id().defaultSql("autoincrement()")';

	// `useUUID` is the id counterpart for `advanced.database.generateId:
	// "uuid"`. `field.id.uuidv7String()` is the Postgres pack's dedicated
	// preset for exactly this — PSL's matching spelling is
	// `@default(uuid(7))` (see `schema-generator.ts`'s `resolveModels`), and
	// both lower to the *identical* internal representation
	// (`{ kind: "generator", id: "uuidv7" }`, verified by reading
	// `orm-target-postgres`'s `postgresDefaultFunctionRegistryEntries`
	// directly), so PSL- and TypeScript-authored contracts generate ids the
	// same way.
	//
	// Generation is *client-side* — the ORM runtime mints the UUID before the
	// insert, the same mechanism `field.temporal.createdAt()`'s `instantNow`
	// generator uses — not a database default, so there is no PostgreSQL
	// version floor the way a raw `gen_random_uuid()` default would have.
	// v7 (not v4): time-ordered, which gives better B-tree locality than a
	// fully-random primary key on an insert-heavy table.
	//
	// The preset's column is `character(36)` (`sql/char@1`), not `text` —
	// unlike `useNumberId`'s `Int`, this needs no foreign key override below:
	// verified directly (a `character(36)` id with a plain `field.text()`
	// foreign key creates, enforces the FK constraint, and looks up
	// correctly) that Postgres's "character" type family interoperates with
	// `text` for both FK constraints and equality, unlike `integer`/`text`.
	if (useUUID) return "field.id.uuidv7String()";

	return "field.text().id()";
}

/** Resolves every table into the pieces the renderer emits. */
export function resolveModels(opts: GenerateContractOptions): ResolvedModel[] {
	const { tables, provider } = opts;
	const usePlural = opts.usePlural ?? false;
	const useNumberId = opts.useNumberId ?? false;
	const useUUID = !useNumberId && (opts.useUUID ?? false);

	const keys = Object.keys(tables);
	// Deterministic model order: Better Auth's own `order` first (user=1,
	// session=2, account=3, verification=4), then declaration order for the
	// remaining plugin tables. Byte-identical output across runs.
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
		// A table that opted out of migrations owns its own DDL.
		if (table.disableMigrations) continue;
		const tableName = tableNameFor(key, table, usePlural);
		models.set(key, {
			key,
			tableName,
			contractName: toContractModelName(tableName),
			fields: [
				{
					name: "id",
					expression: idExpressionFor(useNumberId, useUUID),
					note:
						useNumberId || useUUID
							? undefined
							: "id is generated by Better Auth, not the database",
				},
			],
			relations: [],
			foreignKeys: [],
			indexes: [],
			uniques: [],
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
		const fieldIndexes: EmittedIndex[] = [];

		for (const [fieldKey, attribute] of Object.entries(table.fields)) {
			const column = columnNameFor(fieldKey, attribute);
			const base = baseExpressionFor(attribute, provider);
			let expression = base.expression;

			// The FK side of a relation. Better Auth types *every* foreign key
			// as `string` because it never sees the column type; under
			// `useNumberId` the referenced id is an integer and Prisma rejects a
			// mismatched relation, so the id type wins.
			const references = attribute.references;
			const target = references ? models.get(references.model) : undefined;
			if (references && target && references.field === "id" && useNumberId) {
				expression = "field.int()";
			}

			// `required` defaults to true; only an explicit `false` is optional.
			// A scalar list is never nullable (matching PSL's rejection of
			// `String[]?`).
			const optional = attribute.required === false && !base.isList;
			if (optional) expression += ".optional()";
			if (attribute.unique) expression += ".unique()";
			const defaultCall = defaultCallFor(attribute);
			if (defaultCall) expression += defaultCall;
			// The contract field key is already the physical column name, so
			// `.column()` is only emitted when the logical and physical names
			// differ — it pins the mapping the same way PSL's `@map` does, and
			// keeps the rename visible in the contract.
			if (column !== fieldKey) expression += `.column(${quote(column)})`;

			const notes: string[] = [];
			if (base.note) notes.push(base.note);
			if (typeof attribute.defaultValue === "function") {
				notes.push("default is computed by Better Auth on write");
			}
			if (attribute.sortable) notes.push("sortable");

			if (references && !target) {
				// Referenced table disabled or absent — record it rather than
				// emitting a dangling foreign key.
				notes.push(
					`references ${references.model}.${references.field} (model not emitted)`,
				);
			} else if (references && target) {
				const onDelete =
					REFERENTIAL_ACTIONS[references.onDelete ?? "cascade"] ?? "cascade";
				const targetColumn = columnResolverFor(references.model)(
					references.field,
				);

				model.foreignKeys.push({
					column,
					targetName: target.contractName,
					targetField: targetColumn,
					onDelete,
				});

				// `userId` -> `user`; anything else falls back to the target
				// model name so the relation is still readable.
				const stem = column.endsWith("Id")
					? column.slice(0, -2)
					: lowerFirst(target.contractName);
				const taken = new Set(model.relations.map((r) => r.name));
				let relationName =
					stem.length > 0 ? stem : lowerFirst(target.contractName);
				if (taken.has(relationName) || relationName === column) {
					relationName = `${relationName}Ref`;
				}

				model.relations.push({
					name: relationName,
					target: target.contractName,
					// The *typed* overload, taking the target's model token rather
					// than its name as a string. Prisma emits a
					// PN_CONTRACT_TYPED_FALLBACK_AVAILABLE runtime warning for the
					// string form, and the token form type-checks `from`/`to`
					// against the target's real field names.
					expression: `rel.belongsTo(${target.contractName}, { from: ${quote(
						column,
					)}, to: ${quote(targetColumn)} })`,
				});

				target.relations.push({
					name: backRelationName(target, model.tableName, column),
					target: model.contractName,
					expression: `rel.hasMany(${model.contractName}, { by: ${quote(
						column,
					)} })`,
				});
			}

			model.fields.push({
				name: column,
				expression,
				note: notes.length > 0 ? notes.join("; ") : undefined,
			});

			if (attribute.index) {
				fieldIndexes.push({ columns: [column], unique: false });
			}
		}

		const resolveColumn = columnResolverFor(key);
		for (const index of table.indexes ?? []) {
			const resolved: EmittedIndex = {
				columns: index.fields.map(resolveColumn),
				unique: index.unique === true,
				name: index.name,
			};
			// A compound unique is the `@@unique` equivalent, which the builder
			// models as a model *attribute* rather than an index; everything else
			// is an index in the SQL stage.
			if (resolved.unique) model.uniques.push(resolved);
			else model.indexes.push(resolved);
		}
		// Field-level `index: true` after table-level indexes, so a table that
		// declares both still emits in a fixed order.
		model.indexes.push(...fieldIndexes);
	}

	return orderedKeys
		.map((key) => models.get(key))
		.filter((model): model is ResolvedModel => model !== undefined);
}

/**
 * Names the `hasMany` back-relation on the referenced model. Two models can be
 * joined more than once (an audit table with `actorId` and `subjectId` both
 * pointing at `user`), so a collision falls back to including the FK column.
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
		...target.relations.map((r) => r.name),
	]);
	if (!taken.has(plural)) return plural;
	return `${plural}_${fkColumn}`;
}

const INDENT = "  ";

function indent(lines: string[], level: number): string[] {
	return lines.map((line) =>
		line.length === 0 ? line : INDENT.repeat(level) + line,
	);
}

/** Renders `constraints.index([...], { … })` / `constraints.unique(...)`. */
function renderIndexCall(
	index: EmittedIndex,
	dsl: "index" | "unique",
	refObject: string,
): string {
	const columns = index.columns
		.map((column) => memberAccess(refObject, column))
		.join(", ");
	const options: string[] = [];
	if (index.name) {
		// `map` is documented as "exact physical name — adopted verbatim, no
		// wire hash", which is what `DBTableIndex.name` means ("portable
		// database index name"). `constraints.unique` has no `map`, only a
		// `name` that the builder hashes into a wire name, so a named compound
		// unique gets the closest available spelling.
		options.push(
			dsl === "index"
				? `map: ${quote(index.name)}`
				: `name: ${quote(index.name)}`,
		);
	}
	const optionsArgument =
		options.length > 0 ? `, { ${options.join(", ")} }` : "";
	return `constraints.${dsl}([${columns}]${optionsArgument})`;
}

/**
 * Renders the single `const` a model is declared under:
 *
 * ```ts
 * const User = model("User", { fields: { … } }).sql({ table: "user" });
 * ```
 *
 * Relations are deliberately **not** chained here. `.relations({...})` on
 * `ContractModelBuilder` returns a *new* builder rather than mutating in
 * place, and a `.sql(...)` foreign-key constraint only ever needs the
 * *other* model's bare token (via `Model.refs.<field>`), never its
 * relations — so a parent's `hasMany` pointing at a child and the child's
 * `belongsTo` pointing back at the parent never actually forms a cycle at
 * the `const`-declaration level. `.relations({...})` is called later, once
 * per model, inside the `return { models: {...} } }` object literal that
 * `generateContractTypeScript` builds — textually after every model's
 * `const`, so every token (parent or child) is already in scope by the time
 * any `.relations()` call runs. See `renderMapEntry`.
 */
export function renderModelDeclaration(model: ResolvedModel, base: number): string {
	// A model with a foreign key referencing *itself* (a hierarchical plugin
	// table — `parentId` pointing back at its own `id`, common for nested
	// categories, org trees, threaded comments) cannot chain `.sql(...)`
	// straight onto its own `const`: the callback's own text would read
	// `<Name>.refs.<field>` before `const <Name> = ...` has finished
	// evaluating. At runtime this is actually fine — `.sql()`'s callback runs
	// lazily, well after the factory body returns — but TypeScript's static
	// checker still flags it (`TS7022`, "implicitly has type 'any' because it
	// ... is referenced directly or indirectly in its own initializer"). A
	// *forward* reference to a **different**, later-declared model is not affected —
	// only a model referencing itself is — so this split only applies then.
	//
	// Fix: declare the bare `model(...)` (optionally with `.attributes(...)`,
	// which never touches other models' tokens) under a `<Name>Base`
	// identifier first, then `.sql(...)` on a *second* statement — assigned
	// to the name every other model, relation, and the `models` map actually
	// uses — with self-targeting foreign keys reading `<Name>Base.refs...`
	// instead. `.refs` is available immediately once `model(...)` is called
	// (set in the builder's constructor), independent of any later chaining,
	// so this is not itself circular.
	const selfFk = model.foreignKeys.some((fk) => fk.targetName === model.contractName);
	const baseName = selfFk ? `${model.contractName}Base` : model.contractName;
	const refsFor = (targetName: string) =>
		targetName === model.contractName ? baseName : targetName;

	const lines: string[] = [];
	lines.push(`const ${baseName} = model(${quote(model.contractName)}, {`);
	lines.push(`${INDENT}fields: {`);
	for (const field of model.fields) {
		const note = field.note ? ` // ${field.note}` : "";
		lines.push(
			`${INDENT}${INDENT}${objectKey(field.name)}: ${field.expression},${note}`,
		);
	}
	lines.push(`${INDENT}},`);
	lines.push(`})`);

	if (model.uniques.length > 0) {
		// The `@@unique` equivalent. The builder models a compound unique as a
		// model *attribute*, not as an index in the SQL stage.
		lines.push(`${INDENT}.attributes(({ fields, constraints }) => ({`);
		lines.push(`${INDENT}${INDENT}uniques: [`);
		for (const unique of model.uniques) {
			lines.push(
				`${INDENT}${INDENT}${INDENT}${renderIndexCall(unique, "unique", "fields")},`,
			);
		}
		lines.push(`${INDENT}${INDENT}],`);
		lines.push(`${INDENT}}))`);
	}

	const needsSqlContext =
		model.indexes.length > 0 || model.foreignKeys.length > 0;
	if (!needsSqlContext) {
		// `table` pins the physical table name Better Auth addresses — the
		// contract model name is its capitalized form, so without this the
		// builder would create a `User` table for a `user` model.
		lines.push(`${INDENT}.sql({ table: ${quote(model.tableName)} });`);
		return indent(lines, base).join("\n");
	}

	if (selfFk) {
		lines[lines.length - 1] += ";";
		lines.push("");
		lines.push(`const ${model.contractName} = ${baseName}`);
	}

	lines.push(`${INDENT}.sql(({ cols, constraints }) => ({`);
	lines.push(`${INDENT}${INDENT}table: ${quote(model.tableName)},`);
	if (model.indexes.length > 0) {
		lines.push(`${INDENT}${INDENT}indexes: [`);
		for (const index of model.indexes) {
			lines.push(
				`${INDENT}${INDENT}${INDENT}${renderIndexCall(index, "index", "cols")},`,
			);
		}
		lines.push(`${INDENT}${INDENT}],`);
	}
	if (model.foreignKeys.length > 0) {
		lines.push(`${INDENT}${INDENT}foreignKeys: [`);
		for (const fk of model.foreignKeys) {
			lines.push(
				...indent(
					[
						`constraints.foreignKey(`,
						`${INDENT}${memberAccess("cols", fk.column)},`,
						`${INDENT}${memberAccess(`${refsFor(fk.targetName)}.refs`, fk.targetField)},`,
						`${INDENT}{ onDelete: ${quote(fk.onDelete)} },`,
						`),`,
					],
					3,
				),
			);
		}
		lines.push(`${INDENT}${INDENT}],`);
	}
	lines.push(`${INDENT}}));`);

	return indent(lines, base).join("\n");
}

/** One `key: expression,` line inside a `.relations({...})` call. */
export function renderRelationProperty(relation: EmittedRelation, base: number): string {
	return indent(
		[`${objectKey(relation.name)}: ${relation.expression},`],
		base,
	).join("\n");
}

/**
 * Renders one model's entry in the `models` map handed back from the
 * `defineContract` factory: a bare identifier when the model has no
 * relations, `Name: Name.relations({...})` otherwise.
 */
export function renderMapEntry(model: ResolvedModel, base: number): string {
	if (model.relations.length === 0) {
		return indent([`${model.contractName},`], base).join("\n");
	}
	const lines = [`${model.contractName}: ${model.contractName}.relations({`];
	for (const relation of model.relations) {
		lines.push(renderRelationProperty(relation, 1));
	}
	lines.push(`}),`);
	return indent(lines, base).join("\n");
}

const HEADER = [
	"// Generated by better-auth-adapter-prisma8 via `@better-auth/cli generate`.",
	"//",
	"// This is a Prisma Next (Prisma 8) data contract authored with the",
	"// TypeScript builder. It declares no `datasource` or `generator`: the",
	"// provider and connection live in `prisma.config.ts`, and the artifacts",
	"// come from `npx prisma contract emit`.",
	"//",
	"// Model names are the capitalized form of Better Auth's physical table",
	"// names, because that is how the adapter addresses them (`db.orm.User`);",
	"// `.sql({ table })` pins the physical table name Better Auth expects, and",
	"// each field key is the physical column name the adapter queries by.",
].join("\n");

/**
 * Model names already declared in an existing TypeScript contract.
 *
 * This is a deliberately shallow **textual scan** for `model("Name"` — not a
 * parse. A real TypeScript contract can name its models through variables,
 * template literals or helper functions, and re-implementing the compiler to
 * find them is far more machinery than a merge check justifies. The scan
 * tolerates any quote style and arbitrary whitespace around the paren; the
 * cost of a miss is a duplicate suggestion in the emitted snippet, never a
 * corrupted file, because merging never rewrites the user's source.
 */
function existingModelNames(schema: string): Set<string> {
	const names = new Set<string>();
	const pattern = /\bmodel\s*\(\s*(["'`])([^"'`]+)\1/g;
	let match = pattern.exec(schema);
	while (match) {
		names.add(match[2]!);
		match = pattern.exec(schema);
	}
	return names;
}

/**
 * The import statement.
 *
 * Only `defineContract` is imported. The scalar field helpers (`field.text`,
 * `field.json`, `field.temporal.updatedAt`, …) are **pack-derived**: the
 * `field` value exported from `@prisma/orm-postgres/contract-builder` carries
 * only `column` / `generated` / `namedType`, and the target pack's presets are
 * composed onto the `field` handed to the `defineContract(scaffold, factory)`
 * factory (`ComposedAuthoringHelpers`). So the models are declared inside the
 * factory, where `field`, `model` and `rel` are in scope, rather than at
 * module top level.
 */
function renderImport(provider: GenerateContractOptions["provider"]): string {
	return `import { defineContract } from ${quote(builderModuleFor(provider))};`;
}

/** The factory's destructured helper list, narrowed to what the body uses. */
function renderHelpers(models: ResolvedModel[]): string {
	const names = ["field", "model"];
	if (models.some((m) => m.relations.length > 0)) names.push("rel");
	return `({ ${names.join(", ")} })`;
}

/**
 * Renders the TypeScript contract source.
 *
 * With no `existingSchema` this is a complete, self-contained `contract.ts`
 * (header + import + one `const` per model + `export const contract = …`).
 * With an `existingSchema` it renders *only* the models that file is
 * missing, as a paste-ready snippet — the user's own file is never
 * rewritten — and returns `""` when nothing is missing, matching
 * `generateContractPrisma`'s idempotency contract.
 *
 * The export is a **named** `contract`, matching what `create-prisma`
 * scaffolds and what `@prisma/orm-family-sql`'s TypeScript-contract loader
 * (`typescriptContractFromPath`) checks first: `mod.default ?? mod.contract`.
 * A default
 * export is also accepted by that loader, but the named form is what a
 * project's own `contract.ts` will already look like, so merged output stays
 * visually consistent with it.
 */
export function generateContractTypeScript(
	opts: GenerateContractOptions,
): string {
	const models = resolveModels(opts);

	if (opts.existingSchema === undefined) {
		const parts: string[] = [HEADER, ""];
		parts.push(renderImport(opts.provider), "");
		// `{}` is the scaffold argument: every field on it (naming, namespaces,
		// storageHash, entities…) is optional, and the two-argument overload is
		// the only one that hands the factory the pack-composed helpers.
		parts.push(`export const contract = defineContract({}, ${renderHelpers(models)} => {`);
		for (const model of models) {
			parts.push(renderModelDeclaration(model, 1), "");
		}
		if (models.length === 0) {
			parts.push(`${INDENT}return { models: {} };`);
		} else {
			parts.push(`${INDENT}return {`);
			parts.push(`${INDENT}${INDENT}models: {`);
			for (const model of models) {
				parts.push(renderMapEntry(model, 3));
			}
			parts.push(`${INDENT}${INDENT}},`);
			parts.push(`${INDENT}};`);
		}
		parts.push("});");
		return `${parts.join("\n")}\n`;
	}

	const present = existingModelNames(opts.existingSchema);
	const missing = models.filter((model) => !present.has(model.contractName));
	if (missing.length === 0) return "";

	// Back-relations that belong on a model the user already declares cannot be
	// appended into that existing `model(...)` call — under this shape the
	// relation only ever lives on that model's entry in the `models` map — so
	// they are called out instead of being silently dropped.
	const orphanedRelations: string[] = [];
	for (const model of models) {
		if (!present.has(model.contractName)) continue;
		for (const relation of model.relations) {
			const referenced = missing.some((m) => m.contractName === relation.target);
			if (!referenced) continue;
			orphanedRelations.push(
				`//   Add this to ${model.contractName}'s entry in the \`models\` map: ` +
					`${model.contractName}: ${model.contractName}.relations({ ${relation.name}: ${relation.expression} }), ` +
					`— or if it already has \`.relations(...)\`, add the \`${relation.name}\` property to it.`,
			);
		}
	}

	const preamble = [
		"// Added by better-auth-adapter-prisma8 via `@better-auth/cli generate`.",
		"//",
		"// Paste these declarations inside the `defineContract(…, ({ field, model,",
		"// rel }) => { … })` factory of your existing contract, before the",
		"// `return` statement, then add each new model to the `models` map it",
		"// returns:",
	];
	for (const model of missing) {
		for (const line of renderMapEntry(model, 0).split("\n")) {
			preamble.push(`//   ${line}`);
		}
	}
	preamble.push(
		"//",
		"// Your file is never rewritten automatically — a TypeScript contract is",
		"// code, not a schema this generator can safely edit in place.",
	);
	if (orphanedRelations.length > 0) {
		preamble.push(
			"//",
			"// Add these back-relations by hand — they belong on models this file",
			"// already declares:",
			...orphanedRelations,
		);
	}

	const parts: string[] = [preamble.join("\n"), ""];
	for (const model of missing) {
		parts.push(renderModelDeclaration(model, 0), "");
	}
	// Trailing blank entry becomes the trailing newline via join + final "\n".
	parts.pop();
	return `${parts.join("\n")}\n`;
}
