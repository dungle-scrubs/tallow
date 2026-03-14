import { resolveRuntimeModuleUrl } from "./resolve-module.js";

const runtimePathProviderModule = (await import(
	resolveRuntimeModuleUrl("runtime-path-provider.js")
)) as typeof import("../src/runtime-path-provider.js");

export type RuntimeHomeResolver = import("../src/runtime-path-provider.js").RuntimeHomeResolver;
export type RuntimePathProvider = import("../src/runtime-path-provider.js").RuntimePathProvider;

export const createRuntimePathProvider = runtimePathProviderModule.createRuntimePathProvider;
export const createStaticRuntimePathProvider =
	runtimePathProviderModule.createStaticRuntimePathProvider;
