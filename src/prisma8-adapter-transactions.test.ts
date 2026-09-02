import type { BetterAuthOptions } from "@better-auth/core";
import { describe, expect, it, vi } from "vitest";
vi.mock("@prisma/orm-postgres/orm-client", () => ({
	and: (...conditions: unknown[]) => conditions.every(Boolean),
	or: (...conditions: unknown[]) => conditions.some(Boolean),
	not: (condition: unknown) => !condition,
}));
import { prisma8Adapter } from "./prisma8-adapter";
import type { PrismaNextDb, PrismaNextOrmCollection } from "./prisma8-adapter";

/**
 * `prisma8-adapter.test.ts`'s fake shares one `rows` array between the
 * "outside" client and any transaction context, which proves transaction
 * *composition* but not real isolation. These tests add a snapshot/restore
 * so a thrown error genuinely undoes every write made inside the
 * transaction, proving rollback actually happens.
 */
function makeFieldProxy(row: Record<string, unknown>) {
	return new Proxy(
		{},
		{
			get(_target, field: string) {
				const value = row[field] as never;
				return {
					eq: (v: unknown) => value === v,
					neq: (v: unknown) => value !== v,
					isNull: () => value == null,
					isNotNull: () => value != null,
				};
			},
		},
	);
}

function makeSession(id: string, token: string): Record<string, unknown> {
	return { id, token, expiresAt: new Date(0), userId: "u1" };
}

/** A trivial collection: enough for create/update/delete, no sorting/paging. */
function makeSimpleCollection(rows: Record<string, unknown>[]): PrismaNextOrmCollection {
	const build = (predicate: ((row: Record<string, unknown>) => boolean) | null): PrismaNextOrmCollection => {
		const matching = () => rows.filter((r) => !predicate || predicate(r));
		return {
			where: (predicateOrObject) => {
				const next =
					typeof predicateOrObject === "function"
						? (row: Record<string, unknown>) =>
								Boolean(predicateOrObject(makeFieldProxy(row) as never))
						: (row: Record<string, unknown>) =>
								Object.entries(predicateOrObject).every(([k, v]) => row[k] === v);
				return build(predicate ? (row) => predicate(row) && next(row) : next);
			},
			select: () => build(predicate),
			orderBy: () => build(predicate),
			limit: () => build(predicate),
			offset: () => build(predicate),
			take: () => build(predicate),
			skip: () => build(predicate),
			all: async () => matching().map((r) => ({ ...r })),
			first: async () => {
				const [row] = matching();
				return row ? { ...row } : null;
			},
			create: async (data) => {
				const row = { ...data };
				rows.push(row);
				return { ...row };
			},
			update: async (data) => {
				const [row] = matching();
				if (!row) return null;
				Object.assign(row, data);
				return { ...row };
			},
			updateAll: async (data) => {
				const affected = matching();
				for (const row of affected) Object.assign(row, data);
				return affected.map((r) => ({ ...r }));
			},
			updateAndCount: async (data) => {
				const affected = matching();
				for (const row of affected) Object.assign(row, data);
				return affected.length;
			},
			delete: async () => {
				const [row] = matching();
				if (!row) return null;
				rows.splice(rows.indexOf(row), 1);
				return row;
			},
			deleteAll: async () => {
				const affected = matching();
				const deleted = affected.map((r) => ({ ...r }));
				for (const row of affected) rows.splice(rows.indexOf(row), 1);
				return deleted;
			},
			deleteAndCount: async () => {
				const affected = matching();
				for (const row of affected) rows.splice(rows.indexOf(row), 1);
				return affected.length;
			},
			aggregate: async (project) => project({ count: () => matching().length }),
		};
	};
	return build(null);
}

/**
 * A fake client whose `transaction(...)` has *real* rollback semantics: it
 * deep-snapshots every collection's rows before running the callback, and —
 * if the callback throws — restores every collection to that snapshot before
 * re-throwing. A successful callback's writes are left in place (committed).
 */
function makeSnapshottingDb(
	rowsByModel: Record<string, Record<string, unknown>[]>,
): PrismaNextDb & {
	transaction: <T>(callback: (tx: { orm: unknown }) => Promise<T>) => Promise<T>;
} {
	const orm = {
		public: Object.fromEntries(
			Object.entries(rowsByModel).map(([name, rows]) => [
				name,
				makeSimpleCollection(rows),
			]),
		),
	};
	return {
		orm,
		async transaction(callback) {
			const snapshot = Object.fromEntries(
				Object.entries(rowsByModel).map(([name, rows]) => [name, rows.map((r) => ({ ...r }))]),
			);
			try {
				return await callback({ orm });
			} catch (error) {
				for (const [name, rows] of Object.entries(rowsByModel)) {
					rows.length = 0;
					rows.push(...(snapshot[name] ?? []));
				}
				throw error;
			}
		},
	};
}

const options: BetterAuthOptions = {};
/** Registers a numeric field on the built-in `user` model — Better Auth's
 * factory validates model *names* against its own schema before an adapter
 * call ever reaches this adapter, so `incrementOne` needs a real, registered
 * model with a real numeric field, the same way the existing suite's
 * `createCounterAdapter` does for `verification`. */
const withLoginCount: BetterAuthOptions = {
	user: { additionalFields: { loginCount: { type: "number" } } },
};

describe("adapter.transaction(cb) — real rollback semantics", () => {
	it("transaction: true — a mid-callback throw rolls back every write made inside it", async () => {
		const session = [makeSession("s1", "tok1")];
		const account = [{ id: "a1", issuer: "x", accountId: "1", providerId: "p", userId: "u1" }];
		const db = makeSnapshottingDb({ Session: session, Account: account });
		const adapter = prisma8Adapter(db, { provider: "postgresql", transaction: true })(
			options,
		);

		await expect(
			adapter.transaction(async (tx) => {
				await tx.create({ model: "session", data: { token: "tok2", expiresAt: new Date(0), userId: "u1" } });
				await tx.update({
					model: "account",
					where: [{ field: "id", value: "a1", operator: "eq", connector: "AND" }],
					update: { providerId: "changed" },
				});
				throw new Error("simulated mid-transaction failure");
			}),
		).rejects.toThrow("simulated mid-transaction failure");

		// Both writes — the create AND the update — are gone, proving the
		// adapter's error propagation actually reaches the real rollback
		// path rather than the create silently surviving a later failure.
		expect(session).toEqual([makeSession("s1", "tok1")]);
		expect(account).toEqual([{ id: "a1", issuer: "x", accountId: "1", providerId: "p", userId: "u1" }]);
	});

	it("transaction: true — a successful callback commits every write", async () => {
		const session = [makeSession("s1", "tok1")];
		const db = makeSnapshottingDb({ Session: session });
		const adapter = prisma8Adapter(db, { provider: "postgresql", transaction: true })(
			options,
		);

		await adapter.transaction(async (tx) => {
			await tx.create({ model: "session", data: { token: "tok2", expiresAt: new Date(0), userId: "u1" } });
			await tx.update({
				model: "session",
				where: [{ field: "id", value: "s1", operator: "eq", connector: "AND" }],
				update: { token: "rotated" },
			});
		});

		expect(session).toHaveLength(2);
		expect(session.map((r) => r["token"]).sort()).toEqual(["rotated", "tok2"]);
	});

	it("transaction: false (the default) does NOT roll back — a mid-callback throw leaves earlier writes committed", async () => {
		// This is Better Auth's own factory behaviour, not something this
		// adapter can override: with `config.transaction` unset, the factory's
		// `adapter.transaction(cb)` just calls `cb(adapter)` directly —
		// no wrapping, no rollback. Guards against a regression toward
		// "false silently becomes safe".
		const session = [makeSession("s1", "tok1")];
		const db = makeSnapshottingDb({ Session: session });
		const adapter = prisma8Adapter(db, { provider: "postgresql" })(options); // transaction: false (default)

		await expect(
			adapter.transaction(async (tx) => {
				await tx.create({ model: "session", data: { token: "tok2", expiresAt: new Date(0), userId: "u1" } });
				throw new Error("simulated mid-transaction failure");
			}),
		).rejects.toThrow("simulated mid-transaction failure");

		// The create from before the throw is still there — genuinely
		// non-atomic. Same shape of risk as calling the adapter's methods
		// directly with no transaction at all.
		expect(session).toHaveLength(2);
		expect(session.map((r) => r["token"]).sort()).toEqual(["tok1", "tok2"]);
	});

	it("incrementOne called from inside an open transaction reuses it, and rolls back with everything else", async () => {
		// `tx` handed to the callback is Better Auth's own
		// `DBTransactionAdapter` — `Omit<DBAdapter, "transaction">` — so a
		// plugin cannot call `tx.transaction(...)` again through the typed
		// surface. What it can do (e.g. a rate-limiting flow) is call the
		// guarded single-row helpers (`incrementOne`/`consumeOne`) from
		// inside an already-open transaction; this proves those reuse the
		// open one instead of starting a second.
		const user = [{ id: "u1", loginCount: 10 }];
		const session = [makeSession("s1", "tok1")];
		const db = makeSnapshottingDb({ User: user, Session: session });
		const transactionSpy = vi.spyOn(db, "transaction");
		const adapter = prisma8Adapter(db, { provider: "postgresql", transaction: true })(
			withLoginCount,
		);

		await expect(
			adapter.transaction(async (tx) => {
				await tx.create({ model: "session", data: { token: "tok2", expiresAt: new Date(0), userId: "u1" } });
				await tx.incrementOne({
					model: "user",
					where: [{ field: "id", value: "u1", operator: "eq", connector: "AND" }],
					increment: { loginCount: 1 },
				});
				throw new Error("simulated failure after the increment");
			}),
		).rejects.toThrow("simulated failure after the increment");

		// Exactly one real `db.transaction(...)` — `incrementOne` reused the
		// open one rather than starting its own nested one.
		expect(transactionSpy).toHaveBeenCalledTimes(1);
		// And both the create and the increment were rolled back together.
		expect(session).toEqual([makeSession("s1", "tok1")]);
		expect(user).toEqual([{ id: "u1", loginCount: 10 }]);
	});
});
