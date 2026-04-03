import { resolveRuntimeModuleUrl } from "./resolve-module.js";

export interface PidEntry {
	command: string;
	ownerPid?: number;
	ownerStartedAt?: string;
	pid: number;
	processStartedAt?: string;
	startedAt: number;
}

export interface SessionOwner {
	pid: number;
	startedAt?: string;
}

export interface SessionPidFile {
	entries: PidEntry[];
	owner: SessionOwner;
	version: 2;
}

interface PidSchemaModule {
	isPidEntry(value: unknown): value is PidEntry;
	isSessionOwner(value: unknown): value is SessionOwner;
	toOwnerKey(owner: SessionOwner): string;
}

const pidSchemaModule = (await import(resolveRuntimeModuleUrl("pid-schema.js"))) as PidSchemaModule;

export const isPidEntry = pidSchemaModule.isPidEntry;
export const isSessionOwner = pidSchemaModule.isSessionOwner;
export const toOwnerKey = pidSchemaModule.toOwnerKey;
