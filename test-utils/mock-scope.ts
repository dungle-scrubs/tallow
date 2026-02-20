import { mock } from "bun:test";
import { fileURLToPath } from "node:url";

interface ModuleMockRegistration {
	readonly factory: () => unknown;
	readonly specifier: string;
}

export interface MockScope {
	/**
	 * Register a module mock factory in this scope.
	 *
	 * @param specifier - Module specifier passed to `mock.module`
	 * @param factory - Mock module factory
	 * @returns Nothing
	 */
	module: (specifier: string, factory: () => unknown) => void;
	/**
	 * Install all registered module mocks.
	 *
	 * @returns Nothing
	 */
	install: () => void;
	/**
	 * Restore Bun mocks and clear all spy state for this scope.
	 *
	 * @returns Nothing
	 */
	teardown: () => void;
}

/**
 * Create a reusable module-mock scope for Bun test suites.
 *
 * The scope centralizes mock registration and teardown so suites can avoid
 * ad-hoc `mock.restore()` calls scattered across files.
 *
 * @param baseUrl - Optional caller `import.meta.url` for resolving relative specifiers
 * @returns Mock scope helper
 */
export function createMockScope(baseUrl?: string): MockScope {
	const registrations: ModuleMockRegistration[] = [];
	let installed = false;

	return {
		module(specifier: string, factory: () => unknown): void {
			const resolvedSpecifier =
				baseUrl && specifier.startsWith(".")
					? fileURLToPath(new URL(specifier, baseUrl))
					: specifier;
			registrations.push({ factory, specifier: resolvedSpecifier });
		},
		install(): void {
			if (installed) {
				return;
			}
			for (const registration of registrations) {
				mock.module(registration.specifier, registration.factory);
			}
			installed = true;
		},
		teardown(): void {
			mock.restore();
			mock.clearAllMocks();
			installed = false;
		},
	};
}
