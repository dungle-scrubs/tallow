import { resolveRuntimeModuleUrl } from "./resolve-module.js";

const workspaceTransitionRelayModule = (await import(
	resolveRuntimeModuleUrl("workspace-transition-relay.js")
)) as typeof import("../src/workspace-transition-relay.js");

export type TransitionRelayServer =
	import("../src/workspace-transition-relay.js").TransitionRelayServer;

export const buildTransitionRelaySocketPath =
	workspaceTransitionRelayModule.buildTransitionRelaySocketPath;
export const createTransitionRelayServer =
	workspaceTransitionRelayModule.createTransitionRelayServer;
export const getRelaySocketPath = workspaceTransitionRelayModule.getRelaySocketPath;
export const isFilesystemRelaySocketPath =
	workspaceTransitionRelayModule.isFilesystemRelaySocketPath;
export const requestTransitionViaRelay = workspaceTransitionRelayModule.requestTransitionViaRelay;
export const TRANSITION_RELAY_SOCKET_ENV =
	workspaceTransitionRelayModule.TRANSITION_RELAY_SOCKET_ENV;
export const tryCreateTransitionRelayServer =
	workspaceTransitionRelayModule.tryCreateTransitionRelayServer;
