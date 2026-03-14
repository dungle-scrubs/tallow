import { resolveRuntimeModuleUrl } from "./resolve-module.js";

const runtimeProvenanceModule = (await import(
	resolveRuntimeModuleUrl("runtime-provenance.js")
)) as typeof import("../src/runtime-provenance.js");

export type RuntimeBuildFreshness = import("../src/runtime-provenance.js").RuntimeBuildFreshness;
export type RuntimeInstallMode = import("../src/runtime-provenance.js").RuntimeInstallMode;
export type RuntimeProvenance = import("../src/runtime-provenance.js").RuntimeProvenance;
export type RuntimeProvenanceOptions =
	import("../src/runtime-provenance.js").RuntimeProvenanceOptions;

export const getStaleBuildGroups = runtimeProvenanceModule.getStaleBuildGroups;
export const isPathInside = runtimeProvenanceModule.isPathInside;
export const isSourceCheckout = runtimeProvenanceModule.isSourceCheckout;
export const resolveRuntimeProvenance = runtimeProvenanceModule.resolveRuntimeProvenance;
export const resolveStablePath = runtimeProvenanceModule.resolveStablePath;
