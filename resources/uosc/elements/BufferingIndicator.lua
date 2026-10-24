local Element = require('elements/Element')

---@class BufferingIndicator : Element
local BufferingIndicator = class(Element)

function BufferingIndicator:new() return Class.new(self) --[[@as BufferingIndicator]] end
function BufferingIndicator:init()
	Element.init(self, 'buffering_indicator', {ignores_curtain = true, render_order = 2})
	self.enabled = false
	self.paused_for_cache = false
	self.is_loading = false

	mp.register_event('start-file', function()
		self.is_loading = true
		self:decide_enabled()
	end)
	mp.register_event('file-loaded', function()
		self.is_loading = false
		self:decide_enabled()
	end)
	mp.register_event('playback-restart', function()
		self.is_loading = false
		self:decide_enabled()
	end)
	mp.register_event('end-file', function()
		self.is_loading = false
		self:decide_enabled()
	end)

	mp.observe_property('paused-for-cache', 'bool', function(_, val)
		self.paused_for_cache = val or false
		self:decide_enabled()
	end)
	self:decide_enabled()
end

function BufferingIndicator:decide_enabled()
	local cache = self.paused_for_cache or state.cache_underrun or (state.cache_buffering and state.cache_buffering < 100)
	local player = state.core_idle and not state.eof_reached
	if self.enabled then
		if not self.is_loading and (not player or (state.pause and not cache)) then
			self.enabled = false
		end
	elseif self.is_loading or (player and cache) or self.paused_for_cache then
		self.enabled = true
	end
end

function BufferingIndicator:on_prop_pause() self:decide_enabled() end
function BufferingIndicator:on_prop_core_idle() self:decide_enabled() end
function BufferingIndicator:on_prop_eof_reached() self:decide_enabled() end
function BufferingIndicator:on_prop_uncached_ranges() self:decide_enabled() end
function BufferingIndicator:on_prop_cache_buffering() self:decide_enabled() end
function BufferingIndicator:on_prop_cache_underrun() self:decide_enabled() end

function BufferingIndicator:render()
	local ass = assdraw.ass_new()
	ass:rect(0, 0, display.width, display.height, {color = bg, opacity = config.opacity.buffering_indicator})
	local size = round(30 + math.min(display.width, display.height) / 10)
	local opacity = (Elements.menu and Elements.menu:is_alive()) and 0.3 or 0.8
	local cx = display.width / 2
	local cy = display.height / 2
	ass:spinner(cx, cy, size, {color = fg, opacity = opacity})

	local speed_bytes = mp.get_property_number('cache-speed', 0)
	local speed_str = ''
	if speed_bytes and speed_bytes > 0 then
		if speed_bytes < 1024 * 1024 then
			speed_str = string.format('%.0f KB/s', speed_bytes / 1024)
		else
			speed_str = string.format('%.1f MB/s', speed_bytes / (1024 * 1024))
		end
	end
	local cache_dur = mp.get_property_number('demuxer-cache-duration', 0)
	local text = ''
	if speed_str ~= '' then
		text = speed_str
		if cache_dur and cache_dur > 0 then
			text = text .. string.format(' · 已缓冲 %.1fs', cache_dur)
		end
	elseif cache_dur and cache_dur > 0 then
		text = string.format('已缓冲 %.1fs', cache_dur)
	else
		text = self.is_loading and '正在加载...' or '正在缓冲...'
	end

	ass:txt(cx, cy + size / 2 + 18, 5, text, {
		size = round(math.max(14, size / 3.5)),
		color = fg,
		opacity = opacity,
		bold = true,
	})
	return ass
end

return BufferingIndicator
