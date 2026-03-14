import { resolveRuntimeModuleUrl } from "./resolve-module.js";

const atomicWriteModule = (await import(
	resolveRuntimeModuleUrl("atomic-write.js")
)) as typeof import("../src/atomic-write.js");

export const atomicWriteFileSync = atomicWriteModule.atomicWriteFileSync;
export const restoreFromBackup = atomicWriteModule.restoreFromBackup;
