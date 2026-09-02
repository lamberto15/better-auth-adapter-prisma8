export { prisma8Adapter } from "./prisma8-adapter";
export type {
	Prisma8AdapterConfig,
	PrismaNextDb,
	PrismaNextTransactionContext,
	PrismaNextOrmCollection,
	PrismaNextOrmNamespace,
	PrismaNextFieldProxy,
	PrismaNextFieldProxyEntry,
	PrismaNextPredicate,
	PrismaNextAggregateApi,
} from "./prisma8-adapter";

export {
	generateContractPrisma,
	createPrisma8Schema,
	DEFAULT_CONTRACT_PATH,
} from "./schema-generator";
export type { GenerateContractOptions } from "./schema-generator";

export {
	generateContractTypeScript,
	DEFAULT_TS_CONTRACT_PATH,
} from "./typescript-contract-generator";

export { mergeTypeScriptContract } from "./typescript-contract-merge";
export type { TypeScriptMergeAttempt } from "./typescript-contract-merge";

export { discoverContract, modeFromExtension } from "./contract-discovery";
export type {
	ContractAuthoringMode,
	DiscoveredContract,
} from "./contract-discovery";
