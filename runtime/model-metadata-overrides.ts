import { resolveRuntimeModuleUrl } from "./resolve-module.js";

const mod = (await import(
	resolveRuntimeModuleUrl("model-metadata-overrides.js")
)) as typeof import("../src/model-metadata-overrides.js");

export const applyKnownModelMetadataOverrides = mod.applyKnownModelMetadataOverrides;
