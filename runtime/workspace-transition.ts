import { resolveRuntimeModuleUrl } from "./resolve-module.js";

const workspaceTransitionModule = (await import(
	resolveRuntimeModuleUrl("workspace-transition.js")
)) as typeof import("../src/workspace-transition.js");

export type WorkspaceTransitionCancelledResult =
	import("../src/workspace-transition.js").WorkspaceTransitionCancelledResult;
export type WorkspaceTransitionCompletedResult =
	import("../src/workspace-transition.js").WorkspaceTransitionCompletedResult;
export type WorkspaceTransitionHost =
	import("../src/workspace-transition.js").WorkspaceTransitionHost;
export type WorkspaceTransitionInitiator =
	import("../src/workspace-transition.js").WorkspaceTransitionInitiator;
export type WorkspaceTransitionRequest =
	import("../src/workspace-transition.js").WorkspaceTransitionRequest;
export type WorkspaceTransitionResult =
	import("../src/workspace-transition.js").WorkspaceTransitionResult;
export type WorkspaceTransitionSessionSeed =
	import("../src/workspace-transition.js").WorkspaceTransitionSessionSeed;
export type WorkspaceTransitionUI = import("../src/workspace-transition.js").WorkspaceTransitionUI;
export type WorkspaceTransitionUnavailableResult =
	import("../src/workspace-transition.js").WorkspaceTransitionUnavailableResult;

export const buildWorkspaceTransitionSummary =
	workspaceTransitionModule.buildWorkspaceTransitionSummary;
export const getWorkspaceTransitionHost = workspaceTransitionModule.getWorkspaceTransitionHost;
export const registerWorkspaceTransitionHost =
	workspaceTransitionModule.registerWorkspaceTransitionHost;
