import type { BetterAuthOptions } from "@better-auth/core";
import { BetterAuthError } from "@better-auth/core/error";
import { describe, expect, it, vi } from "vitest";
import { prisma8Adapter } from "./prisma8-adapter";
import type { PrismaNextDb, PrismaNextOrmCollection } from "./prisma8-adapter";

interface CollectionState {
	predicate: ((row: Record<string, unknown>) => boolean) | null;
	selected: readonly string[] | null;
	sort: { field: string; direction: "asc" | "desc" } | null;
	take: number | null;
	skip: number;
}

interface CollectionOptions {
	/**
	 * Every field-proxy operator invocation is appended here as
	 * `field.operator:value`, so tests can assert on the *predicate that was
	 * built* (ilike vs like, the escaped pattern, isNull vs a sentinel value)
	 * and not only on which rows the fake happened to return.
	 */
	opLog?: string[];
	/**
	 * Which pagination spelling this fake exposes. `"take"` models the ORM
	 * lane's documented `.take()`/`.skip()`; the `limit`/`offset` members then
	 * throw, proving the adapter prefers `take`/`skip` when they exist.
	 */
	pagination?: "limit" | "take";
	/** Force `aggregate` to return the bigint-as-string PostgreSQL emits. */
	countAsString?: boolean;
}

/**
 * A minimal in-memory stand-in for a Prisma Next ORM collection
 * (`db.orm.<Model>`), just enough to drive the adapter's translation logic
 * without a real Postgres/SQLite connection.
 *
 * Chaining is *immutable*, like the real client: `.where(...)` returns a new
 * collection narrowed by an additional condition and leaves the receiver
 * untouched. (An earlier version of this fake mutated shared state, which
 * meant a `collection.where(...)` issued after a read silently inherited the
 * read's predicate — hiding whether the adapter re-applies its own filters.)
 *
 * Predicates built by the adapter are plain closures produced by the mocked
 * `and` / `or` / `not` combinators below (see the `vi.mock` block) — each one
 * evaluates against a plain row object, so this fake collection can just
 * call the predicate function directly instead of interpreting a real query
 * plan.
 */
function makeCollection(
	initialRows: Record<string, unknown>[] = [],
	options: CollectionOptions = {},
): {
	collection: PrismaNextOrmCollection;
	rows: Record<string, unknown>[];
	spies: {
		create: ReturnType<typeof vi.fn>;
		update: ReturnType<typeof vi.fn>;
		updateAll: ReturnType<typeof vi.fn>;
		updateAndCount: ReturnType<typeof vi.fn>;
		delete: ReturnType<typeof vi.fn>;
		deleteAll: ReturnType<typeof vi.fn>;
		deleteAndCount: ReturnType<typeof vi.fn>;
		select: ReturnType<typeof vi.fn>;
	};
} {
	const rows = [...initialRows];
	const spies = {
		create: vi.fn(),
		update: vi.fn(),
		updateAll: vi.fn(),
		updateAndCount: vi.fn(),
		delete: vi.fn(),
		deleteAll: vi.fn(),
		deleteAndCount: vi.fn(),
		select: vi.fn(),
	};

	const build = (state: CollectionState): PrismaNextOrmCollection => {
		const project = (row: Record<string, unknown>) =>
			state.selected
				? Object.fromEntries(state.selected.map((f) => [f, row[f]]))
				: { ...row };

		/** Rows matching the current predicate, in sort/skip/take order. */
		const matching = () => {
			let result = rows.filter((row) => !state.predicate || state.predicate(row));
			if (state.sort) {
				const { field, direction } = state.sort;
				result = [...result].sort((a, b) => {
					const av = a[field] as never;
					const bv = b[field] as never;
					const cmp = av < bv ? -1 : av > bv ? 1 : 0;
					return direction === "desc" ? -cmp : cmp;
				});
			}
			return result.slice(
				state.skip,
				state.take != null ? state.skip + state.take : undefined,
			);
		};

		const paginationMembers =
			options.pagination === "take"
				? {
						take: (count: number) => build({ ...state, take: count }),
						skip: (count: number) => build({ ...state, skip: count }),
						limit: (): PrismaNextOrmCollection => {
							throw new Error("limit() called on a take/skip collection");
						},
						offset: (): PrismaNextOrmCollection => {
							throw new Error("offset() called on a take/skip collection");
						},
					}
				: {
						limit: (count: number) => build({ ...state, take: count }),
						offset: (count: number) => build({ ...state, skip: count }),
					};

		const collection: PrismaNextOrmCollection = {
			...paginationMembers,
			where(predicateOrObject) {
				const next =
					typeof predicateOrObject === "function"
						? (row: Record<string, unknown>) =>
								Boolean(predicateOrObject(makeFieldProxy(row, options.opLog)))
						: (row: Record<string, unknown>) =>
								Object.entries(predicateOrObject).every(([k, v]) => row[k] === v);
				const previous = state.predicate;
				return build({
					...state,
					predicate: previous ? (row) => previous(row) && next(row) : next,
				});
			},
			select(...fields) {
				spies.select(fields);
				return build({ ...state, selected: fields });
			},
			orderBy(sorter) {
				const fn = Array.isArray(sorter) ? sorter[0]! : sorter;
				const capture: { sort?: { field: string; direction: "asc" | "desc" } } = {};
				const proxy = new Proxy(
					{},
					{
						get(_target, field: string) {
							return {
								asc: () => (capture.sort = { field, direction: "asc" }),
								desc: () => (capture.sort = { field, direction: "desc" }),
							};
						},
					},
				);
				fn(proxy as never);
				return build({ ...state, sort: capture.sort ?? state.sort });
			},
			async all() {
				return matching().map(project);
			},
			async first() {
				const [row] = matching();
				return row ? project(row) : null;
			},
			async create(data) {
				spies.create(data);
				const row = { ...data };
				rows.push(row);
				return project(row);
			},
			// Prisma 8's mutation triple. The singular forms affect exactly
			// one row even when the filter matches many — the runtime narrows
			// by identity — so the fake mirrors that rather than fanning out,
			// which is what lets these tests catch an adapter that reaches for
			// the wrong terminal.
			async update(data) {
				spies.update(data);
				const [row] = matching();
				if (!row) return null;
				Object.assign(row, data);
				return project(row);
			},
			async updateAll(data) {
				spies.updateAll(data);
				const updated: Record<string, unknown>[] = [];
				for (const row of matching()) {
					Object.assign(row, data);
					updated.push(project(row));
				}
				return updated;
			},
			async updateAndCount(data) {
				spies.updateAndCount(data);
				const affected = matching();
				for (const row of affected) Object.assign(row, data);
				return affected.length;
			},
			async delete() {
				spies.delete();
				const [row] = matching();
				if (!row) return null;
				const deleted = project(row);
				rows.splice(rows.indexOf(row), 1);
				return deleted;
			},
			async deleteAll() {
				spies.deleteAll();
				const affected = matching();
				const deleted = affected.map(project);
				for (const row of affected) rows.splice(rows.indexOf(row), 1);
				return deleted;
			},
			async deleteAndCount() {
				spies.deleteAndCount();
				const affected = matching();
				for (const row of affected) rows.splice(rows.indexOf(row), 1);
				return affected.length;
			},
			async aggregate(projectFn) {
				const count = matching().length;
				return projectFn({
					count: () => (options.countAsString ? String(count) : count),
				}) as never;
			},
		};

		return collection;
	};

	return {
		collection: build({
			predicate: null,
			selected: null,
			sort: null,
			take: null,
			skip: 0,
		}),
		rows,
		spies,
	};
}

function makeFieldProxy(row: Record<string, unknown>, opLog?: string[]) {
	return new Proxy(
		{},
		{
			get(_target, field: string) {
				const value = row[field] as never;
				const log = <T>(operator: string, operand: unknown, result: T): T => {
					opLog?.push(
						operand === undefined
							? `${field}.${operator}`
							: `${field}.${operator}:${JSON.stringify(operand)}`,
					);
					return result;
				};
				return {
					eq: (v: unknown) => log("eq", v, value === v),
					neq: (v: unknown) => log("neq", v, value !== v),
					lt: (v: never) => log("lt", v, value < v),
					lte: (v: never) => log("lte", v, value <= v),
					gt: (v: never) => log("gt", v, value > v),
					gte: (v: never) => log("gte", v, value >= v),
					like: (pattern: string) =>
						log("like", pattern, likeToRegExp(pattern, false).test(String(value))),
					ilike: (pattern: string) =>
						log("ilike", pattern, likeToRegExp(pattern, true).test(String(value))),
					in: (values: unknown[]) => log("in", values, values.includes(value)),
					notIn: (values: unknown[]) => log("notIn", values, !values.includes(value)),
					isNull: () => log("isNull", undefined, value == null),
					isNotNull: () => log("isNotNull", undefined, value != null),
				};
			},
		},
	);
}

function likeToRegExp(pattern: string, insensitive: boolean): RegExp {
	// Walk the pattern char-by-char: a backslash escapes the next character
	// as a literal (matching the adapter's own `\`-escaping in
	// `likePatternFor`); a bare `%` / `_` becomes a wildcard; anything else
	// is a regex-escaped literal.
	const escapeRegExpChar = (char: string) => char.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	let regexSource = "";
	for (let i = 0; i < pattern.length; i++) {
		const char = pattern[i]!;
		if (char === "\\" && i + 1 < pattern.length) {
			regexSource += escapeRegExpChar(pattern[++i]!);
		} else if (char === "%") {
			regexSource += ".*";
		} else if (char === "_") {
			regexSource += ".";
		} else {
			regexSource += escapeRegExpChar(char);
		}
	}
	return new RegExp(`^${regexSource}$`, insensitive ? "i" : undefined);
}

// The adapter imports `and` / `or` / `not` from `@prisma/orm-postgres/orm-client`
// (see the comment at the top of prisma8-adapter.ts). That package isn't
// installed in this standalone test run, so it's mocked here.
//
// Every field-proxy operator in `makeFieldProxy` above (`.eq`, `.like`, …)
// evaluates immediately against the row bound to that proxy and returns a
// plain boolean — mirroring how the real API's field-proxy operators
// evaluate against whichever `fields` they were called on (see
// `db.orm.Sale.where((s) => and(s.day.gte(start), s.day.lte(end)))` in the
// prisma-8 skill's queries-postgres.md, where `s.day.gte(start)` is already
// invoked before `and` sees it). So the mock composes plain booleans, not
// re-invokable predicate functions.
vi.mock("@prisma/orm-postgres/orm-client", () => ({
	and: (...conditions: unknown[]) => conditions.every(Boolean),
	or: (...conditions: unknown[]) => conditions.some(Boolean),
	not: (condition: unknown) => !condition,
}));

/**
 * `PrismaNextDb.transaction` is declared `unknown` so a real generated client
 * is assignable; the fakes narrow it back to a concrete signature so tests can
 * `vi.spyOn(db, "transaction")`.
 */
type FakeDb = PrismaNextDb & {
	transaction: <T>(callback: (tx: { orm: unknown }) => Promise<T>) => Promise<T>;
};

function makeDb(collections: Record<string, ReturnType<typeof makeCollection>>): FakeDb {
	// Prisma 8 keys the ORM facet by schema namespace before model:
	// `db.orm.public.User`. The fake mirrors that so the adapter's namespace
	// resolution is actually exercised rather than bypassed.
	const orm = {
		public: Object.fromEntries(
			Object.entries(collections).map(([name, { collection }]) => [name, collection]),
		),
	};
	return {
		orm,
		async transaction<T>(callback: (tx: { orm: unknown }) => Promise<T>) {
			// The fake collections mutate a shared `rows` array directly, so
			// there is no real isolation to model — running the callback
			// against the same `orm` object is enough to exercise the
			// adapter's transaction-composition logic.
			return callback({ orm });
		},
	};
}

/** A client that never grew a `db.transaction(...)` — e.g. a partial façade. */
function makeTransactionlessDb(
	collections: Record<string, ReturnType<typeof makeCollection>>,
): PrismaNextDb {
	// Prisma 8 keys the ORM facet by schema namespace before model:
	// `db.orm.public.User`. The fake mirrors that so the adapter's namespace
	// resolution is actually exercised rather than bypassed.
	const orm = {
		public: Object.fromEntries(
			Object.entries(collections).map(([name, { collection }]) => [name, collection]),
		),
	};
	return { orm } as PrismaNextDb;
}

const createTestAdapter = (
	collections: Record<string, ReturnType<typeof makeCollection>>,
	options: BetterAuthOptions = {},
) => prisma8Adapter(makeDb(collections), { provider: "postgresql" })(options);

const createSqliteAdapter = (
	collections: Record<string, ReturnType<typeof makeCollection>>,
	options: BetterAuthOptions = {},
) => prisma8Adapter(makeDb(collections), { provider: "sqlite" })(options);

// `incrementOne` mutates numeric counters; declare the fields it touches as
// additional fields on `verification` (mirroring the equivalent v7 test
// helper) so the factory's where/input transforms recognize them.
const createCounterAdapter = (collections: Record<string, ReturnType<typeof makeCollection>>) =>
	createTestAdapter(collections, {
		verification: {
			additionalFields: {
				remaining: { type: "number" },
				lastRefill: { type: "number", required: false },
			},
		},
	} as BetterAuthOptions);

describe("prisma8-adapter", () => {
	it("should create the adapter", () => {
		const adapter = prisma8Adapter(makeDb({}), { provider: "postgresql" });
		expect(adapter).toBeDefined();
	});

	it("capitalizes the model name to reach the contract's PascalCase ORM root", async () => {
		const user = makeCollection();
		const adapter = createTestAdapter({ User: user });

		await adapter.create({ model: "user", data: { email: "a@x.io" } });

		expect(user.spies.create).toHaveBeenCalledWith(
			expect.objectContaining({ email: "a@x.io" }),
		);
	});

	it("throws a descriptive error when the contract has no matching model", async () => {
		const adapter = createTestAdapter({});

		await expect(
			adapter.create({ model: "user", data: { email: "a@x.io" } }),
		).rejects.toThrow(/does not exist in the data contract/);
	});

	it("create returns the inserted row, including factory-generated fields", async () => {
		const user = makeCollection();
		const adapter = createTestAdapter({ User: user });

		const result: any = await adapter.create({
			model: "user",
			data: { email: "a@x.io" },
		});

		expect(result).toEqual(
			expect.objectContaining({ id: expect.any(String), email: "a@x.io" }),
		);
	});

	it("findOne applies an equality predicate", async () => {
		const user = makeCollection([
			{ id: "1", email: "a@x.io" },
			{ id: "2", email: "b@x.io" },
		]);
		const adapter = createTestAdapter({ User: user });

		const result = await adapter.findOne({
			model: "user",
			where: [{ field: "email", value: "b@x.io" }],
		});

		expect(result).toEqual({ id: "2", email: "b@x.io" });
	});

	it("findOne returns null when nothing matches", async () => {
		const user = makeCollection([{ id: "1", email: "a@x.io" }]);
		const adapter = createTestAdapter({ User: user });

		const result = await adapter.findOne({
			model: "user",
			where: [{ field: "email", value: "nope@x.io" }],
		});

		expect(result).toBeNull();
	});

	it("findMany filters, sorts, and paginates", async () => {
		const session = makeCollection([
			{ id: "1", userId: "u1", token: "a", createdAt: 1 },
			{ id: "2", userId: "u1", token: "b", createdAt: 3 },
			{ id: "3", userId: "u1", token: "c", createdAt: 2 },
			{ id: "4", userId: "u2", token: "d", createdAt: 4 },
		]);
		const adapter = createTestAdapter({ Session: session });

		const result = await adapter.findMany({
			model: "session",
			where: [{ field: "userId", value: "u1" }],
			sortBy: { field: "createdAt", direction: "desc" },
			limit: 2,
			offset: 0,
		});

		expect(result).toEqual([
			{ id: "2", userId: "u1", token: "b", createdAt: 3 },
			{ id: "3", userId: "u1", token: "c", createdAt: 2 },
		]);
	});

	it("findMany supports the 'in' operator", async () => {
		const user = makeCollection([
			{ id: "1", name: "admin" },
			{ id: "2", name: "user" },
			{ id: "3", name: "admin" },
		]);
		const adapter = createTestAdapter({ User: user });

		const result = await adapter.findMany({
			model: "user",
			where: [{ field: "id", value: ["1", "3"], operator: "in" }],
			limit: 100,
		});

		expect(result.map((r: any) => r.id)).toEqual(["1", "3"]);
	});

	it("findMany with an empty 'in' array matches nothing", async () => {
		const user = makeCollection([{ id: "1" }, { id: "2" }]);
		const adapter = createTestAdapter({ User: user });

		const result = await adapter.findMany({
			model: "user",
			where: [{ field: "id", value: [], operator: "in" }],
			limit: 100,
		});

		expect(result).toEqual([]);
	});

	it("findMany with an empty 'not_in' array matches everything", async () => {
		const user = makeCollection([{ id: "1" }, { id: "2" }]);
		const adapter = createTestAdapter({ User: user });

		const result = await adapter.findMany({
			model: "user",
			where: [{ field: "id", value: [], operator: "not_in" }],
			limit: 100,
		});

		expect(result.map((r: any) => r.id).sort()).toEqual(["1", "2"]);
	});

	it("findMany combines AND and OR connectors: the AND-group and OR-group are ANDed together", async () => {
		const user = makeCollection([
			{ id: "1", email: "a@x.io", emailVerified: false },
			{ id: "2", email: "a@x.io", emailVerified: true },
			{ id: "3", email: "b@x.io", emailVerified: false },
		]);
		const adapter = createTestAdapter({ User: user });

		const result = await adapter.findMany({
			model: "user",
			where: [
				{ field: "email", value: "a@x.io" },
				{ field: "emailVerified", value: true, connector: "OR" },
			],
			limit: 100,
		});

		// Matches the classic Prisma Client semantics this mirrors: a
		// `{ AND: [...], OR: [...] }` where-object ANDs the two groups
		// together, it does not union them. Only row 2 satisfies both
		// "email = a@x.io" (the AND-group) and "emailVerified = true" (the
		// OR-group, here with a single member).
		expect(result.map((r: any) => r.id)).toEqual(["2"]);
	});

	it("findMany matches case-insensitively via ilike on postgresql", async () => {
		const user = makeCollection([{ id: "1", email: "Test@Example.com" }]);
		const adapter = createTestAdapter({ User: user });

		const result = await adapter.findMany({
			model: "user",
			where: [{ field: "email", value: "test@example.com", mode: "insensitive" }],
			limit: 100,
		});

		expect(result).toEqual([{ id: "1", email: "Test@Example.com" }]);
	});

	it("findMany 'contains' escapes LIKE wildcard characters in the value", async () => {
		const user = makeCollection([
			{ id: "1", name: "50% off" },
			{ id: "2", name: "50X off" },
		]);
		const adapter = createTestAdapter({ User: user });

		const result = await adapter.findMany({
			model: "user",
			where: [{ field: "name", value: "50%", operator: "contains" }],
			limit: 100,
		});

		expect(result.map((r: any) => r.id)).toEqual(["1"]);
	});

	it("count aggregates over the active predicate", async () => {
		const user = makeCollection([
			{ id: "1", name: "admin" },
			{ id: "2", name: "user" },
			{ id: "3", name: "admin" },
		]);
		const adapter = createTestAdapter({ User: user });

		const result = await adapter.count({
			model: "user",
			where: [{ field: "name", value: "admin" }],
		});

		expect(result).toBe(2);
	});

	it("update mutates matching rows and returns the first result", async () => {
		const user = makeCollection([{ id: "1", name: "old" }]);
		const adapter = createTestAdapter({ User: user });

		const result = await adapter.update({
			model: "user",
			where: [{ field: "id", value: "1" }],
			update: { name: "new" },
		});

		expect(result).toEqual(expect.objectContaining({ id: "1", name: "new" }));
	});

	it("update returns null when no row matches the predicate", async () => {
		const user = makeCollection([{ id: "1", name: "old" }]);
		const adapter = createTestAdapter({ User: user });

		const result = await adapter.update({
			model: "user",
			where: [{ field: "id", value: "missing" }],
			update: { name: "new" },
		});

		expect(result).toBeNull();
	});

	it("updateMany returns the count of updated rows", async () => {
		const session = makeCollection([
			{ id: "1", userId: "u1" },
			{ id: "2", userId: "u1" },
			{ id: "3", userId: "u2" },
		]);
		const adapter = createTestAdapter({ Session: session });

		const result = await adapter.updateMany({
			model: "session",
			where: [{ field: "userId", value: "u1" }],
			update: { ipAddress: "0.0.0.0" },
		});

		expect(result).toBe(2);
	});

	it("delete removes the matching row", async () => {
		const user = makeCollection([{ id: "1" }, { id: "2" }]);
		const adapter = createTestAdapter({ User: user });

		await adapter.delete({ model: "user", where: [{ field: "id", value: "1" }] });

		expect(user.rows.map((r) => r.id)).toEqual(["2"]);
	});

	it("deleteMany removes every matching row and returns the count", async () => {
		const session = makeCollection([
			{ id: "1", userId: "u1" },
			{ id: "2", userId: "u1" },
			{ id: "3", userId: "u2" },
		]);
		const adapter = createTestAdapter({ Session: session });

		const result = await adapter.deleteMany({
			model: "session",
			where: [{ field: "userId", value: "u1" }],
		});

		expect(result).toBe(2);
		expect(session.rows.map((r) => r.id)).toEqual(["3"]);
	});

	it("deleteMany returns 0 without deleting when nothing matches", async () => {
		const session = makeCollection([{ id: "1", userId: "u1" }]);
		const adapter = createTestAdapter({ Session: session });

		const result = await adapter.deleteMany({
			model: "session",
			where: [{ field: "userId", value: "does-not-exist" }],
		});

		expect(result).toBe(0);
		expect(session.rows).toHaveLength(1);
	});

	it("consumeOne atomically reads and deletes the matching row", async () => {
		const verification = makeCollection([
			{ id: "v1", identifier: "magic-link-token", value: "otp" },
		]);
		const adapter = createTestAdapter({ Verification: verification });

		const result = await adapter.consumeOne({
			model: "verification",
			where: [{ field: "identifier", value: "magic-link-token" }],
		});

		expect(result).toEqual({
			id: "v1",
			identifier: "magic-link-token",
			value: "otp",
		});
		expect(verification.rows).toHaveLength(0);
	});

	it("consumeOne returns null and deletes nothing when there is no match", async () => {
		const verification = makeCollection([{ id: "v1", identifier: "other-token" }]);
		const adapter = createTestAdapter({ Verification: verification });

		const result = await adapter.consumeOne({
			model: "verification",
			where: [{ field: "identifier", value: "magic-link-token" }],
		});

		expect(result).toBeNull();
		expect(verification.rows).toHaveLength(1);
	});

	it("incrementOne increments a numeric field by the given delta", async () => {
		const verification = makeCollection([{ id: "v1", remaining: 3 }]);
		const adapter = createCounterAdapter({ Verification: verification });

		const result = await adapter.incrementOne({
			model: "verification",
			where: [{ field: "id", value: "v1" }],
			increment: { remaining: 1 },
		});

		expect(result).toEqual(expect.objectContaining({ id: "v1", remaining: 4 }));
	});

	it("incrementOne decrements with a negative delta and applies set values", async () => {
		const verification = makeCollection([{ id: "v1", remaining: 2, lastRefill: 0 }]);
		const adapter = createCounterAdapter({ Verification: verification });

		const result = await adapter.incrementOne({
			model: "verification",
			where: [{ field: "remaining", value: 0, operator: "gt" }],
			increment: { remaining: -1 },
			set: { lastRefill: 1700 },
		});

		expect(result).toEqual(
			expect.objectContaining({ id: "v1", remaining: 1, lastRefill: 1700 }),
		);
	});

	it("incrementOne returns null when the guard matches no row", async () => {
		const verification = makeCollection([{ id: "v1", remaining: 0 }]);
		const adapter = createCounterAdapter({ Verification: verification });

		const result = await adapter.incrementOne({
			model: "verification",
			where: [{ field: "remaining", value: 0, operator: "gt" }],
			increment: { remaining: -1 },
		});

		expect(result).toBeNull();
	});

	it("incrementOne throws when the target field is not numeric", async () => {
		const verification = makeCollection([{ id: "v1", remaining: "not-a-number" as any }]);
		const adapter = createCounterAdapter({ Verification: verification });

		await expect(
			adapter.incrementOne({
				model: "verification",
				where: [{ field: "id", value: "v1" }],
				increment: { remaining: 1 },
			}),
		).rejects.toThrow(/Cannot increment non-numeric field/);
	});

	it("routes writes through db.transaction when config.transaction is enabled", async () => {
		const user = makeCollection([{ id: "1", name: "old" }]);
		const db = makeDb({ User: user });
		const transactionSpy = vi.spyOn(db, "transaction");
		const adapter = prisma8Adapter(db, {
			provider: "postgresql",
			transaction: true,
		})({} as BetterAuthOptions);

		await adapter.transaction(async (trx) => {
			await trx.update({
				model: "user",
				where: [{ field: "id", value: "1" }],
				update: { name: "new" },
			});
		});

		expect(transactionSpy).toHaveBeenCalledTimes(1);
	});

	it("consumeOne inside an already-open transaction does not open a nested one", async () => {
		const verification = makeCollection([{ id: "v1", identifier: "magic-link-token" }]);
		const db = makeDb({ Verification: verification });
		const transactionSpy = vi.spyOn(db, "transaction");
		const adapter = prisma8Adapter(db, {
			provider: "postgresql",
			transaction: true,
		})({} as BetterAuthOptions);

		await adapter.transaction(async (trx) => {
			await trx.consumeOne({
				model: "verification",
				where: [{ field: "identifier", value: "magic-link-token" }],
			});
		});

		// One transaction for `adapter.transaction(...)` itself; `consumeOne`
		// must reuse it (via `inTransaction`) rather than opening a second one.
		expect(transactionSpy).toHaveBeenCalledTimes(1);
	});

	describe("predicate composition", () => {
		const rows = [
			{ id: "1", email: "a@x.io", emailVerified: false, name: "alice" },
			{ id: "2", email: "b@x.io", emailVerified: true, name: "bob" },
			{ id: "3", email: "c@x.io", emailVerified: false, name: "carol" },
		];

		it("unions every clause when they are all marked OR", async () => {
			const user = makeCollection(rows);
			const adapter = createTestAdapter({ User: user });

			const result = await adapter.findMany({
				model: "user",
				where: [
					{ field: "email", value: "a@x.io", connector: "OR" },
					{ field: "email", value: "c@x.io", connector: "OR" },
				],
				limit: 100,
			});

			expect(result.map((r: any) => r.id)).toEqual(["1", "3"]);
		});

		it("does not special-case an OR connector on the first clause", async () => {
			const user = makeCollection(rows);
			const adapter = createTestAdapter({ User: user });

			// `emailVerified = true` is the OR-group; `name = alice` is the
			// AND-group. Row 1 satisfies the AND-group but not the OR-group,
			// so nothing matches. If the first clause's connector were
			// (wrongly) treated as "start a union", row 1 or row 2 would leak
			// through — the exact shape of a predicate-composition auth bypass.
			const result = await adapter.findMany({
				model: "user",
				where: [
					{ field: "emailVerified", value: true, connector: "OR" },
					{ field: "name", value: "alice" },
				],
				limit: 100,
			});

			expect(result).toEqual([]);
		});

		it("ANDs every required clause together", async () => {
			const user = makeCollection(rows);
			const adapter = createTestAdapter({ User: user });

			const result = await adapter.findMany({
				model: "user",
				where: [
					{ field: "email", value: "b@x.io" },
					{ field: "emailVerified", value: true },
				],
				limit: 100,
			});

			expect(result.map((r: any) => r.id)).toEqual(["2"]);
		});

		it("intersects the AND-group with a multi-member OR-group", async () => {
			const user = makeCollection(rows);
			const adapter = createTestAdapter({ User: user });

			const result = await adapter.findMany({
				model: "user",
				where: [
					{ field: "emailVerified", value: false },
					{ field: "email", value: "a@x.io", connector: "OR" },
					{ field: "email", value: "b@x.io", connector: "OR" },
				],
				limit: 100,
			});

			// (emailVerified = false) AND (email = a OR email = b) → row 1 only.
			expect(result.map((r: any) => r.id)).toEqual(["1"]);
		});

		it("a lone OR clause behaves exactly like a lone AND clause", async () => {
			const user = makeCollection(rows);
			const adapter = createTestAdapter({ User: user });

			const result = await adapter.findMany({
				model: "user",
				where: [{ field: "email", value: "b@x.io", connector: "OR" }],
				limit: 100,
			});

			expect(result.map((r: any) => r.id)).toEqual(["2"]);
		});
	});

	describe("operator translation", () => {
		it("translates an eq against null to IS NULL rather than `= NULL`", async () => {
			const opLog: string[] = [];
			const account = makeCollection(
				[
					{ id: "1", refreshToken: null },
					{ id: "2", refreshToken: "tok" },
				],
				{ opLog },
			);
			const adapter = createTestAdapter({ Account: account });

			const result = await adapter.findMany({
				model: "account",
				where: [{ field: "refreshToken", value: null }],
				limit: 100,
			});

			expect(result.map((r: any) => r.id)).toEqual(["1"]);
			expect(opLog).toContain("refreshToken.isNull");
			expect(opLog.some((op) => op.startsWith("refreshToken.eq"))).toBe(false);
		});

		it("translates a ne against null to IS NOT NULL", async () => {
			const opLog: string[] = [];
			const account = makeCollection(
				[
					{ id: "1", refreshToken: null },
					{ id: "2", refreshToken: "tok" },
				],
				{ opLog },
			);
			const adapter = createTestAdapter({ Account: account });

			const result = await adapter.findMany({
				model: "account",
				where: [{ field: "refreshToken", value: null, operator: "ne" }],
				limit: 100,
			});

			expect(result.map((r: any) => r.id)).toEqual(["2"]);
			expect(opLog).toContain("refreshToken.isNotNull");
		});

		it("escapes LIKE wildcards in a case-insensitive eq so it cannot over-match", async () => {
			const opLog: string[] = [];
			const user = makeCollection(
				[
					{ id: "1", email: "admin@x.io" },
					{ id: "2", email: "ADMIN%@x.io" },
				],
				{ opLog },
			);
			const adapter = createTestAdapter({ User: user });

			// Unescaped, `ILIKE 'admin%'` would match row 1 as well — an
			// identifier lookup silently turning into a prefix search.
			const result = await adapter.findMany({
				model: "user",
				where: [{ field: "email", value: "admin%@x.io", mode: "insensitive" }],
				limit: 100,
			});

			expect(result.map((r: any) => r.id)).toEqual(["2"]);
			expect(opLog).toContain('email.ilike:"admin\\\\%@x.io"');
		});

		it("escapes LIKE wildcards in a case-insensitive ne", async () => {
			const user = makeCollection([
				{ id: "1", email: "admin@x.io" },
				{ id: "2", email: "ADMIN%@x.io" },
			]);
			const adapter = createTestAdapter({ User: user });

			const result = await adapter.findMany({
				model: "user",
				where: [
					{ field: "email", value: "admin%@x.io", operator: "ne", mode: "insensitive" },
				],
				limit: 100,
			});

			expect(result.map((r: any) => r.id)).toEqual(["1"]);
		});

		it("falls back to LIKE for insensitive matching on sqlite, which has no ILIKE", async () => {
			const opLog: string[] = [];
			const user = makeCollection([{ id: "1", email: "Test@Example.com" }], { opLog });
			const adapter = createSqliteAdapter({ User: user });

			await adapter.findMany({
				model: "user",
				where: [{ field: "email", value: "test@example.com", mode: "insensitive" }],
				limit: 100,
			});

			expect(opLog).toContain('email.like:"test@example.com"');
			expect(opLog.some((op) => op.startsWith("email.ilike"))).toBe(false);
		});

		it("matches case-insensitively for 'in', which has no ILIKE-membership primitive", async () => {
			const opLog: string[] = [];
			const user = makeCollection(
				[
					{ id: "1", email: "InArray@Test.COM" },
					{ id: "2", email: "other@test.com" },
				],
				{ opLog },
			);
			const adapter = createTestAdapter({ User: user });

			const result = await adapter.findMany({
				model: "user",
				where: [
					{
						field: "email",
						value: ["inarray@test.com", "third@test.com"],
						operator: "in",
						mode: "insensitive",
					},
				],
				limit: 100,
			});

			expect(result.map((r: any) => r.id)).toEqual(["1"]);
			// Expanded to one ILIKE per member rather than a case-sensitive
			// `IN (...)`, which would have matched nothing.
			expect(opLog).toContain('email.ilike:"inarray@test.com"');
			expect(opLog).toContain('email.ilike:"third@test.com"');
			expect(opLog.some((op) => op.startsWith("email.in"))).toBe(false);
		});

		it("excludes case-insensitively for 'not_in' rather than silently over-matching", async () => {
			const opLog: string[] = [];
			const user = makeCollection(
				[
					{ id: "1", email: "NotIn@Exclude.Test" },
					{ id: "2", email: "keep@test.com" },
				],
				{ opLog },
			);
			const adapter = createTestAdapter({ User: user });

			// The dangerous direction: a case-sensitive `NOT IN` would return
			// row 1 too, i.e. fail to exclude what the caller asked to exclude.
			const result = await adapter.findMany({
				model: "user",
				where: [
					{
						field: "email",
						value: ["notin@exclude.test"],
						operator: "not_in",
						mode: "insensitive",
					},
				],
				limit: 100,
			});

			expect(result.map((r: any) => r.id)).toEqual(["2"]);
			expect(opLog).toContain('email.ilike:"notin@exclude.test"');
			expect(opLog.some((op) => op.startsWith("email.notIn"))).toBe(false);
		});

		it("escapes LIKE wildcards in every member of a case-insensitive 'in'", async () => {
			const opLog: string[] = [];
			const user = makeCollection(
				[
					{ id: "1", email: "admin@x.io" },
					{ id: "2", email: "ADMIN%@x.io" },
				],
				{ opLog },
			);
			const adapter = createTestAdapter({ User: user });

			const result = await adapter.findMany({
				model: "user",
				where: [
					{
						field: "email",
						value: ["admin%@x.io"],
						operator: "in",
						mode: "insensitive",
					},
				],
				limit: 100,
			});

			expect(result.map((r: any) => r.id)).toEqual(["2"]);
			expect(opLog).toContain('email.ilike:"admin\\\\%@x.io"');
		});

		it("keeps a case-sensitive 'in' when the members are not all strings", async () => {
			const opLog: string[] = [];
			const session = makeCollection([{ id: 1 }, { id: 2 }], { opLog });
			const adapter = createTestAdapter({ Session: session });

			// `mode: "insensitive"` is meaningless for a numeric column, and
			// expanding it into ILIKE would be a type error on PostgreSQL.
			const result = await adapter.findMany({
				model: "session",
				where: [{ field: "id", value: [1], operator: "in", mode: "insensitive" }],
				limit: 100,
			});

			// The factory stringifies ids on the way out.
			expect(result.map((r: any) => r.id)).toEqual(["1"]);
			expect(opLog.some((op) => op.startsWith("id.in"))).toBe(true);
			expect(opLog.some((op) => op.startsWith("id.ilike"))).toBe(false);
		});

		it("builds the empty-'in' contradiction from IS NULL / IS NOT NULL, not a string sentinel", async () => {
			const opLog: string[] = [];
			// A numeric column: comparing it to a `'__never_matches__'` string
			// sentinel would be a type error on PostgreSQL.
			const session = makeCollection([{ id: 1 }, { id: 2 }], { opLog });
			const adapter = createTestAdapter({ Session: session });

			const result = await adapter.findMany({
				model: "session",
				where: [{ field: "id", value: [], operator: "in" }],
				limit: 100,
			});

			expect(result).toEqual([]);
			// The predicate is evaluated once per row, so assert on the set of
			// distinct operators it is built from.
			expect([...new Set(opLog)]).toEqual(["id.isNull", "id.isNotNull"]);
			expect(opLog.join()).not.toContain("__never_matches__");
		});

		it("prefers the field proxy's native notIn over not(in(...))", async () => {
			const opLog: string[] = [];
			const user = makeCollection([{ id: "1" }, { id: "2" }, { id: "3" }], { opLog });
			const adapter = createTestAdapter({ User: user });

			const result = await adapter.findMany({
				model: "user",
				where: [{ field: "id", value: ["1", "3"], operator: "not_in" }],
				limit: 100,
			});

			expect(result.map((r: any) => r.id)).toEqual(["2"]);
			expect(opLog.some((op) => op.startsWith("id.notIn"))).toBe(true);
		});

		it("treats a null inside an 'in' list as an IS NULL alternative", async () => {
			const account = makeCollection([
				{ id: "1", scope: null },
				{ id: "2", scope: "email" },
				{ id: "3", scope: "profile" },
			]);
			const adapter = createTestAdapter({ Account: account });

			const result = await adapter.findMany({
				model: "account",
				where: [{ field: "scope", value: ["email", null] as never, operator: "in" }],
				limit: 100,
			});

			expect(result.map((r: any) => r.id)).toEqual(["1", "2"]);
		});

		it("rejects a non-array value for 'in' with an actionable error", async () => {
			const user = makeCollection([{ id: "1" }]);
			const adapter = createTestAdapter({ User: user });

			await expect(
				adapter.findMany({
					model: "user",
					// The factory only array-checks `in`, so `not_in` can reach
					// the adapter with a scalar.
					where: [{ field: "id", value: "1", operator: "not_in" }],
					limit: 100,
				}),
			).rejects.toThrow(/requires an array value/);
		});
	});

	describe("findMany pagination and projection", () => {
		it("honours limit: 0 as 'no rows' instead of falling back to 100", async () => {
			const session = makeCollection([{ id: "1" }, { id: "2" }]);
			const adapter = createTestAdapter({ Session: session });

			const result = await adapter.findMany({
				model: "session",
				limit: 0,
			});

			expect(result).toEqual([]);
		});

		it("sorts ascending through the typed field-proxy asc()", async () => {
			const session = makeCollection([
				{ id: "1", createdAt: 3 },
				{ id: "2", createdAt: 1 },
				{ id: "3", createdAt: 2 },
			]);
			const adapter = createTestAdapter({ Session: session });

			const result = await adapter.findMany({
				model: "session",
				sortBy: { field: "createdAt", direction: "asc" },
				limit: 100,
			});

			expect(result.map((r: any) => r.id)).toEqual(["2", "3", "1"]);
		});

		it("prefers the ORM lane's take()/skip() when the collection exposes them", async () => {
			const session = makeCollection(
				[{ id: "1" }, { id: "2" }, { id: "3" }],
				{ pagination: "take" },
			);
			const adapter = createTestAdapter({ Session: session });

			// `limit()`/`offset()` throw on this collection, so reaching a
			// result at all proves `take`/`skip` were used.
			const result = await adapter.findMany({
				model: "session",
				limit: 1,
				offset: 1,
			});

			expect(result.map((r: any) => r.id)).toEqual(["2"]);
		});

		it("create projects the row down to `select` when one is supplied", async () => {
			const user = makeCollection();
			const adapter = prisma8Adapter(makeDb({ User: user }), {
				provider: "postgresql",
			})({} as BetterAuthOptions);

			// Driving the underlying CustomAdapter through the factory's
			// `create` also filters by `select`, so assert on the merged
			// behaviour: only the selected key survives.
			const result: any = await adapter.create({
				model: "user",
				data: { email: "a@x.io", name: "alice" },
				select: ["email"],
			});

			expect(result).toEqual({ email: "a@x.io" });
		});

		it("coerces a PostgreSQL bigint count returned as a string", async () => {
			const user = makeCollection([{ id: "1" }, { id: "2" }], { countAsString: true });
			const adapter = createTestAdapter({ User: user });

			const result = await adapter.count({ model: "user" });

			expect(result).toBe(2);
			expect(typeof result).toBe("number");
		});
	});

	describe("single-row write safety", () => {
		it("update touches only one row when the predicate is not unique", async () => {
			const session = makeCollection([
				{ id: "1", userId: "u1", ipAddress: "old" },
				{ id: "2", userId: "u1", ipAddress: "old" },
			]);
			const adapter = createTestAdapter({ Session: session });

			const result: any = await adapter.update({
				model: "session",
				where: [{ field: "userId", value: "u1" }],
				update: { ipAddress: "new" },
			});

			expect(result.id).toBe("1");
			// The sibling row must be untouched — a bare
			// `.where(pred).update(...)` would have rewritten both.
			expect(session.rows.map((r) => r.ipAddress)).toEqual(["new", "old"]);
		});

		it("delete removes only one row when the predicate is not unique", async () => {
			const session = makeCollection([
				{ id: "1", userId: "u1" },
				{ id: "2", userId: "u1" },
			]);
			const adapter = createTestAdapter({ Session: session });

			await adapter.delete({
				model: "session",
				where: [{ field: "userId", value: "u1" }],
			});

			expect(session.rows.map((r) => r.id)).toEqual(["2"]);
		});

		it("consumeOne deletes at most one row for a non-unique predicate", async () => {
			const verification = makeCollection([
				{ id: "v1", identifier: "otp", value: "a" },
				{ id: "v2", identifier: "otp", value: "b" },
			]);
			const adapter = createTestAdapter({ Verification: verification });

			const result: any = await adapter.consumeOne({
				model: "verification",
				where: [{ field: "identifier", value: "otp" }],
			});

			expect(result.id).toBe("v1");
			expect(verification.rows.map((r) => r.id)).toEqual(["v2"]);
		});
	});

	describe("transaction fallbacks", () => {
		it("throws at construction when transaction: true but the client has none", () => {
			expect(() =>
				prisma8Adapter(makeTransactionlessDb({}), {
					provider: "postgresql",
					transaction: true,
				}),
			).toThrow(/has no `db.transaction/);
		});

		it("consumeOne still works against a client without db.transaction", async () => {
			const verification = makeCollection([{ id: "v1", identifier: "otp" }]);
			const adapter = prisma8Adapter(makeTransactionlessDb({ Verification: verification }), {
				provider: "postgresql",
			})({} as BetterAuthOptions);

			const result: any = await adapter.consumeOne({
				model: "verification",
				where: [{ field: "identifier", value: "otp" }],
			});

			expect(result.id).toBe("v1");
			expect(verification.rows).toEqual([]);
		});

		it("deleteMany still works against a client without db.transaction", async () => {
			const session = makeCollection([
				{ id: "1", userId: "u1" },
				{ id: "2", userId: "u1" },
			]);
			const adapter = prisma8Adapter(makeTransactionlessDb({ Session: session }), {
				provider: "postgresql",
			})({} as BetterAuthOptions);

			const result = await adapter.deleteMany({
				model: "session",
				where: [{ field: "userId", value: "u1" }],
			});

			expect(result).toBe(2);
			expect(session.rows).toEqual([]);
		});

		it("single-row writes still open a transaction when config.transaction is false", async () => {
			const verification = makeCollection([{ id: "v1", identifier: "otp" }]);
			const db = makeDb({ Verification: verification });
			const transactionSpy = vi.spyOn(db, "transaction");
			const adapter = prisma8Adapter(db, {
				provider: "postgresql",
				transaction: false,
			})({} as BetterAuthOptions);

			await adapter.consumeOne({
				model: "verification",
				where: [{ field: "identifier", value: "otp" }],
			});

			// `config.transaction` governs the *grouping* entry point, not the
			// atomicity that consumeOne's read-then-guarded-write depends on.
			expect(transactionSpy).toHaveBeenCalledTimes(1);
		});
	});

	describe("error reporting", () => {
		it("wraps a raw driver failure in a BetterAuthError naming the model and operation", async () => {
			const user = makeCollection();
			const driverError = new Error("connection terminated unexpectedly");
			user.spies.create.mockImplementation(() => {
				throw driverError;
			});
			const adapter = createTestAdapter({ User: user });

			const failure = await adapter
				.create({ model: "user", data: { email: "a@x.io" } })
				.then(() => null)
				.catch((error: unknown) => error);

			expect(failure).toBeInstanceOf(BetterAuthError);
			expect((failure as Error).message).toMatch(/create on model "user" failed/);
			expect((failure as Error).message).toContain("connection terminated unexpectedly");
			// The original error is preserved, not swallowed.
			expect((failure as Error).cause).toBe(driverError);
		});

		it("does not re-wrap a BetterAuthError raised by the adapter itself", async () => {
			const adapter = createTestAdapter({});

			const failure = await adapter
				.findOne({ model: "user", where: [{ field: "id", value: "1" }] })
				.then(() => null)
				.catch((error: unknown) => error);

			expect(failure).toBeInstanceOf(BetterAuthError);
			expect((failure as Error).message).toMatch(/does not exist in the data contract/);
			expect((failure as Error).message).not.toMatch(/findOne on model/);
		});
	});
});

/**
 * Regressions for the four API-surface errors shipped in v0.1.0. Each of these
 * would have been caught before publish by a fake that modelled the real
 * runtime rather than the one the adapter wished for, so they are pinned
 * explicitly rather than left to the behavioural tests above.
 */
describe("v0.1.0 regressions", () => {
	it("addresses models under the schema namespace, not directly off db.orm", async () => {
		const user = makeCollection([{ id: "1", email: "a@x.io" }]);
		// A flat `db.orm.User` client — what v0.1.0 assumed — must now fail
		// loudly rather than appear to work.
		const flatDb = { orm: { User: user.collection } } as PrismaNextDb;
		const adapter = prisma8Adapter(flatDb, { provider: "postgresql" })({});

		const failure = await adapter
			.findOne({ model: "user", where: [{ field: "id", value: "1" }] })
			.catch((error: unknown) => error);

		expect((failure as Error).message).toMatch(/Schema namespace 'public' does not exist/);
		// The error names what *is* there, so a wrong `schema` is diagnosable.
		expect((failure as Error).message).toMatch(/available: User/);
	});

	it("honours a non-default schema namespace", async () => {
		const user = makeCollection([{ id: "1", email: "a@x.io" }]);
		const db = { orm: { auth: { User: user.collection } } } as PrismaNextDb;
		const adapter = prisma8Adapter(db, { provider: "postgresql", schema: "auth" })({});

		const found = await adapter.findOne<{ id: string }>({
			model: "user",
			where: [{ field: "id", value: "1" }],
		});

		expect(found?.id).toBe("1");
	});

	it("reports the configured namespace when it is missing", async () => {
		const user = makeCollection([{ id: "1" }]);
		const adapter = prisma8Adapter(makeDb({ User: user }), {
			provider: "postgresql",
			schema: "tenant_a",
		})({});

		const failure = await adapter
			.findOne({ model: "user", where: [{ field: "id", value: "1" }] })
			.catch((error: unknown) => error);

		expect((failure as Error).message).toMatch(/Schema namespace 'tenant_a' does not exist/);
	});

	it("uses the singular update terminal for update, never the bulk forms", async () => {
		const user = makeCollection([
			{ id: "1", name: "old" },
			{ id: "2", name: "old" },
		]);
		const adapter = createTestAdapter({ User: user });

		await adapter.update({
			model: "user",
			where: [{ field: "name", value: "old" }],
			update: { name: "new" },
		});

		expect(user.spies.update).toHaveBeenCalledWith(
			expect.objectContaining({ name: "new" }),
		);
		expect(user.spies.updateAll).not.toHaveBeenCalled();
		expect(user.spies.updateAndCount).not.toHaveBeenCalled();
	});

	it("uses updateAndCount for updateMany rather than re-reading every row", async () => {
		const user = makeCollection([
			{ id: "1", name: "old" },
			{ id: "2", name: "old" },
		]);
		const adapter = createTestAdapter({ User: user });

		const affected = await adapter.updateMany({
			model: "user",
			where: [{ field: "name", value: "old" }],
			update: { name: "new" },
		});

		expect(affected).toBe(2);
		expect(user.spies.updateAndCount).toHaveBeenCalledWith(
			expect.objectContaining({ name: "new" }),
		);
		expect(user.spies.update).not.toHaveBeenCalled();
		expect(user.spies.updateAll).not.toHaveBeenCalled();
	});

	it("uses the singular delete terminal for delete", async () => {
		const user = makeCollection([
			{ id: "1", name: "dupe" },
			{ id: "2", name: "dupe" },
		]);
		const adapter = createTestAdapter({ User: user });

		await adapter.delete({ model: "user", where: [{ field: "name", value: "dupe" }] });

		expect(user.spies.delete).toHaveBeenCalled();
		expect(user.spies.deleteAndCount).not.toHaveBeenCalled();
		// Exactly one row gone — `delete()` never fans out.
		expect(await adapter.count({ model: "user" })).toBe(1);
	});

	describe("select field-name mapping", () => {
		// `user: { fields: { email: "email_address" } }` is Better Auth's
		// documented column-remapping option. The factory pre-maps
		// `where[].field` for the adapter but hands `select` through as raw
		// *schema* keys, then filters its own output by those same keys — so
		// the adapter has to do the column mapping itself or the ORM is asked
		// for a column that does not exist.
		const remapped: BetterAuthOptions = {
			user: { fields: { email: "email_address" } },
		};

		it("maps a findMany select to column names", async () => {
			const user = makeCollection([
				{ id: "1", name: "ada", email_address: "ada@x.io" },
			]);
			const adapter = createTestAdapter({ User: user }, remapped);

			const result = await adapter.findMany({
				model: "user",
				where: [],
				limit: 100,
				select: ["email"],
			});

			expect(user.spies.select).toHaveBeenCalledWith(["email_address"]);
			expect(result).toEqual([{ email: "ada@x.io" }]);
		});

		it("maps a findOne select to column names", async () => {
			const user = makeCollection([
				{ id: "1", name: "ada", email_address: "ada@x.io" },
			]);
			const adapter = createTestAdapter({ User: user }, remapped);

			const result = await adapter.findOne({
				model: "user",
				where: [{ field: "id", value: "1" }],
				select: ["email"],
			});

			expect(user.spies.select).toHaveBeenCalledWith(["email_address"]);
			expect(result).toEqual({ email: "ada@x.io" });
		});

		it("projects a create select by column name", async () => {
			const user = makeCollection([]);
			const adapter = createTestAdapter({ User: user }, remapped);

			const created = await adapter.create({
				model: "user",
				data: { id: "1", name: "ada", email: "ada@x.io" },
				select: ["email"],
				forceAllowId: true,
			});

			// `created` comes back keyed by column name, so the projection has
			// to be too; keying it by the schema name dropped every field.
			expect(created).toEqual({ email: "ada@x.io" });
		});

		it("leaves an unmapped select untouched", async () => {
			const user = makeCollection([{ id: "1", name: "ada", email: "ada@x.io" }]);
			const adapter = createTestAdapter({ User: user });

			await adapter.findMany({
				model: "user",
				where: [],
				limit: 100,
				select: ["email", "name"],
			});

			expect(user.spies.select).toHaveBeenCalledWith(["email", "name"]);
		});
	});

	describe("capability flags", () => {
		it("declares supportsUUIDs on postgresql, matching the official adapters' own Postgres targets", () => {
			const adapter = createTestAdapter({});
			expect(adapter.options?.adapterConfig.supportsUUIDs).toBe(true);
		});

		it("leaves supportsUUIDs false on sqlite, since nothing in that lane emits a matching default", () => {
			const adapter = createSqliteAdapter({});
			expect(adapter.options?.adapterConfig.supportsUUIDs).toBe(false);
		});
	});

	describe("array support", () => {
		it("declares native array support on postgresql so arrays are not stringified", async () => {
			const user = makeCollection([]);
			const adapter = createTestAdapter({ User: user }, {
				user: { additionalFields: { tags: { type: "string[]", required: false } } },
			});

			await adapter.create({
				model: "user",
				data: { id: "1", name: "ada", email: "ada@x.io", tags: ["a", "b"] },
				forceAllowId: true,
			});

			// With the factory's `supportsArrays` default of `false` this
			// arrives as the JSON string '["a","b"]', which a Postgres
			// `text[]` column cannot encode.
			expect(user.spies.create).toHaveBeenCalledWith(
				expect.objectContaining({ tags: ["a", "b"] }),
			);
		});

		it("lets the factory serialize arrays on sqlite, which has no array column", async () => {
			const user = makeCollection([]);
			const adapter = createSqliteAdapter({ User: user }, {
				user: { additionalFields: { tags: { type: "string[]", required: false } } },
			});

			await adapter.create({
				model: "user",
				data: { id: "1", name: "ada", email: "ada@x.io", tags: ["a", "b"] },
				forceAllowId: true,
			});

			expect(user.spies.create).toHaveBeenCalledWith(
				expect.objectContaining({ tags: '["a","b"]' }),
			);
		});
	});

	describe("native join pushdown (advanced.database.joins: true)", () => {
		// `session.userId` is a built-in Better Auth field with
		// `references: { model: "user", field: "id" }`, so no custom schema
		// is needed to exercise a real to-many join. These tests call the
		// *factory-wrapped* adapter (`createTestAdapter`), so `join` is
		// passed in Better Auth's public `JoinOption` shape (`{ model: true
		// }`) — the factory computes the resolved `on`/`relation` itself from
		// the real schema before handing this adapter's `findOne`/`findMany`
		// the `JoinConfig` shape `loadJoins` actually consumes.
		const joinsEnabled: BetterAuthOptions = { advanced: { database: { joins: true } } };

		// `session.userId` isn't declared unique, so it always resolves as
		// one-to-many regardless of what the caller asks for. To exercise the
		// one-to-one branch, add a plugin model with a genuinely unique FK —
		// the same shape the official conformance suite's `oneToOneTable`
		// fixture uses for its own "modified field name" join test.
		const withOneToOneModel: BetterAuthOptions = {
			...joinsEnabled,
			plugins: [
				{
					id: "one-to-one-test",
					schema: {
						oneToOneTable: {
							fields: {
								oneToOne: {
									type: "string",
									required: true,
									references: { field: "id", model: "user" },
									unique: true,
								},
							},
						},
					},
				},
			],
		};

		it("resolves a to-many join with a single batched query, not one per base row", async () => {
			const opLog: string[] = [];
			const user = makeCollection([
				{ id: "u1", name: "a" },
				{ id: "u2", name: "b" },
				{ id: "u3", name: "c" },
			]);
			const session = makeCollection(
				[
					{ id: "s1", userId: "u1", token: "t1" },
					{ id: "s2", userId: "u1", token: "t2" },
					{ id: "s3", userId: "u2", token: "t3" },
					// u3 has no session.
				],
				{ opLog },
			);
			const adapter = createTestAdapter({ User: user, Session: session }, joinsEnabled);

			const result: any[] = await adapter.findMany({
				model: "user",
				where: [],
				limit: 100,
				join: { session: true },
			});

			expect(result.find((r: any) => r.id === "u1").session.map((s: any) => s.id).sort()).toEqual([
				"s1",
				"s2",
			]);
			expect(result.find((r: any) => r.id === "u2").session.map((s: any) => s.id)).toEqual(["s3"]);
			expect(result.find((r: any) => r.id === "u3").session).toEqual([]);

			// Batched: exactly one predicate shape (`in`, over every base row's
			// id at once), never a per-row `eq`. An N+1 implementation would
			// show up here as three separate `userId.eq:"u..."` entries.
			expect(opLog.some((op) => op.startsWith("userId.eq"))).toBe(false);
			expect(opLog.every((op) => op.startsWith("userId.in:"))).toBe(true);
			expect(new Set(opLog)).toEqual(new Set(['userId.in:["u1","u2","u3"]']));
		});

		it("resolves a to-one join, unwrapping to a single object or null", async () => {
			const user = makeCollection([{ id: "u1" }, { id: "u2" }]);
			const oneToOneTable = makeCollection([{ id: "o1", oneToOne: "u1" }]);
			const adapter = createTestAdapter(
				{ User: user, OneToOneTable: oneToOneTable },
				withOneToOneModel,
			);

			const result: any[] = await adapter.findMany({
				model: "user",
				where: [],
				limit: 100,
				join: { oneToOneTable: true },
			});

			expect(result.find((r: any) => r.id === "u1").oneToOneTable).toEqual(
				expect.objectContaining({ id: "o1" }),
			);
			expect(result.find((r: any) => r.id === "u2").oneToOneTable).toBeNull();
		});

		it("truncates a to-many join to its configured limit, per base row", async () => {
			const user = makeCollection([{ id: "u1" }]);
			const session = makeCollection([
				{ id: "s1", userId: "u1" },
				{ id: "s2", userId: "u1" },
				{ id: "s3", userId: "u1" },
			]);
			const adapter = createTestAdapter({ User: user, Session: session }, joinsEnabled);

			const result: any[] = await adapter.findMany({
				model: "user",
				where: [],
				limit: 100,
				join: { session: { limit: 2 } },
			});

			expect(result[0].session).toHaveLength(2);
		});

		it("skips the join query entirely when the base result set is empty", async () => {
			const user = makeCollection([]);
			const session = makeCollection([{ id: "s1", userId: "u1" }]);
			const sessionWhereSpy = vi.spyOn(session.collection, "where");
			const adapter = createTestAdapter({ User: user, Session: session }, joinsEnabled);

			const result = await adapter.findMany({
				model: "user",
				where: [{ field: "id", value: "does-not-exist" }],
				limit: 100,
				join: { session: true },
			});

			expect(result).toEqual([]);
			expect(sessionWhereSpy).not.toHaveBeenCalled();
		});

		it("resolves a join for findOne without an extra query per call", async () => {
			const user = makeCollection([{ id: "u1" }]);
			const session = makeCollection([{ id: "s1", userId: "u1" }]);
			const adapter = createTestAdapter({ User: user, Session: session }, joinsEnabled);

			const result: any = await adapter.findOne({
				model: "user",
				where: [{ field: "id", value: "u1" }],
				join: { session: true },
			});

			expect(result.session.map((s: any) => s.id)).toEqual(["s1"]);
		});

		it("does not query the joined model when findOne matches nothing", async () => {
			const user = makeCollection([]);
			const session = makeCollection([{ id: "s1", userId: "u1" }]);
			const sessionWhereSpy = vi.spyOn(session.collection, "where");
			const adapter = createTestAdapter({ User: user, Session: session }, joinsEnabled);

			const result = await adapter.findOne({
				model: "user",
				where: [{ field: "id", value: "u1" }],
				join: { session: true },
			});

			expect(result).toBeNull();
			expect(sessionWhereSpy).not.toHaveBeenCalled();
		});
	});

	it("uses deleteAndCount for deleteMany instead of a select-then-delete round trip", async () => {
		const user = makeCollection([
			{ id: "1", name: "dupe" },
			{ id: "2", name: "dupe" },
			{ id: "3", name: "keep" },
		]);
		const adapter = createTestAdapter({ User: user });

		const affected = await adapter.deleteMany({
			model: "user",
			where: [{ field: "name", value: "dupe" }],
		});

		expect(affected).toBe(2);
		expect(user.spies.deleteAndCount).toHaveBeenCalled();
		expect(user.spies.delete).not.toHaveBeenCalled();
		// v0.1.0 read the ids back with `.select("id")` first; that round trip
		// is gone.
		expect(user.spies.select).not.toHaveBeenCalled();
		expect(await adapter.count({ model: "user" })).toBe(1);
	});
});
