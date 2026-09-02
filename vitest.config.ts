import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		environment: "node",
		// Bounds any single test (including the live-Postgres suite) so a
		// hung connection fails fast instead of blocking the run.
		testTimeout: 20_000,
		hookTimeout: 20_000,
		coverage: {
			provider: "v8",
			reporter: ["text", "html", "lcov"],
			reportsDirectory: "coverage",
			include: ["src/**"],
			exclude: ["src/**/*.test.ts", "src/**/*.d.ts"],
			// Reporting only — no thresholds, so coverage never fails the build.
		},
	},
});
