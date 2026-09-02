import { defineConfig } from "tsdown";

export default defineConfig({
	entry: ["src/index.ts"],
	format: ["esm"],
	platform: "node",
	// Matches `engines.node` in package.json — no reason to emit
	// Node-18-compatible syntax for a package that already refuses to
	// install below Node 22.
	target: "node22",
	outDir: "dist",
	dts: true,
	clean: true,
	sourcemap: true,
	treeshake: true,
	deps: {
		// `@better-auth/core` is a peer dependency and `@internal/sql-orm-client`
		// is supplied by the consuming Prisma Next app (it is only an ambient
		// declaration here) — neither must ever be bundled or resolved at build
		// time. `deps.neverBundle` — the top-level `external` option this
		// replaces is deprecated as of tsdown 0.22.13.
		neverBundle: [/^@better-auth\/core(\/.*)?$/, /^@prisma\/orm-/],
	},
});
