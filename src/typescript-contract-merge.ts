import type { GenerateContractOptions } from "./schema-generator";
import {
	type EmittedRelation,
	type ResolvedModel,
	renderMapEntry,
	renderModelDeclaration,
	renderRelationProperty,
	resolveModels,
} from "./typescript-contract-generator";

/*
 * Structural merging into an existing Prisma 8 TypeScript contract.
 *
 * This module is a pure string-in, string-or-reason-out function: it never
 * touches the filesystem, and it never produces a "best effort" partial
 * result. Every code path either returns the complete, updated file, or a
 * specific reason it declined — the caller (`schema-generator.ts`) falls back
 * to its existing throw-with-manual-instructions behavior in the latter case.
 *
 * A wrong splice that corrupts a user's real contract is exactly the bug this
 * package shipped once already (silently replacing a user's `contract.ts`
 * with only the newly-added models). So every step below is a *recognizer*,
 * not a best-effort transform: the moment the file's shape stops matching
 * something this merger can reason about with certainty, it bails out with a
 * specific `unsupportedReason` rather than guessing.
 *
 * `typescript` is imported dynamically (only inside `mergeTypeScriptContract`)
 * so a PSL-only consumer never needs it resolvable — see `package.json`'s
 * `peerDependenciesMeta.typescript.optional`. Type-only references below use
 * inline `import("typescript").X` so the emitted `.d.ts` never gains a static
 * dependency on the `typescript` package either.
 */

export interface TypeScriptMergeAttempt {
	/** Set when the merge succeeded: the complete, updated file to write. */
	code?: string;
	/**
	 * Set when the file's structure doesn't match what this merger can safely
	 * handle. The caller falls back to its existing throw-with-manual-
	 * instructions behavior using this as the reason.
	 */
	unsupportedReason?: string;
}

type TS = typeof import("typescript");
type Node = import("typescript").Node;
type SourceFile = import("typescript").SourceFile;
type Block = import("typescript").Block;
type CallExpression = import("typescript").CallExpression;
type ObjectLiteralExpression = import("typescript").ObjectLiteralExpression;
type ObjectLiteralElementLike = import("typescript").ObjectLiteralElementLike;
type VariableStatement = import("typescript").VariableStatement;

interface ModelMapEntry {
	/** The full property node (`Name,` / `Name: Name,` / `Name: Name.relations({...})`). */
	property: ObjectLiteralElementLike;
	kind: "bare" | "relations" | "opaque";
	relationsLiteral?: ObjectLiteralExpression | undefined;
}

/** A pure text splice: either an insertion (start === end) or a replacement. */
interface Edit {
	start: number;
	end: number;
	text: string;
}

function fail(reason: string): TypeScriptMergeAttempt {
	return { unsupportedReason: reason };
}

/** Leading whitespace of the line containing `pos`. */
function detectIndent(sourceText: string, pos: number): string {
	const lineStart = sourceText.lastIndexOf("\n", pos - 1) + 1;
	const line = sourceText.slice(lineStart, pos);
	const match = /^[ \t]*/.exec(line);
	return match ? match[0]! : "";
}

/** Prepends `prefix` to every non-empty line of `block`. */
function withPrefix(block: string, prefix: string): string {
	return block
		.split("\n")
		.map((line) => (line.length === 0 ? line : prefix + line))
		.join("\n");
}

/**
 * Plans the edits to append one or more new properties to the end of an
 * object literal, matching its existing entries' indentation and trailing-
 * comma style (detected from the last existing property, or from the
 * literal's own indentation plus one level when it's currently empty).
 *
 * `newProps` are rendered property text *without* a leading indent and
 * *without* a trailing comma — this function adds both.
 */
function planObjectLiteralAppend(
	sourceText: string,
	literal: ObjectLiteralExpression,
	newProps: string[],
): Edit[] {
	const edits: Edit[] = [];
	const closeBracePos = literal.getEnd() - 1;
	const props = literal.properties;

	if (props.length > 0) {
		const last = props[props.length - 1]!;
		const gap = sourceText.slice(last.getEnd(), closeBracePos);
		if (!/^\s*,/.test(gap)) {
			// Existing last entry has no trailing comma — add one so the new
			// entries splice in as valid syntax rather than a missing separator.
			edits.push({ start: last.getEnd(), end: last.getEnd(), text: "," });
		}
	}

	// Whether the object literal's own braces sit on one source line (e.g. a
	// hand-written `{ Manufacturer }`). `detectIndent`, below, only measures a
	// line's *leading* whitespace — correct for a normal multi-line literal,
	// where each property starts at its line's beginning, but not a usable
	// indent for a property that starts mid-line. New content here is always
	// multi-line (a rendered `.relations({...})` call spans several lines), so
	// gluing it onto a single-line literal with no line break at all would
	// produce syntactically valid but unreadable, effectively-corrupted-looking
	// output — normalize to multi-line instead, the way a human editing this
	// by hand would.
	const literalStartLine = sourceText.lastIndexOf("\n", literal.getStart(undefined, false));
	const closeBraceLine = sourceText.lastIndexOf("\n", closeBracePos - 1);
	const isSingleLine = literalStartLine === closeBraceLine;

	if (isSingleLine) {
		const baseIndent = detectIndent(sourceText, literal.getStart(undefined, false));
		const childPrefix = `${baseIndent}  `;
		const insertText =
			"\n" +
			newProps.map((prop) => `${withPrefix(prop, childPrefix)},\n`).join("") +
			baseIndent;
		edits.push({ start: closeBracePos, end: closeBracePos, text: insertText });
		return edits;
	}

	// Multi-line literal: match the last existing property's own indent, and
	// insert at the start of the closing brace's own line (it sits alone on
	// that line for every shape this generator recognizes) so the brace's
	// pre-existing indentation stays intact after our inserted lines, rather
	// than being swallowed into the first inserted line's prefix.
	const prefix =
		props.length > 0
			? detectIndent(sourceText, props[props.length - 1]!.getStart(undefined, false))
			: `${detectIndent(sourceText, literal.getStart(undefined, false))}  `;
	const lineStart = closeBraceLine + 1;
	const insertText = newProps.map((prop) => `${withPrefix(prop, prefix)},\n`).join("");
	edits.push({ start: lineStart, end: lineStart, text: insertText });
	return edits;
}

/** Applies non-overlapping edits (descending by start) to `sourceText`. */
function applyEdits(sourceText: string, edits: Edit[]): string {
	const sorted = [...edits].sort((a, b) => b.start - a.start);
	let result = sourceText;
	for (const edit of sorted) {
		result = result.slice(0, edit.start) + edit.text + result.slice(edit.end);
	}
	return result;
}

/**
 * Finds `const <name> = model("...", {...})<.sql(...)><.attributes(...)>` at
 * the top level of the factory's block, unwrapping any `.sql(...)` /
 * `.attributes(...)` chain to confirm the declaration bottoms out in a
 * `model(...)` call.
 */
function findModelConst(
	ts: TS,
	block: Block,
	name: string,
): VariableStatement | undefined {
	for (const statement of block.statements) {
		if (!ts.isVariableStatement(statement)) continue;
		if (statement.declarationList.declarations.length !== 1) continue;
		const decl = statement.declarationList.declarations[0]!;
		if (!ts.isIdentifier(decl.name) || decl.name.text !== name) continue;
		if (!decl.initializer) continue;

		let expr: import("typescript").Expression = decl.initializer;
		// Unwrap `.sql(...)` / `.attributes(...)` — the only stages that can
		// chain onto a bare model token in the new single-const shape.
		for (;;) {
			if (!ts.isCallExpression(expr) || !ts.isPropertyAccessExpression(expr.expression)) {
				break;
			}
			const methodName = expr.expression.name.text;
			if (methodName !== "sql" && methodName !== "attributes") break;
			expr = expr.expression.expression;
		}
		if (ts.isCallExpression(expr) && ts.isIdentifier(expr.expression) && expr.expression.text === "model") {
			return statement;
		}
	}
	return undefined;
}

/** Recognizes `Name: Name.relations({...})`, given the property key `name`. */
function matchRelationsCall(
	ts: TS,
	init: import("typescript").Expression,
	name: string,
): ObjectLiteralExpression | undefined {
	if (
		ts.isCallExpression(init) &&
		ts.isPropertyAccessExpression(init.expression) &&
		ts.isIdentifier(init.expression.expression) &&
		init.expression.expression.text === name &&
		init.expression.name.text === "relations" &&
		init.arguments.length === 1 &&
		ts.isObjectLiteralExpression(init.arguments[0]!)
	) {
		return init.arguments[0] as ObjectLiteralExpression;
	}
	return undefined;
}

export async function mergeTypeScriptContract(opts: {
	existingSource: string;
	/** Everything generateContractTypeScript needs to render new models/relations. */
	generatorOptions: GenerateContractOptions;
}): Promise<TypeScriptMergeAttempt> {
	const ts = (await import("typescript")) as unknown as TS;
	const { existingSource, generatorOptions } = opts;

	const sourceFile: SourceFile = ts.createSourceFile(
		generatorOptions.file ?? "contract.ts",
		existingSource,
		ts.ScriptTarget.Latest,
		true,
		ts.ScriptKind.TS,
	);

	// 1. Exactly one `defineContract(...)` call.
	const calls: CallExpression[] = [];
	const visit = (node: Node): void => {
		if (
			ts.isCallExpression(node) &&
			ts.isIdentifier(node.expression) &&
			node.expression.text === "defineContract"
		) {
			calls.push(node);
		}
		ts.forEachChild(node, visit);
	};
	visit(sourceFile);

	if (calls.length === 0) {
		return fail("no defineContract(...) call was found in the existing contract");
	}
	if (calls.length > 1) {
		return fail(
			`found ${calls.length} defineContract(...) calls in the existing contract — expected exactly one`,
		);
	}
	const call = calls[0]!;

	// 2. Second argument is an arrow function with a block body.
	if (call.arguments.length < 2) {
		return fail(
			"defineContract(...)'s second argument (the factory function) is missing",
		);
	}
	const factory = call.arguments[1]!;
	if (!ts.isArrowFunction(factory)) {
		return fail(
			"defineContract(...)'s second argument is not an arrow function",
		);
	}
	if (!ts.isBlock(factory.body)) {
		return fail(
			"defineContract(...)'s factory function does not have a block body ({ ... }) — implicit-return arrow functions are not supported",
		);
	}
	const block = factory.body;

	// 3. Last statement is `return { ..., models: {...} }`.
	const statements = block.statements;
	if (statements.length === 0) {
		return fail("defineContract(...)'s factory function body is empty");
	}
	const lastStatement = statements[statements.length - 1]!;
	if (!ts.isReturnStatement(lastStatement) || !lastStatement.expression) {
		return fail(
			"the last statement in defineContract(...)'s factory is not a `return` of an object literal",
		);
	}
	const returnExpr = lastStatement.expression;
	if (!ts.isObjectLiteralExpression(returnExpr)) {
		return fail("defineContract(...)'s factory does not return an object literal");
	}
	const modelsProp = returnExpr.properties.find(
		(p): p is import("typescript").PropertyAssignment | import("typescript").ShorthandPropertyAssignment =>
			(ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p)) &&
			ts.isIdentifier(p.name) &&
			p.name.text === "models",
	);
	if (!modelsProp) {
		return fail("the returned object literal has no `models` property");
	}
	if (
		ts.isShorthandPropertyAssignment(modelsProp) ||
		!ts.isObjectLiteralExpression(modelsProp.initializer)
	) {
		return fail(
			"the `models` property is not an object literal (a spread, a variable reference and computed keys are not supported)",
		);
	}
	const modelsObject = modelsProp.initializer;

	// 4. Recognize every property in the `models` object literal.
	const entries = new Map<string, ModelMapEntry>();
	for (const prop of modelsObject.properties) {
		if (ts.isShorthandPropertyAssignment(prop)) {
			entries.set(prop.name.text, { property: prop, kind: "bare" });
			continue;
		}
		if (ts.isPropertyAssignment(prop)) {
			if (!ts.isIdentifier(prop.name)) {
				return fail(
					`the "models" map has a property with a non-identifier key (${prop.name.getText(sourceFile)}), which cannot be safely resolved to a model name`,
				);
			}
			const propName = prop.name.text;
			const init = prop.initializer;
			if (ts.isIdentifier(init) && init.text === propName) {
				entries.set(propName, { property: prop, kind: "bare" });
				continue;
			}
			const relationsLiteral = matchRelationsCall(ts, init, propName);
			if (relationsLiteral) {
				entries.set(propName, { property: prop, kind: "relations", relationsLiteral });
				continue;
			}
			// A known name with an unrecognized value shape (a spread, a
			// ternary, a call to something other than `.relations`) — leave it
			// alone; only fatal if the missing work needs to modify it (checked
			// below).
			entries.set(propName, { property: prop, kind: "opaque" });
			continue;
		}
		// A spread or any other element we cannot attribute to one model name —
		// we cannot safely tell which models it might already cover, so the
		// whole merge is unsupported rather than risking a duplicate entry.
		return fail(
			`the "models" map contains an entry this merger cannot statically identify by name (${prop.getText(sourceFile)}), so it cannot safely determine which models already exist`,
		);
	}

	// 5. Every entry must trace back to a real `const <Name> = model(...)`
	// declaration at the top level of the factory body.
	for (const name of entries.keys()) {
		if (!findModelConst(ts, block, name)) {
			return fail(
				`could not find a top-level "const ${name} = model(...)" declaration backing the "${name}" entry in the models map (unusual binding, destructuring, or re-export are not supported)`,
			);
		}
	}

	// Compute what's missing, using the same resolution `generateContractTypeScript`
	// uses for a fresh file.
	const allModels = resolveModels(generatorOptions);
	const presentNames = entries;
	const missingModels = allModels.filter((m) => !presentNames.has(m.contractName));

	// Back-relations that belong on an EXISTING model's entry, because they
	// point at a model we're about to add.
	const newRelationsForPresent = new Map<string, EmittedRelation[]>();
	for (const model of allModels) {
		if (!presentNames.has(model.contractName)) continue;
		for (const relation of model.relations) {
			if (!missingModels.some((m) => m.contractName === relation.target)) continue;
			const list = newRelationsForPresent.get(model.contractName) ?? [];
			list.push(relation);
			newRelationsForPresent.set(model.contractName, list);
		}
	}

	if (missingModels.length === 0 && newRelationsForPresent.size === 0) {
		// Nothing to do — every model Better Auth needs is already present with
		// every relation it needs. Safe idempotent no-op.
		return { code: existingSource };
	}

	// A present entry that needs a new back-relation but isn't a shape we can
	// safely splice into.
	for (const name of newRelationsForPresent.keys()) {
		const entry = entries.get(name)!;
		if (entry.kind === "opaque") {
			return fail(
				`the "${name}" entry in the models map is not a bare reference or a ".relations({...})" call, and a new back-relation needs to be added to it — this merger will not guess how to splice into an unrecognized shape`,
			);
		}
	}

	const edits: Edit[] = [];

	// --- Bring `rel` into scope when a relation is being introduced for the
	// first time (e.g. the file's only model so far had nothing to relate to).
	const introducesRelations =
		missingModels.some((m) => m.relations.length > 0) || newRelationsForPresent.size > 0;
	if (introducesRelations) {
		if (factory.parameters.length !== 1 || !ts.isObjectBindingPattern(factory.parameters[0]!.name)) {
			return fail(
				"defineContract(...)'s factory parameter is not a destructured object pattern ({ field, model, ... }), so this merger cannot safely bring `rel` into scope for the new relation(s)",
			);
		}
		const pattern = factory.parameters[0]!.name as import("typescript").ObjectBindingPattern;
		const hasRel = pattern.elements.some((el) => {
			const boundName = el.propertyName ?? el.name;
			return ts.isIdentifier(boundName) && boundName.text === "rel";
		});
		if (!hasRel) {
			if (pattern.elements.length > 0) {
				const lastElementEnd = pattern.elements[pattern.elements.length - 1]!.getEnd();
				edits.push({ start: lastElementEnd, end: lastElementEnd, text: ", rel" });
			} else {
				const closeBrace = pattern.getEnd() - 1;
				edits.push({ start: closeBrace, end: closeBrace, text: "rel" });
			}
		}
	}

	// --- New model declarations, inserted right before the `return` statement.
	if (missingModels.length > 0) {
		const returnStart = lastStatement.getStart(sourceFile, false);
		const lineStart = existingSource.lastIndexOf("\n", returnStart - 1) + 1;
		const prefix = detectIndent(existingSource, returnStart);
		const declarations = missingModels
			.map((model) => `${withPrefix(renderModelDeclaration(model, 0), prefix)}\n\n`)
			.join("");
		edits.push({ start: lineStart, end: lineStart, text: declarations });
	}

	// --- New back-relations spliced into existing present-model entries.
	for (const [name, relations] of newRelationsForPresent) {
		const entry = entries.get(name)!;
		if (entry.kind === "relations") {
			const newProps = relations.map((r) => renderRelationProperty(r, 0).replace(/,$/, ""));
			edits.push(...planObjectLiteralAppend(existingSource, entry.relationsLiteral!, newProps));
			continue;
		}
		// kind === "bare": rewrite `Name,` / `Name: Name,` in place to
		// `Name: Name.relations({...})` — a small, position-bounded
		// replacement of just this one property.
		const prop = entry.property;
		const propPrefix = detectIndent(existingSource, prop.getStart(sourceFile, false));
		const innerPrefix = `${propPrefix}  `;
		const body = relations.map((r) => withPrefix(renderRelationProperty(r, 0), innerPrefix)).join("\n");
		const replacement = `${name}: ${name}.relations({\n${body}\n${propPrefix}})`;
		edits.push({
			start: prop.getStart(sourceFile, false),
			end: prop.getEnd(),
			text: replacement,
		});
	}

	// --- New entries in the `models` map for the newly added models.
	if (missingModels.length > 0) {
		const newEntries = missingModels.map((model) => renderMapEntry(model, 0).replace(/,$/, ""));
		edits.push(...planObjectLiteralAppend(existingSource, modelsObject, newEntries));
	}

	return { code: applyEdits(existingSource, edits) };
}
