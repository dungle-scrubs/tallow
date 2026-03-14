import { resolveRuntimeModuleUrl } from "./resolve-module.js";

const otelModule = (await import(
	resolveRuntimeModuleUrl("otel.js")
)) as typeof import("../src/otel.js");

export type TelemetryHandle = import("../src/otel.js").TelemetryHandle;
export type TraceContextCarrier = import("../src/otel.js").TraceContextCarrier;

export const extractTraceContextFromEnv = otelModule.extractTraceContextFromEnv;
export const injectTraceContextToEnv = otelModule.injectTraceContextToEnv;
export const TELEMETRY_API_CHANNELS = otelModule.TELEMETRY_API_CHANNELS;
