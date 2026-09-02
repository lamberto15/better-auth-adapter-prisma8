import { defineConfig } from "tsdown";

export default defineConfig({
	entry: ["src/index.ts"],
	format: ["esm"],
	platform: "node",
	target: "node18",
	outDir: "dist",
	dts: true,
	clean: true,
	sourcemap: true,
	treeshake: true,
	// `@better-auth/core` is a peer dependency and `@internal/sql-orm-client`
	// is supplied by the consuming Prisma Next app (it is only an ambient
	// declaration here) — neither must ever be bundled or resolved at build
	// time.
	external: [/^@better-auth\/core(\/.*)?$/, /^@prisma\/orm-/],
});
