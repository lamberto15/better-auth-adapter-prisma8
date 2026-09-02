/**
 * Ambient declaration for the standalone predicate combinators.
 *
 * Prisma's ORM client reference documents `and` / `or` / `not` as importable
 * from `@prisma/orm-postgres/orm-client`. That package is supplied by the
 * consuming Prisma 8 app, not by this adapter — declaring it here lets the
 * adapter typecheck and build standalone without vendoring a dependency it
 * does not own. In a real app the app's own installed types take precedence.
 */
declare module "@prisma/orm-postgres/orm-client" {
	export function and(...conditions: unknown[]): unknown;
	export function or(...conditions: unknown[]): unknown;
	export function not(condition: unknown): unknown;
}
