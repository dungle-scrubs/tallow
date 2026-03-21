import { resolveRuntimeModuleUrl } from "./resolve-module.js";

const pidSchemaModule = (await import(
	resolveRuntimeModuleUrl("pid-schema.js")
)) as typeof import("../src/pid-schema.js");

export type PidEntry = import("../src/pid-schema.js").PidEntry;
export type SessionOwner = import("../src/pid-schema.js").SessionOwner;
export type SessionPidFile = import("../src/pid-schema.js").SessionPidFile;

export const isPidEntry = pidSchemaModule.isPidEntry;
export const isSessionOwner = pidSchemaModule.isSessionOwner;
export const toOwnerKey = pidSchemaModule.toOwnerKey;
