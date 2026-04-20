const SETTINGS_LIST_PATCH_FLAG = "__tallow_pi_tui_settings_list_patch_applied__";

type SettingsListPatchedLike = {
	__tallow_lastRenderLineCount?: number;
	__tallow_layoutTransitionCallback?: () => void;
	__tallow_nextMinLineCount?: number;
};

type SettingsListPrototypeLike = {
	activateItem?: () => void;
	closeSubmenu?: () => void;
	[SETTINGS_LIST_PATCH_FLAG]?: boolean;
	render?: (width: number) => string[];
	setLayoutTransitionCallback?: (callback?: () => void) => void;
};

export function patchSettingsListPrototype(prototype: SettingsListPrototypeLike): void {
	if (prototype[SETTINGS_LIST_PATCH_FLAG]) return;
	prototype[SETTINGS_LIST_PATCH_FLAG] = true;

	prototype.setLayoutTransitionCallback = function (
		this: SettingsListPatchedLike,
		callback?: () => void
	): void {
		this.__tallow_layoutTransitionCallback = callback;
	};

	const originalRender = prototype.render;
	if (typeof originalRender === "function") {
		prototype.render = function (this: SettingsListPatchedLike, width: number): string[] {
			const lines = originalRender.call(this, width);
			const minLineCount = this.__tallow_nextMinLineCount ?? 0;
			const paddedLines =
				minLineCount > lines.length
					? [...lines, ...Array.from({ length: minLineCount - lines.length }, () => "")]
					: lines;
			this.__tallow_nextMinLineCount = 0;
			this.__tallow_lastRenderLineCount = paddedLines.length;
			return paddedLines;
		};
	}

	const originalActivateItem = prototype.activateItem;
	if (typeof originalActivateItem === "function") {
		prototype.activateItem = function (this: SettingsListPatchedLike): void {
			this.__tallow_layoutTransitionCallback?.();
			originalActivateItem.call(this);
		};
	}

	const originalCloseSubmenu = prototype.closeSubmenu;
	if (typeof originalCloseSubmenu === "function") {
		prototype.closeSubmenu = function (this: SettingsListPatchedLike): void {
			this.__tallow_layoutTransitionCallback?.();
			this.__tallow_nextMinLineCount = this.__tallow_lastRenderLineCount ?? 0;
			originalCloseSubmenu.call(this);
		};
	}
}
