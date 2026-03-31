import { resolveRuntimeModuleUrl } from "./resolve-module.js";

const mod = (await import(
	resolveRuntimeModuleUrl("config.js")
)) as typeof import("../src/config.js");

export const TALLOW_VERSION = mod.TALLOW_VERSION;
