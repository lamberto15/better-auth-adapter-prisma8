import type { BetterAuthOptions } from "@better-auth/core";
import type {
	AdapterFactoryCustomizeAdapterCreator,
	AdapterFactoryOptions,
	CleanedWhere,
	DBAdapter,
	DBAdapterDebugLogOption,
	DBAdapterFactoryConfig,
	JoinConfig,
	Where,
} from "@better-auth/core/db/adapter";
import { createAdapterFactory } from "@better-auth/core/db/adapter";
import { BetterAuthError } from "@better-auth/core/error";
// The standalone predicate combinators. Prisma's ORM client reference puts
// these on `@prisma/orm-postgres/orm-client` (the field-level operators like
// `u.email.eq(...)` come off the field accessor instead). v0.1.0 imported them
// from `@internal/sql-orm-client`, which does not exist.
import { and, or, not } from "@prisma/orm-postgres/orm-client";
// Prisma 8's Postgres `dateTime` family of codecs requires a TC39
// `Temporal.Instant` and *rejects* a native `Date` outright (see
// `orm-target-postgres`'s `encodeTemporalValue`). Better Auth, meanwhile,
// always hands adapters — and expects back — native `Date` objects for
// every date-typed field, which is exactly what this adapter's
// `supportsDates: true` promises it. No current Node.js version ships
// `Temporal` natively, so this package depends on the TC39 reference
// polyfill and converts transparently at the boundary: dates go out as
// `Temporal.Instant`, rows come back with real `Date` objects, and neither
// Better Auth nor the caller of this adapter ever sees Temporal.
import { Temporal as TemporalPolyfill } from "@js-temporal/polyfill";
// Reuse whatever Temporal is already global (a consuming app's own polyfill,
// or eventually a native implementation) rather than always installing this
// package's own instance: some Temporal consumers narrow by identity against
// `globalThis.Temporal`, not by duck typing, so two different polyfill
// instances are not interchangeable.
const Temporal: typeof TemporalPolyfill =
	(globalThis as { Temporal?: typeof TemporalPolyfill }).Temporal ?? TemporalPolyfill;
(globalThis as { Temporal?: typeof TemporalPolyfill }).Temporal ??= Temporal;

/**
 * The structural surface this adapter needs from a Prisma Next `db` client,
 * as constructed by `postgres<Contract>(...)` from
 * `@prisma/orm-postgres/runtime`.
 *
 * Kept structural (rather than importing the concrete client type) because
 * this adapter has no access to any particular app's generated `Contract` —
 * `db.orm.<schema>` is keyed by whatever PascalCase model names that app's
 * contract declares.
 */
export interface PrismaNextFieldProxyEntry {
	eq(value: unknown): unknown;
	neq(value: unknown): unknown;
	lt(value: unknown): unknown;
	lte(value: unknown): unknown;
	gt(value: unknown): unknown;
	gte(value: unknown): unknown;
	like(value: unknown): unknown;
	ilike(value: unknown): unknown;
	in(values: readonly unknown[]): unknown;
	isNull(): unknown;
	isNotNull(): unknown;
	/**
	 * Sort directives. The ORM reference documents `orderBy()` as taking a
	 * callback returning `f.field.asc()` / `f.field.desc()`, so these live on
	 * the same field proxy as the comparison operators — declaring them here
	 * removes the `as any` cast `findMany` used to need.
	 */
	asc(): unknown;
	desc(): unknown;
	/**
	 * `notIn` is documented alongside `in` on the Postgres field proxy, but is
	 * declared optional so a runtime (or a test double) that only exposes `in`
	 * still type-checks; `buildSingleCondition` falls back to `not(in(...))`.
	 */
	notIn?(values: readonly unknown[]): unknown;
}

export type PrismaNextFieldProxy = Record<string, PrismaNextFieldProxyEntry>;
export type PrismaNextPredicate = (fields: PrismaNextFieldProxy) => unknown;

export interface PrismaNextAggregateApi {
	count(): unknown;
}

export interface PrismaNextOrmCollection {
	where(
		predicate: PrismaNextPredicate | Record<string, unknown>,
	): PrismaNextOrmCollection;
	select(...fields: readonly string[]): PrismaNextOrmCollection;
	orderBy(
		sorters:
			| ((fields: PrismaNextFieldProxy) => unknown)
			| ReadonlyArray<(fields: PrismaNextFieldProxy) => unknown>,
	): PrismaNextOrmCollection;
	limit(count: number): PrismaNextOrmCollection;
	offset(count: number): PrismaNextOrmCollection;
	/**
	 * The ORM lane's documented pagination pair is `.take(n)` / `.skip(n)`
	 * (`.limit()` / `.offset()` are the SQL-builder lane's spelling). Both are
	 * declared: `take`/`skip` are preferred at runtime when present, with
	 * `limit`/`offset` as the fallback, so this adapter works against either
	 * spelling without a hard dependency on which one a given runtime ships.
	 */
	take?(count: number): PrismaNextOrmCollection;
	skip?(count: number): PrismaNextOrmCollection;
	/**
	 * Resolves to every matching row. The runtime returns an
	 * `AsyncIterableResult`, which is awaitable to an array — that is the only
	 * mode this adapter uses. Note a result may be consumed once per mode:
	 * awaiting one and then `for await`-ing it throws `RUNTIME.ITERATOR_CONSUMED`.
	 */
	all(): Promise<Record<string, unknown>[]>;
	first(
		filter?: Record<string, unknown> | PrismaNextPredicate,
	): Promise<Record<string, unknown> | null>;
	create(data: Record<string, unknown>): Promise<Record<string, unknown>>;

	// Every mutation comes in three forms: the singular one affects exactly one
	// row and returns it, the `*All` form affects every match and returns the
	// rows, and the `*Count` form affects every match and returns only how many.
	// Getting this triple wrong is how an adapter turns a single-row write into
	// a silent mass mutation, so each is bound to the operation that actually
	// means it rather than being emulated on top of one of the others.

	/** Updates exactly one matching row — never fans out — and returns it. */
	update(data: Record<string, unknown>): Promise<Record<string, unknown> | null>;
	/** Updates every matching row, returning the updated rows. */
	updateAll(data: Record<string, unknown>): Promise<Record<string, unknown>[]>;
	/**
	 * Updates every matching row, returning only the affected count.
	 *
	 * Spelled `updateAndCount`, not `updateCount` — the installed
	 * `@prisma/orm-family-sql` package's `orm-client.d.mts` declares
	 * `updateAndCount`/`deleteAndCount`/`createAndCount`; Prisma's own
	 * "Writing data" docs say `updateCount`/`deleteCount`/`createCount`,
	 * which is wrong for this package version.
	 */
	updateAndCount(data: Record<string, unknown>): Promise<number>;
	/** Deletes exactly one matching row and returns it. */
	delete(): Promise<Record<string, unknown> | null>;
	/** Deletes every matching row, returning the deleted rows. */
	deleteAll(): Promise<Record<string, unknown>[]>;
	/** Deletes every matching row, returning only the affected count — see `updateAndCount`'s note on the real vs. documented method name. */
	deleteAndCount(): Promise<number>;

	aggregate<T extends Record<string, unknown>>(
		project: (aggregate: PrismaNextAggregateApi) => T,
	): Promise<T>;
}

/**
 * On PostgreSQL the ORM facet is keyed by database schema namespace before it
 * is keyed by model: `db.orm.public.User`, where `public` is the default
 * schema. (MongoDB instead exposes collections directly as `db.orm.users`,
 * which is one of the reasons Mongo is out of scope here.)
 */
export type PrismaNextOrmNamespace = Record<string, PrismaNextOrmCollection>;

export interface PrismaNextTransactionContext {
	orm: unknown;
}

/**
 * The `db` client this adapter is constructed with.
 *
 * `orm` is deliberately typed as `unknown` rather than as a structural mirror
 * of the real client. A generated `PostgresClient<Contract>` carries per-model
 * collection types far richer than the slice used here, and any hand-written
 * interface that tried to match them gets rejected on the first method it does
 * not name — which is exactly the
 * `Type 'OrmNamespace<…>' is missing the following properties` error that
 * v0.1.0 produced against a real client. Narrowing to the shape above happens
 * once, inside `getOrmCollection`, where a missing namespace or model is
 * reported as an actionable error instead of a structural type mismatch.
 */
export interface PrismaNextDb {
	orm: unknown;
	/**
	 * PostgreSQL only — Prisma 8 has no `transaction` method for MongoDB yet.
	 * Optional because the adapter degrades gracefully when it is absent.
	 */
	transaction?: unknown;
}

export interface Prisma8AdapterConfig {
	/**
	 * Which Prisma Next target façade `db` was built from.
	 *
	 * Mongo is intentionally not accepted here yet: its ORM lane has no
	 * `db.transaction(...)`, no `db.sql`, and a different (lowercase plural)
	 * model-root addressing scheme, so `consumeOne` / `incrementOne` (which
	 * both rely on a transactional read-then-guarded-write) cannot be
	 * expressed the same way. Track this in the adapter's issue tracker
	 * before widening the union.
	 */
	provider: "postgresql" | "sqlite";

	/**
	 * The database schema namespace models are addressed under —
	 * `db.orm.<schema>.<Model>`. Prisma 8 keys the ORM facet by schema before
	 * model, and `public` is PostgreSQL's default schema. Override this if your
	 * contract puts Better Auth's models in a different schema.
	 * @default "public"
	 */
	schema?: string | undefined;

	/**
	 * Enable debug logs for the adapter.
	 * @default false
	 */
	debugLogs?: DBAdapterDebugLogOption | undefined;

	/**
	 * Use plural table names.
	 * @default false
	 */
	usePlural?: boolean | undefined;

	/**
	 * Whether to execute multi-operation writes (e.g. a Better Auth release
	 * migration, or a plugin's multi-step write) inside a `db.transaction(...)`.
	 *
	 * **The `false` default is not atomic.** That is Better Auth's own factory
	 * behaviour, not a gap in this adapter: with no transaction implementation
	 * configured, `adapter.transaction(cb)` just calls `cb(adapter)` directly —
	 * no wrapping, no rollback — so a failure partway through a multi-step
	 * write leaves the earlier steps committed. Set this `true` if anything
	 * using this adapter relies on a multi-step operation being all-or-nothing.
	 *
	 * Only governs the *factory-level* `adapter.transaction(cb)` entry point.
	 * `consumeOne` and `incrementOne` always try to open their own transaction
	 * regardless of this setting, because they are read-then-write pairs whose
	 * correctness — not merely their grouping — depends on it; called from
	 * inside an already-open transaction, they reuse it rather than opening a
	 * second one.
	 *
	 * `update`, `delete` and `deleteMany` do *not* open one, and do not need
	 * to: each is a single statement that the runtime executes atomically on
	 * its own (`update`/`delete` narrow to one row by identity inside that
	 * statement).
	 * @default false
	 */
	transaction?: boolean | undefined;
}

/**
 * Prisma Next contract model names are PascalCase (`db.orm.public.User`), but
 * Better Auth passes lowercase (optionally pluralized) model names into
 * every adapter call. Capitalize the first letter to bridge the two; this
 * assumes the contract's model names match Better Auth's schema names up to
 * casing, which is true for `@better-auth/cli` generated contracts and for
 * hand-authored contracts that follow the same convention.
 */
function toContractModelName(model: string): string {
	return model.length === 0 ? model : model[0]!.toUpperCase() + model.slice(1);
}

/**
 * Resolve `db.orm.<schema>.<Model>` for a Better Auth model name.
 *
 * The two lookups fail for different reasons and so are reported separately: a
 * missing namespace almost always means the `schema` config is wrong (or the
 * client is a Mongo one, which has no namespace layer at all), whereas a
 * missing model means the contract simply doesn't declare it yet.
 */
function getOrmCollection(
	db: Pick<PrismaNextDb, "orm"> | PrismaNextTransactionContext,
	model: string,
	schema: string,
): PrismaNextOrmCollection {
	const namespaces = db.orm as Record<string, PrismaNextOrmNamespace | undefined>;
	if (namespaces == null || typeof namespaces !== "object") {
		throw new BetterAuthError(
			"The client passed to prisma8Adapter has no usable 'orm' facet. Pass the client returned by postgres<Contract>(...) from '@prisma/orm-postgres/runtime'.",
		);
	}

	const namespace = namespaces[schema];
	if (!namespace) {
		const available = Object.keys(namespaces).join(", ") || "none";
		throw new BetterAuthError(
			`Schema namespace '${schema}' does not exist on db.orm (available: ${available}). Prisma 8 addresses models as db.orm.<schema>.<Model> on PostgreSQL — set the adapter's 'schema' option to the namespace your contract uses.`,
		);
	}

	const contractModel = toContractModelName(model);
	const collection = namespace[contractModel];
	if (!collection) {
		throw new BetterAuthError(
			`Model ${model} (contract model ${schema}.${contractModel}) does not exist in the data contract. Add it to contract.prisma and run 'prisma contract emit'.`,
		);
	}
	return collection;
}

/** Duck-checks a `Temporal.Instant` by its `epochMilliseconds` getter — real
 * per the TC39 spec on both the polyfill and any future native
 * implementation — rather than `instanceof`, which would reject a value
 * built by a *different* Temporal module instance than this file's. */
function isTemporalInstant(value: unknown): value is { epochMilliseconds: number } {
	return (
		typeof value === "object" &&
		value !== null &&
		typeof (value as { epochMilliseconds?: unknown }).epochMilliseconds === "number"
	);
}

/** `Date` → `Temporal.Instant`; anything else passes through untouched. */
function toStorageValue(value: unknown): unknown {
	return value instanceof Date
		? Temporal.Instant.fromEpochMilliseconds(value.getTime())
		: value;
}

/** `Temporal.Instant` → `Date`; anything else passes through untouched. */
function fromStorageValue(value: unknown): unknown {
	return isTemporalInstant(value) ? new Date(value.epochMilliseconds) : value;
}

/** Shallow-converts every own value of a create/update payload for storage. Better Auth's models are flat, so a shallow walk is sufficient. */
function toStorageRow(data: Record<string, unknown>): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(data)) out[key] = toStorageValue(value);
	return out;
}

/** Shallow-converts every own value of a row read back from storage. */
function fromStorageRow<T>(row: T): T {
	if (row === null || typeof row !== "object") return row;
	const out: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(row as Record<string, unknown>)) {
		out[key] = fromStorageValue(value);
	}
	return out as T;
}

/**
 * Wraps a raw ORM collection so every date value crossing the boundary is
 * converted transparently — `Date` out to storage, `Temporal.Instant` back
 * in as `Date` — without the rest of the adapter needing to know Temporal
 * exists. `.where(...)`'s *predicate function* still needs its own
 * conversion at the point a date is compared (see `buildSingleCondition`),
 * since predicate values never pass through this wrapper's methods; every
 * other narrowing/read/write method is re-wrapped so the whole chain
 * (`.where(...).select(...).all()`, etc.) stays converted end to end.
 *
 * PostgreSQL only: SQLite is not a real Prisma 8 target yet (see the
 * README's scope section), so there is nothing to verify this against for
 * that provider, and applying an unverified conversion there risks being
 * wrong in a direction nobody can currently check.
 */
function withDateConversion(collection: PrismaNextOrmCollection): PrismaNextOrmCollection {
	const wrap = (query: PrismaNextOrmCollection): PrismaNextOrmCollection => ({
		where: (predicate) => wrap(query.where(predicate)),
		select: (...fields) => wrap(query.select(...fields)),
		orderBy: (sorters) => wrap(query.orderBy(sorters)),
		limit: (count) => wrap(query.limit(count)),
		offset: (count) => wrap(query.offset(count)),
		...(query.take ? { take: (count: number) => wrap(query.take!(count)) } : {}),
		...(query.skip ? { skip: (count: number) => wrap(query.skip!(count)) } : {}),
		all: async () => (await query.all()).map((row) => fromStorageRow(row)),
		first: async (filter) => {
			const row = await query.first(filter);
			return row ? fromStorageRow(row) : null;
		},
		create: async (data) => fromStorageRow(await query.create(toStorageRow(data))),
		update: async (data) => {
			const row = await query.update(toStorageRow(data));
			return row ? fromStorageRow(row) : null;
		},
		updateAll: async (data) =>
			(await query.updateAll(toStorageRow(data))).map((row) => fromStorageRow(row)),
		updateAndCount: (data) => query.updateAndCount(toStorageRow(data)),
		delete: async () => {
			const row = await query.delete();
			return row ? fromStorageRow(row) : null;
		},
		deleteAll: async () => (await query.deleteAll()).map((row) => fromStorageRow(row)),
		deleteAndCount: () => query.deleteAndCount(),
		aggregate: (project) => query.aggregate(project),
	});
	return wrap(collection);
}

/**
 * Escape the characters SQL `LIKE` treats specially so a user-supplied value
 * is matched literally rather than as a pattern. Prisma does *not* do this
 * for you — its `contains` / `startsWith` / `equals + mode: insensitive`
 * filters pass the value straight into `LIKE`, which is a documented
 * long-standing footgun (an `equals` of `"admin%"` matching every admin*
 * row). Better Auth compares credentials and identifiers through these
 * operators, so over-matching here is an auth-bypass class of bug: always
 * escape.
 *
 * Assumption (explicit, because the Prisma Next runtime does not document
 * it): the generated SQL relies on the backend's default `LIKE` escape
 * character. That is `\` on PostgreSQL. SQLite has *no* default escape
 * character unless the statement carries an `ESCAPE '\'` clause, and the
 * field proxy gives us no way to add one — so on SQLite an escaped `%`/`_`
 * degrades to a literal-backslash match, i.e. it *under*-matches. That is
 * the safe direction to fail in for auth predicates; revisit if/when the
 * runtime exposes an escape option.
 */
function escapeLikeLiteral(value: string): string {
	return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}

function likePatternFor(
	value: string,
	operator: "contains" | "starts_with" | "ends_with",
): string {
	const escaped = escapeLikeLiteral(value);
	switch (operator) {
		case "contains":
			return `%${escaped}%`;
		case "starts_with":
			return `${escaped}%`;
		case "ends_with":
			return `%${escaped}`;
	}
}

/**
 * Wrap a raw runtime/driver failure in a `BetterAuthError` that names the
 * model and the operation, keeping the original error as `cause` so nothing
 * is swallowed. `BetterAuthError`s raised by this adapter (or by the core
 * factory) already carry actionable text and pass through untouched.
 */
async function withOperationContext<T>(
	model: string,
	operation: string,
	run: () => Promise<T>,
): Promise<T> {
	try {
		return await run();
	} catch (error) {
		if (error instanceof BetterAuthError) throw error;
		const detail = error instanceof Error ? error.message : String(error);
		throw new BetterAuthError(
			`[prisma8] ${operation} on model "${model}" failed: ${detail}`,
			{ cause: error },
		);
	}
}

export const prisma8Adapter = (db: PrismaNextDb, config: Prisma8AdapterConfig) => {
	// `db.orm` / `db.transaction` are declared `unknown` so that a real
	// generated client is assignable (see `PrismaNextDb`), so the narrowing to
	// the slice this adapter uses happens here, once.
	const runTransaction = db.transaction as
		| (<T>(callback: (tx: PrismaNextTransactionContext) => Promise<T>) => Promise<T>)
		| undefined;
	const dbSupportsTransactions = typeof runTransaction === "function";
	const schemaNamespace = config.schema ?? "public";

	/**
	 * `getOrmCollection` plus the Postgres date-conversion wrapper, in one
	 * call — every collection the adapter touches goes through here so
	 * neither concern can be forgotten at a call site. See
	 * `withDateConversion`'s doc for why this is Postgres-only.
	 */
	const resolveCollection = (
		client: Pick<PrismaNextDb, "orm"> | PrismaNextTransactionContext,
		model: string,
	): PrismaNextOrmCollection => {
		const collection = getOrmCollection(client, model, schemaNamespace);
		return config.provider === "postgresql" ? withDateConversion(collection) : collection;
	};

	if (config.transaction === true && !dbSupportsTransactions) {
		throw new BetterAuthError(
			"[prisma8] `transaction: true` was requested but the provided Prisma Next client has no `db.transaction(...)`. Prisma 8 provides one on PostgreSQL but not on MongoDB — use a Postgres client, or set `transaction: false`.",
		);
	}

	// Bound by the returned `(options) => adapter` call. Held in a mutable
	// closure because `createAdapterFactory` needs the config (including the
	// `transaction` implementation, which itself needs the options to build a
	// nested adapter) before Better Auth ever hands us its options.
	let lazyOptions: BetterAuthOptions | null = null;

	const createCustomAdapter =
		(
			client: Pick<PrismaNextDb, "orm"> | PrismaNextTransactionContext,
			inTransaction = false,
		): AdapterFactoryCustomizeAdapterCreator =>
		({ getFieldName, options: authOptions }) => {
			/**
			 * Run `body` with transactional isolation where that is possible.
			 *
			 * - Already inside a `db.transaction(...)`: reuse it. Opening a
			 *   nested transaction would either deadlock or silently become a
			 *   savepoint, and the enclosing transaction already provides the
			 *   isolation these helpers need.
			 * - Otherwise open one, *regardless of `config.transaction`*: that
			 *   flag is about grouping multiple adapter calls, whereas the
			 *   read-then-guarded-write helpers below are only correct when
			 *   their read and write are in the same transaction.
			 * - If the client has no `transaction` method at all (a partial
			 *   façade or a test double), degrade to running the body
			 *   unwrapped rather than throwing: the guarded predicates still
			 *   make the write conditional on the row not having changed, so
			 *   the worst case is a lost update reported as `null`, not a
			 *   clobbered row.
			 */
			const runInTransaction = async <T>(
				body: (tx: PrismaNextTransactionContext) => Promise<T>,
			): Promise<T> => {
				if (inTransaction || !runTransaction) {
					return body({ orm: client.orm });
				}
				return runTransaction(body);
			};

			const requireField = (
				fields: PrismaNextFieldProxy,
				fieldName: string,
				sourceField = fieldName,
			): PrismaNextFieldProxyEntry => {
				const field = fields[fieldName];
				if (!field) {
					throw new BetterAuthError(
						`Field ${sourceField} (mapped to ${fieldName}) is not present on the ORM field proxy for this query.`,
					);
				}
				return field;
			};

			/** A predicate that is false for every row, on a column of any type. */
			const neverMatches = (field: PrismaNextFieldProxyEntry): unknown =>
				and(field.isNull(), field.isNotNull());

			/** A predicate that is true for every row, on a column of any type. */
			const alwaysMatches = (field: PrismaNextFieldProxyEntry): unknown =>
				or(field.isNull(), field.isNotNull());

			const asArray = (
				value: unknown,
				operator: string,
				field: string,
				model: string,
			): unknown[] => {
				if (!Array.isArray(value)) {
					throw new BetterAuthError(
						`[prisma8] The '${operator}' operator on ${model}.${field} requires an array value, received ${typeof value}.`,
					);
				}
				return value;
			};

			const buildSingleCondition = (
				fields: PrismaNextFieldProxy,
				model: string,
				where: Where,
			): unknown => {
				// `CleanedWhere.field` has already been mapped through
				// `getFieldName` by the factory; re-running it is idempotent
				// (the reverse lookup in `getDefaultFieldName` resolves a
				// mapped name back to its schema key) and keeps this correct
				// for callers that drive the `CustomAdapter` directly with raw
				// schema field names.
				const fieldName = getFieldName({ model, field: where.field });
				const field = requireField(fields, fieldName, where.field);

				// A `Date` value here (e.g. Better Auth comparing `expiresAt` for
				// session-cleanup queries) needs the same storage-side conversion
				// as create/update payloads — see `withDateConversion`'s doc.
				// `where.value` is never touched by that wrapper, since it never
				// passes through the collection's methods; array values (`in` /
				// `not_in`) are mapped element-wise. Non-Date values, including
				// every element of a non-Date array, pass through unchanged.
				const value =
					config.provider === "postgresql"
						? Array.isArray(where.value)
							? where.value.map((v) => toStorageValue(v))
							: toStorageValue(where.value)
						: where.value;

				const operator = where.operator ?? "eq";
				const mode = where.mode ?? "sensitive";
				const isStringValue =
					typeof value === "string" ||
					(Array.isArray(value) && value.every((v) => typeof v === "string"));
				const insensitive = mode === "insensitive" && isStringValue;

				/**
				 * Case-insensitive comparison of a *literal* (not a pattern):
				 * the value is LIKE-escaped first so wildcards inside it stay
				 * literal. PostgreSQL has `ILIKE`; SQLite does not, but its
				 * `LIKE` is already case-insensitive for ASCII by default
				 * (`PRAGMA case_sensitive_like` off), which is the same
				 * fallback Better Auth's own SQL adapters use.
				 */
				const insensitiveLike = (pattern: string): unknown =>
					config.provider === "postgresql" ? field.ilike(pattern) : field.like(pattern);

				/**
				 * `in` / `not_in` have no case-insensitive primitive on the
				 * field proxy — there is no `ilikeIn` — so an insensitive
				 * membership test has to be expanded into one
				 * `ILIKE`-per-member. Only applied when every *non-null*
				 * member is a string: `isStringValue` above is `false` for a
				 * mixed array like `["a", null]`, but the nulls are split off
				 * before this is consulted, so the remaining members can still
				 * be compared insensitively.
				 */
				const insensitiveMembers = (values: readonly unknown[]): boolean =>
					mode === "insensitive" &&
					values.length > 0 &&
					values.every((v) => typeof v === "string");

				/** `or(...)` / `and(...)` that stay a bare condition when given exactly one. */
				const anyOf = (conditions: readonly unknown[]): unknown =>
					conditions.length === 1 ? conditions[0] : or(...conditions);
				const allOf = (conditions: readonly unknown[]): unknown =>
					conditions.length === 1 ? conditions[0] : and(...conditions);

				switch (operator) {
					case "eq": {
						// `= NULL` is never true in SQL; an `eq` against null
						// means "is null" everywhere in Better Auth.
						if (value === null) return field.isNull();
						return insensitive
							? insensitiveLike(escapeLikeLiteral(value as string))
							: field.eq(value);
					}
					case "ne": {
						// `<> NULL` is likewise never true — use IS NOT NULL.
						if (value === null) return field.isNotNull();
						return insensitive
							? not(insensitiveLike(escapeLikeLiteral(value as string)))
							: field.neq(value);
					}
					case "lt":
						return field.lt(value);
					case "lte":
						return field.lte(value);
					case "gt":
						return field.gt(value);
					case "gte":
						return field.gte(value);
					case "in": {
						const raw = asArray(value, operator, where.field, model);
						const hasNull = raw.some((v) => v == null);
						const values = raw.filter((v) => v != null);
						// `x IN (a, NULL)` never matches a NULL `x` in SQL, but
						// Prisma Client's `in: [a, null]` does — mirror Prisma.
						if (values.length === 0) {
							return hasNull ? field.isNull() : neverMatches(field);
						}
						const membership = insensitiveMembers(values)
							? anyOf(
									values.map((v) => insensitiveLike(escapeLikeLiteral(v as string))),
								)
							: field.in(values);
						return hasNull ? or(membership, field.isNull()) : membership;
					}
					case "not_in": {
						const raw = asArray(value, operator, where.field, model);
						const hasNull = raw.some((v) => v == null);
						const values = raw.filter((v) => v != null);
						if (values.length === 0) {
							// Excluding nothing matches everything; excluding
							// only null reads as "is not null".
							return hasNull ? field.isNotNull() : alwaysMatches(field);
						}
						// The insensitive form is `NOT (x ILIKE a OR x ILIKE b)`,
						// i.e. `NOT ILIKE` per member. Getting this wrong
						// *over*-matches — a `not_in` that fails to exclude a
						// differently-cased member returns a row the caller
						// asked to have excluded — which is the auth-bypass
						// direction, so it is expanded rather than silently
						// falling through to the case-sensitive primitive.
						if (insensitiveMembers(values)) {
							return allOf(
								values.map((v) => not(insensitiveLike(escapeLikeLiteral(v as string)))),
							);
						}
						// `notIn` is the documented primitive; `not(in(...))` is
						// the fallback for proxies that don't expose it. Both
						// inherit SQL's three-valued logic: a NULL column value
						// satisfies neither, which is also Prisma's behaviour —
						// as does the `NOT ILIKE` expansion above.
						return field.notIn ? field.notIn(values) : not(field.in(values));
					}
					case "contains":
					case "starts_with":
					case "ends_with": {
						if (typeof where.value !== "string") {
							throw new BetterAuthError(
								`[prisma8] The '${operator}' operator on ${model}.${where.field} requires a string value, received ${typeof where.value}.`,
							);
						}
						const pattern = likePatternFor(where.value, operator);
						return insensitive ? insensitiveLike(pattern) : field.like(pattern);
					}
					default:
						throw new BetterAuthError(`Unsupported where operator: ${operator}`);
				}
			};

			/**
			 * Compose the clauses exactly the way Better Auth's reference
			 * adapters do: every `AND` clause (the default connector) is
			 * required, and the `OR` clauses form a single alternative group
			 * that is itself ANDed onto the required ones — i.e. the classic
			 * Prisma `{ AND: [...], OR: [...] }` where-object, which
			 * intersects the two groups rather than unioning them.
			 *
			 * Consequences worth stating, because getting this wrong is a
			 * silent auth-bypass:
			 * - clauses that are all `OR` (including a lone first clause
			 *   marked `OR`) union with each other and nothing else;
			 * - a single `OR` clause mixed with `AND` clauses is *not* an
			 *   escape hatch that widens the result — it is simply ANDed on;
			 * - the connector on the first clause is not special-cased.
			 */
			const buildPredicate = (
				model: string,
				where: Where[] | undefined,
			): PrismaNextPredicate | undefined => {
				if (!where || where.length === 0) return undefined;
				return (fields: PrismaNextFieldProxy) => {
					const andConditions: unknown[] = [];
					const orConditions: unknown[] = [];
					for (const clause of where) {
						const condition = buildSingleCondition(fields, model, clause);
						if ((clause.connector ?? "AND") === "OR") orConditions.push(condition);
						else andConditions.push(condition);
					}

					const orGroup =
						orConditions.length === 0
							? undefined
							: orConditions.length === 1
								? orConditions[0]
								: or(...orConditions);

					if (andConditions.length === 0) {
						// `where.length > 0`, so an empty AND group implies a
						// non-empty OR group.
						return orGroup;
					}
					const all = orGroup === undefined ? andConditions : [...andConditions, orGroup];
					return all.length === 1 ? all[0] : and(...all);
				};
			};

			const withWhere = (
				collection: PrismaNextOrmCollection,
				model: string,
				where: Where[] | undefined,
			): PrismaNextOrmCollection => {
				const predicate = buildPredicate(model, where);
				return predicate ? collection.where(predicate) : collection;
			};

			const idEqPredicate = (id: unknown): PrismaNextPredicate => (fields) =>
				requireField(fields, "id").eq(id);

			/**
			 * Map a `select` list from Better Auth's *schema field names* to
			 * the column names the ORM addresses.
			 *
			 * The factory pre-maps `where[].field` for us, but not `select` —
			 * it hands the schema keys straight through and then filters its
			 * own output by those same keys after `transformOutput` has mapped
			 * the row back. So a model using Better Auth's `fields` remapping
			 * (`user: { fields: { email: "email_address" } }`) reaches the ORM
			 * asking for a column that does not exist. `sortBy.field` has the
			 * same problem and is already mapped; this closes the gap for
			 * `select`.
			 */
			const toColumnNames = (model: string, select: readonly string[]): string[] =>
				select.map((field) => getFieldName({ model, field }));

			const applyTake = (
				query: PrismaNextOrmCollection,
				count: number,
			): PrismaNextOrmCollection =>
				typeof query.take === "function" ? query.take(count) : query.limit(count);

			const applySkip = (
				query: PrismaNextOrmCollection,
				count: number,
			): PrismaNextOrmCollection =>
				typeof query.skip === "function" ? query.skip(count) : query.offset(count);

			/**
			 * Read-then-guarded-write helper for every mutation that must
			 * touch at most one row (`update`, `delete`, `consumeOne`,
			 * `incrementOne`): find the single target row inside a
			 * transaction, then re-apply the original predicate plus an `id`
			 * guard on the write so a concurrent writer that already
			 * invalidated the predicate causes the write to match zero rows
			 * instead of clobbering a stale read.
			 *
			 * The `id` guard is also what keeps a non-unique predicate from
			 * mutating or deleting sibling rows — the `CustomAdapter` contract
			 * is explicit that `consumeOne` "MUST NOT delete any additional
			 * rows that also match a non-unique predicate", and `update` is
			 * documented as "update a single row".
			 *
			 * Prisma Next's ORM mutations take literal values, not
			 * database-side expressions (there is no `{ increment: n }`
			 * shorthand as in the classic Prisma Client), so this is the only
			 * portable way to do a guarded read-modify-write.
			 */
			const readThenGuardedWrite = async <T>(
				model: string,
				where: Where[] | undefined,
				mutate: (
					tx: PrismaNextTransactionContext,
					target: Record<string, unknown>,
					guardedPredicate: PrismaNextPredicate,
				) => Promise<T | null>,
			): Promise<T | null> =>
				runInTransaction(async (tx) => {
					const collection = resolveCollection(tx, model);
					const target = await withWhere(collection, model, where).first();
					if (!target) return null;
					const id = target["id"];
					if (id === undefined || id === null) {
						throw new BetterAuthError(
							`[prisma8] Cannot safely mutate a single row of ${model}: the row the predicate matched has no 'id'. Ensure the contract model exposes an 'id' column.`,
						);
					}
					const basePredicate = buildPredicate(model, where);
					const guardedPredicate: PrismaNextPredicate = basePredicate
						? (fields) => and(basePredicate(fields), idEqPredicate(id)(fields))
						: idEqPredicate(id);
					return mutate(tx, target, guardedPredicate);
				});

			/**
			 * Normalizes a join key (a scalar FK/PK value) to something
			 * `Map` can compare by identity. Plain equality already works for
			 * the string/number ids every Better Auth join in practice keys
			 * on; `Date` is the one type in this adapter's value space where
			 * two equal-but-distinct instances would otherwise land in
			 * different map buckets.
			 */
			const joinKeyOf = (value: unknown): unknown =>
				value instanceof Date ? value.getTime() : value;

			/**
			 * Resolve every model in `join` for one or more already-fetched
			 * base rows, attaching each under its `join` key exactly as
			 * `transformOutput` expects (`modelName in data` checks the same
			 * key `join` was passed in under).
			 *
			 * This only runs when `options.advanced.database.joins` is on —
			 * otherwise the factory never forwards `join` to this adapter at
			 * all, and instead resolves it itself with `handleFallbackJoin`,
			 * one query per base row per joined model. That per-row fallback
			 * is what this method exists to beat: for `findMany`, every
			 * joined model here costs exactly *one* extra query, however many
			 * base rows there are — collect every base row's `on.from` value,
			 * fetch every matching related row with a single `.in(...)`, and
			 * group the results back onto their base row in this process
			 * rather than in the database.
			 *
			 * `on.from` / `on.to` are already real column names — the core
			 * factory resolves them through `getFieldName` before handing
			 * `join` to this adapter (`transformJoinClause` in
			 * `factory.mjs`), the same as `where[].field`. So this needs no
			 * contract-level relation declaration and works for any join the
			 * factory can describe, including a renamed field or a backwards
			 * (child-holds-the-FK) join — see `should join a model with
			 * modified field name` / the `backwards join` tests.
			 *
			 * There is a real limit-pushdown gap for a to-many join with a
			 * `limit`: SQL has no portable "top N per group" the field-proxy
			 * predicate lane can express, so the batched query fetches every
			 * matching related row for every base row's key and the
			 * per-base-row `limit` is applied in this process instead of in
			 * the query. That trades some over-fetching for correctness —
			 * the row *count* saved by batching (O(1) extra queries instead
			 * of O(base rows)) is the win this exists for; row *volume* per
			 * query is not reduced below what the equivalent N unbatched
			 * queries would have fetched in total.
			 */
			const loadJoins = async (
				model: string,
				rows: readonly Record<string, unknown>[],
				join: JoinConfig,
			): Promise<void> => {
				if (rows.length === 0) return;
				for (const [joinKey, joinConfig] of Object.entries(join)) {
					const { from, to } = joinConfig.on;
					const isOneToOne = joinConfig.relation === "one-to-one";
					const limit = joinConfig.limit ?? 100;

					const distinctValues = new Map<unknown, unknown>();
					for (const row of rows) {
						const value = row[from];
						if (value !== null && value !== undefined) {
							distinctValues.set(joinKeyOf(value), toStorageValue(value));
						}
					}

					const grouped = new Map<unknown, Record<string, unknown>[]>();
					if (distinctValues.size > 0) {
						const joinedCollection = resolveCollection(client, joinKey);
						const matches = await joinedCollection
							.where((fields) => {
								const field = requireField(fields, to);
								return field.in([...distinctValues.values()]);
							})
							.all();
						for (const related of matches) {
							const key = joinKeyOf(related[to]);
							const bucket = grouped.get(key);
							if (bucket) bucket.push(related);
							else grouped.set(key, [related]);
						}
					}

					for (const row of rows) {
						const value = row[from];
						if (value === null || value === undefined) {
							row[joinKey] = isOneToOne ? null : [];
							continue;
						}
						const matches = grouped.get(joinKeyOf(value)) ?? [];
						row[joinKey] = isOneToOne ? (matches[0] ?? null) : matches.slice(0, limit);
					}
				}
			};

			return {
				async create<T extends Record<string, any>>({
					model,
					data,
					select,
				}: {
					model: string;
					data: T;
					select?: string[] | undefined;
				}) {
					return withOperationContext(model, "create", async () => {
						const collection = resolveCollection(client, model);
						const created = await collection.create(data);
						// The core factory never forwards `select` to
						// `CustomAdapter.create` (it filters the created row
						// itself, after `transformOutput`), but the contract
						// declares the parameter, so honour it for anyone
						// driving this adapter directly. Projecting the
						// returned row in JS rather than chaining `.select()`
						// keeps `create`'s single documented shape — the ORM
						// lane does not document `select` on a create.
						if (!select || select.length === 0) return created as T;
						// `created` is keyed by column name, so the projection
						// list has to be too — see `toColumnNames`.
						return Object.fromEntries(
							toColumnNames(model, select)
								.filter((key) => key in created)
								.map((key) => [key, created[key]]),
						) as T;
					});
				},

				async findOne<T>({
					model,
					where,
					select,
					join,
				}: {
					model: string;
					where: Where[];
					select?: string[] | undefined;
					join?: JoinConfig | undefined;
				}) {
					return withOperationContext(model, "findOne", async () => {
						const collection = resolveCollection(client, model);
						let query = withWhere(collection, model, where);
						if (select && select.length > 0) {
							query = query.select(...toColumnNames(model, select));
						}
						const row = (await query.first()) as Record<string, unknown> | null;
						if (row && join && Object.keys(join).length > 0) {
							await loadJoins(model, [row], join);
						}
						return row as T | null;
					});
				},

				async findMany<T>({ model, where, limit, select, sortBy, offset, join }: {
					model: string;
					where?: Where[] | undefined;
					limit: number;
					select?: string[] | undefined;
					sortBy?: { field: string; direction: "asc" | "desc" } | undefined;
					offset?: number | undefined;
					join?: JoinConfig | undefined;
				}) {
					return withOperationContext(model, "findMany", async () => {
						const collection = resolveCollection(client, model);
						let query = withWhere(collection, model, where);
						if (select && select.length > 0) {
							query = query.select(...toColumnNames(model, select));
						}
						if (sortBy?.field) {
							// `sortBy.field` is the one field name the factory
							// does *not* pre-map (unlike `where[].field`), so
							// it must go through `getFieldName` here.
							const fieldName = getFieldName({ model, field: sortBy.field });
							query = query.orderBy((fields) => {
								const field = requireField(fields, fieldName, sortBy.field);
								return sortBy.direction === "desc" ? field.desc() : field.asc();
							});
						}
						// The factory already defaults a missing `limit` to
						// `advanced.database.defaultFindManyLimit ?? 100`, so
						// whatever arrives here is deliberate — including
						// `0`, which means "no rows" (SQL `LIMIT 0`), not "no
						// limit". Only a non-finite or negative value is
						// treated as "unbounded".
						if (Number.isFinite(limit) && limit >= 0) query = applyTake(query, limit);
						if (typeof offset === "number" && offset > 0) query = applySkip(query, offset);
						const rows = (await query.all()) as Record<string, unknown>[];
						if (join && Object.keys(join).length > 0) {
							await loadJoins(model, rows, join);
						}
						return rows as T[];
					});
				},

				async count({ model, where }) {
					return withOperationContext(model, "count", async () => {
						const collection = resolveCollection(client, model);
						const query = withWhere(collection, model, where);
						const result = await query.aggregate((aggregate) => ({
							count: aggregate.count(),
						}));
						// PostgreSQL returns `count(*)` as a bigint, which the
						// driver surfaces as a string — coerce rather than
						// handing Better Auth a string typed as `number`.
						const count = Number(result.count);
						if (!Number.isFinite(count)) {
							throw new BetterAuthError(
								`[prisma8] count on model "${model}" returned a non-numeric aggregate: ${String(result.count)}`,
							);
						}
						return count;
					});
				},

				async update<T>({
					model,
					where,
					update,
				}: {
					model: string;
					where: Where[];
					update: T;
				}) {
					// `update()` is natively single-row: even when the filter
					// matches many, Prisma 8 narrows by identity (a
					// `SELECT … LIMIT 1` over the current filters, then acts on
					// that row) and returns the row it changed, or `null`. That
					// is exactly Better Auth's contract, so it maps straight
					// across — no read-then-write guard needed. Use `updateMany`
					// for the fan-out case.
					return withOperationContext(model, "update", async () => {
						const collection = resolveCollection(client, model);
						const row = await withWhere(collection, model, where).update(
							update as Record<string, unknown>,
						);
						return (row ?? null) as T | null;
					});
				},

				async updateMany({ model, where, update }) {
					// `updateAndCount` is the bulk form that returns the
					// affected count directly; `updateAll` would re-read every
					// changed row only to discard them.
					return withOperationContext(model, "updateMany", async () => {
						const collection = resolveCollection(client, model);
						return withWhere(collection, model, where).updateAndCount(update);
					});
				},

				async delete({ model, where }) {
					// Single-row, like `update()` above. Matching nothing is not
					// an error — `delete()` resolves to `null` and the contract
					// returns `void`.
					await withOperationContext(model, "delete", async () => {
						const collection = resolveCollection(client, model);
						return withWhere(collection, model, where).delete();
					});
				},

				async deleteMany({ model, where }) {
					// `deleteAndCount` gives the affected count in one
					// statement. v0.1.0 emulated this with a `select('id')`
					// read plus a second delete inside a transaction, on the
					// assumption that `.delete()`'s return shape was
					// undocumented — it isn't, and the bulk forms exist.
					return withOperationContext(model, "deleteMany", async () => {
						const collection = resolveCollection(client, model);
						return withWhere(collection, model, where).deleteAndCount();
					});
				},

				async consumeOne<T>({
					model,
					where,
				}: {
					model: string;
					where: Where[];
				}) {
					return withOperationContext(model, "consumeOne", async () =>
						readThenGuardedWrite<T>(model, where, async (tx, target, guardedPredicate) => {
							const collection = resolveCollection(tx, model);
							await collection.where(guardedPredicate).delete();
							return target as T;
						}),
					);
				},

				async incrementOne<T>({
					model,
					where,
					increment,
					set,
				}: {
					model: string;
					where: Where[];
					increment: Record<string, number>;
					set?: Record<string, unknown> | undefined;
				}) {
					return withOperationContext(model, "incrementOne", async () =>
						readThenGuardedWrite<T>(model, where, async (tx, target, guardedPredicate) => {
							const collection = resolveCollection(tx, model);
							const data: Record<string, unknown> = { ...(set ?? {}) };
							for (const [field, delta] of Object.entries(increment)) {
								const current = target[field];
								if (typeof current !== "number") {
									throw new BetterAuthError(
										`Cannot increment non-numeric field ${field} on ${model}.`,
									);
								}
								data[field] = current + delta;
							}
							// Single-row `update()`, gated by the id guard: a concurrent
							// writer that already invalidated the predicate makes this
							// match nothing and return null instead of clobbering a
							// stale read.
							const row = await collection.where(guardedPredicate).update(data);
							return (row ?? null) as T | null;
						}),
					);
				},

				/**
				 * Powers `@better-auth/cli generate`, which resolves this
				 * adapter, hands us the fully-resolved schema (core models plus
				 * whatever the enabled plugins contributed) and writes whatever
				 * `code` we return.
				 *
				 * Unlike the v7 flow — where the CLI emits a `schema.prisma`
				 * that Prisma then migrates from — Prisma Next is
				 * contract-first, so the artifact is a `contract.prisma`. Feed
				 * it through Prisma's own pipeline afterwards
				 * (`prisma contract emit` → `migration plan` → `db migrate`).
				 *
				 * The existing file is read so a re-run appends only the models
				 * that are actually missing, leaving the user's own models and
				 * the contract header untouched. `node:fs` is imported lazily
				 * because this path only ever runs under the CLI — keeping it
				 * out of the module graph means the adapter itself stays
				 * usable on runtimes with no filesystem.
				 */
				async createSchema({ file, tables }) {
					const { createPrisma8Schema } = await import("./schema-generator");
					const { discoverContract } = await import("./contract-discovery");

					// Where the contract lives is the *project's* decision, not
					// ours: `prisma.config.ts` names the one contract source, and
					// its extension also selects the authoring mode. Defaulting
					// straight to `prisma/contract.prisma` would write a second,
					// competing contract next to a project whose real one is at,
					// say, `db/schema/contract.ts` — and Prisma requires exactly
					// one source of truth. An explicit `--output` still wins.
					const discovered = await discoverContract({
						...(file !== undefined ? { file } : {}),
					});

					return createPrisma8Schema({
						tables,
						provider: config.provider,
						usePlural: config.usePlural ?? false,
						// This core version has no `useNumberId` flag: an
						// auto-incrementing integer primary key is requested via
						// `generateId: "serial"` (the database, not Better Auth,
						// mints the id). Every other setting — a custom
						// generator, `"uuid"`, or `false` — keeps string ids.
						useNumberId:
							authOptions.advanced?.database?.generateId === "serial",
						// Mirrors `supportsUUIDs` below: on PostgreSQL the id
						// column gets a database-side `gen_random_uuid()`
						// default instead of Better Auth generating the UUID in
						// application code. Ignored on SQLite, where
						// `supportsUUIDs` stays `false` and Better Auth keeps
						// generating the id itself.
						useUUID:
							config.provider === "postgresql" &&
							authOptions.advanced?.database?.generateId === "uuid",
						file: discovered.path,
						// PSL or the TypeScript builder — whichever the project
						// actually authors in. The config's contract extension is
						// what selects it, for Prisma and for us.
						mode: discovered.mode,
						...(discovered.existingSource !== undefined
							? { existingSchema: discovered.existingSource }
							: {}),
					});
				},

				options: config,
			};
		};

	const factoryConfig: DBAdapterFactoryConfig<BetterAuthOptions> = {
		adapterId: "prisma8",
		adapterName: "Prisma 8 Adapter",
		usePlural: config.usePlural ?? false,
		debugLogs: config.debugLogs ?? false,
		// SQLite has no JSON column type, so the factory stringifies JSON
		// values on the way in and parses them on the way out.
		supportsJSON: config.provider === "postgresql",
		// Same deal for `string[]` / `number[]`: PostgreSQL has native array
		// columns and Prisma Next spells them `field.text().many()`, which is
		// exactly what this package's schema and contract generators emit for
		// Postgres. The factory's default here is `false`, which would make it
		// JSON-*stringify* an array before handing it over — a `text` value
		// into a `text[]` column, which the ORM's array codec rejects with a
		// bare "Cannot read properties of undefined (reading 'codecId')". On
		// SQLite the generators fall back to a serialized TEXT column, so
		// `false` is the correct answer there.
		supportsArrays: config.provider === "postgresql",
		// On PostgreSQL, `advanced.database.generateId: "uuid"` now gets a
		// database-side `gen_random_uuid()` default (see `useUUID` in
		// `createSchema` above and `idExpressionFor` in the generators) rather
		// than Better Auth generating the UUID in application code — matching
		// what `@better-auth/kysely-adapter`, `@better-auth/drizzle-adapter`,
		// and `@better-auth/prisma-adapter` all declare for their Postgres
		// target. `false` on SQLite: nothing in this package's SQLite lane
		// emits a matching default, and declaring `true` without one would
		// have Better Auth omit the id from every insert while the database
		// has no default to fill it with, failing every create with a
		// not-null violation.
		supportsUUIDs: config.provider === "postgresql",
		supportsDates: true,
		supportsBooleans: true,
		// Both targets can express a numeric primary key — `SERIAL`/`IDENTITY`
		// on PostgreSQL, `INTEGER PRIMARY KEY` (the rowid alias, which
		// auto-increments) on SQLite — so `advanced.database.generateId:
		// "serial"` is supported on either. Reporting `false` for SQLite made
		// the factory reject that option and quietly fall back to string ids.
		supportsNumericIds: true,
		transaction:
			(config.transaction ?? false)
				? (cb) =>
						runTransaction!((tx: PrismaNextTransactionContext) => {
							if (!lazyOptions) {
								// Reachable only if a caller grabs the factory
								// config and starts a transaction before
								// Better Auth has initialised the adapter.
								throw new BetterAuthError(
									"[prisma8] adapter.transaction(...) was called before the adapter was initialised with Better Auth options. Pass the adapter to `betterAuth({ database })` first.",
								);
							}
							const adapter = createAdapterFactory({
								// Nested calls must not open a second
								// transaction; `createCustomAdapter(tx, true)`
								// makes the single-row helpers reuse this one.
								config: { ...factoryConfig, transaction: false },
								adapter: createCustomAdapter(tx, true),
							})(lazyOptions);
							return cb(adapter);
						})
				: false,
	};

	const adapterOptions: AdapterFactoryOptions = {
		config: factoryConfig,
		adapter: createCustomAdapter(db),
	};

	const adapter = createAdapterFactory(adapterOptions);
	return (options: BetterAuthOptions): DBAdapter<BetterAuthOptions> => {
		lazyOptions = options;
		return adapter(options);
	};
};

// Re-exported so tests (and consumers writing their own runtime shims) can
// reference the exact `Where` shape the factory hands this adapter.
export type { CleanedWhere };
