import type { Api, Model } from "@mariozechner/pi-ai";
import { resolveRuntimeModuleUrl } from "./resolve-module.js";

interface ModelRegistryLike {
	getAll(): Model<Api>[];
}

interface ModelMetadataOverridesModule {
	applyKnownModelMetadataOverrides(modelRegistry: ModelRegistryLike): number;
}

const mod = (await import(
	resolveRuntimeModuleUrl("model-metadata-overrides.js")
)) as ModelMetadataOverridesModule;

export const applyKnownModelMetadataOverrides = mod.applyKnownModelMetadataOverrides;
