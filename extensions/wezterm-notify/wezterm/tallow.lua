--- tallow WezTerm integration
--- Adds agent turn status indicators to the tab bar.
---
--- Standalone usage (module owns format-tab-title + update-right-status):
---
---   local tallow = require("tallow")
---   tallow.setup()
---
--- If you already have custom handlers, do not call setup().
--- Use helper functions instead:
---
---   local tallow = require("tallow")
---   wezterm.on("update-right-status", function(window, pane)
---     tallow.tick()
---     -- your existing update-right-status logic
---   end)
---
---   wezterm.on("format-tab-title", function(tab)
---     local any_working, any_done_unseen = tallow.get_tab_status(tab)
---     -- your existing format-tab-title logic using these status flags
---   end)

local wezterm = require("wezterm")

local M = {}

local SPINNER_CHARS = { "◰", "◳", "◲", "◱" }

local defaults = {
	spinner_color = "#d8a274",
	done_color = "#61afef",
	active_color = "#ccb266",
	inactive_color = "#737373",
	max_title_length = 24,
}

---Copy a table shallowly.
---@param value table
---@return table
local function copy_table(value)
	local out = {}
	for k, v in pairs(value) do
		out[k] = v
	end
	return out
end

---Merge optional overrides onto defaults.
---@param opts table|nil
---@return table
local function resolve_options(opts)
	local out = copy_table(defaults)
	if not opts then
		return out
	end

	for k, v in pairs(opts) do
		out[k] = v
	end
	return out
end

---Resolve the title text shown in tab rendering.
---@param tab table TabInformation
---@param max_len number
---@return string
local function resolve_title(tab, max_len)
	local title = tostring(tab.tab_index + 1)

	if tab.tab_title and #tab.tab_title > 0 then
		title = tab.tab_title
	end

	if #title > max_len then
		title = title:sub(1, max_len - 2) .. ".."
	end

	return title
end

---Aggregate pi_status across all panes in a tab.
---@param tab table TabInformation from format-tab-title
---@return boolean any_working
---@return boolean any_done_unseen
function M.get_tab_status(tab)
	local any_working = false
	local any_done_unseen = false

	local mux_tab = wezterm.mux.get_tab(tab.tab_id)
	if not mux_tab then
		return false, false
	end

	if not wezterm.GLOBAL.pi_seen then
		wezterm.GLOBAL.pi_seen = {}
	end

	for _, pane in ipairs(mux_tab:panes()) do
		local vars = pane:get_user_vars()
		local status = vars.pi_status or ""
		local pid = tostring(pane:pane_id())

		if status == "working" then
			any_working = true
			wezterm.GLOBAL.pi_seen[pid] = nil
		elseif status == "done" then
			if tab.is_active then
				wezterm.GLOBAL.pi_seen[pid] = true
			elseif not wezterm.GLOBAL.pi_seen[pid] then
				any_done_unseen = true
			end
		else
			wezterm.GLOBAL.pi_seen[pid] = nil
		end
	end

	return any_working, any_done_unseen
end

---Advance the spinner frame by one step.
local function advance_spinner_frame()
	local frame = wezterm.GLOBAL.tallow_spinner_frame or 0
	wezterm.GLOBAL.tallow_spinner_frame = (frame + 1) % #SPINNER_CHARS
end

---Advance at most once for the current redraw generation.
local function advance_spinner_for_redraw()
	local generation = wezterm.GLOBAL.tallow_spinner_generation or 0
	local last_generation = wezterm.GLOBAL.tallow_spinner_last_advanced_generation or -1

	if generation == last_generation then
		return
	end

	advance_spinner_frame()
	wezterm.GLOBAL.tallow_spinner_last_advanced_generation = generation
end

---Mark a redraw generation.
---
---Call this from `update-right-status`; tab rendering consumes the generation
---and advances the spinner deterministically while work is active.
function M.tick()
	local generation = wezterm.GLOBAL.tallow_spinner_generation or 0
	wezterm.GLOBAL.tallow_spinner_generation = generation + 1
end

---Get current spinner glyph for the active frame.
---@return string
function M.spinner_char()
	local frame = wezterm.GLOBAL.tallow_spinner_frame or 0
	return SPINNER_CHARS[(frame % #SPINNER_CHARS) + 1]
end

---Render default tab title elements with tallow status indicators.
---@param tab table TabInformation from format-tab-title
---@param opts table|nil Optional style overrides
---@return table
function M.render_tab_title(tab, opts)
	local resolved = resolve_options(opts)
	local any_working, any_done_unseen = M.get_tab_status(tab)
	local title = resolve_title(tab, resolved.max_title_length)
	local elements = {}

	if any_working then
		advance_spinner_for_redraw()
		table.insert(elements, { Foreground = { Color = resolved.spinner_color } })
		table.insert(elements, { Text = " " .. M.spinner_char() .. " " })
	else
		table.insert(elements, { Text = "   " })
	end

	local fg = tab.is_active and resolved.active_color or resolved.inactive_color
	if any_done_unseen then
		fg = resolved.done_color
	end

	table.insert(elements, { Foreground = { Color = fg } })
	table.insert(elements, { Text = title .. "  " })
	return elements
end

---Register default event handlers for tallow tab indicators.
---
---This owns both `update-right-status` and `format-tab-title`.
---If your config already defines either handler, use helper methods
---(`tick`, `get_tab_status`, `spinner_char`, `render_tab_title`) and
---compose manually in your own handlers instead.
---
---@param opts table|nil Optional style overrides
function M.setup(opts)
	local resolved = resolve_options(opts)

	if wezterm.GLOBAL.tallow_handlers_registered then
		wezterm.GLOBAL.tallow_handler_options = resolved
		return
	end

	wezterm.GLOBAL.tallow_handlers_registered = true
	wezterm.GLOBAL.tallow_handler_options = resolved

	wezterm.on("update-right-status", function()
		M.tick()
	end)

	wezterm.on("format-tab-title", function(tab)
		return M.render_tab_title(tab, wezterm.GLOBAL.tallow_handler_options)
	end)
end

return M
