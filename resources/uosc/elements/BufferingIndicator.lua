local Element = require('elements/Element')

---@class BufferingIndicator : Element
local BufferingIndicator = class(Element)

function BufferingIndicator:new() return Class.new(self) --[[@as BufferingIndicator]] end
function BufferingIndicator:init()
	Element.init(self, 'buffering_indicator', {ignores_curtain = true, render_order = 100})
	self.enabled = false
	self.is_loading = false
	self.paused_for_cache = false
	self.cache_buffering = 100

	-- High-frequency refresh timer (40ms = 25fps) while buffering/loading
	-- Animates the rotating spinner and updates real-time download speed
	self._timer = mp.add_periodic_timer(0.04, function()
		if self.enabled then
			request_render()
		else
			self._timer:stop()
		end
	end)
	self._timer:stop()

	-- 1. File loading events
	mp.register_event('start-file', function()
		self.is_loading = true
		self:decide_enabled()
	end)

	mp.register_event('playback-restart', function()
		-- When first frame starts rendering and playback is active, clear initial loading
		local idle = mp.get_property_bool('core-idle', false)
		local time_pos = mp.get_property_number('time-pos')
		if not idle and time_pos ~= nil then
			self.is_loading = false
		end
		self:decide_enabled()
	end)

	mp.register_event('end-file', function()
		self.is_loading = false
		self:decide_enabled()
	end)

	-- 2. Buffer/Cache property observers
	mp.observe_property('paused-for-cache', 'bool', function(_, val)
		self.paused_for_cache = val or false
		self:decide_enabled()
	end)

	mp.observe_property('cache-buffering-state', 'number', function(_, val)
		self.cache_buffering = val or 100
		self:decide_enabled()
	end)

	mp.observe_property('core-idle', 'bool', function(_, val)
		if val == false and mp.get_property_number('time-pos') ~= nil then
			self.is_loading = false
		end
		self:decide_enabled()
	end)

	mp.observe_property('seeking', 'bool', function()
		self:decide_enabled()
	end)

	mp.observe_property('time-pos', 'number', function(_, val)
		if val ~= nil and self.is_loading then
			local idle = mp.get_property_bool('core-idle', false)
			if not idle then
				self.is_loading = false
				self:decide_enabled()
			end
		end
	end)

	self:decide_enabled()
end

function BufferingIndicator:decide_enabled()
	local was_enabled = self.enabled

	local is_stalled = self.paused_for_cache or (self.cache_buffering < 100)
	local is_seeking = mp.get_property_bool('seeking', false)
	local is_idle = mp.get_property_bool('core-idle', false)
	local is_paused = mp.get_property_bool('pause', false)
	local eof = mp.get_property_bool('eof-reached', false)

	local should_enable = false
	if not eof then
		if self.is_loading then
			should_enable = true
		elseif is_stalled then
			should_enable = true
		elseif (is_seeking or is_idle) and not is_paused then
			should_enable = true
		end
	end

	self.enabled = should_enable

	if self.enabled then
		if not self._timer:is_enabled() then
			self._timer:resume()
		end
	else
		if self._timer:is_enabled() then
			self._timer:stop()
		end
	end

	if was_enabled ~= self.enabled then
		request_render()
	end
end

function BufferingIndicator:destroy()
	if self._timer then
		self._timer:kill()
	end
	Element.destroy(self)
end

function BufferingIndicator:render()
	local ass = assdraw.ass_new()
	local bg_opacity = (config.opacity and config.opacity.buffering_indicator) or 0.4
	ass:rect(0, 0, display.width, display.height, {color = bg, opacity = bg_opacity})

	local size = round(32 + math.min(display.width, display.height) / 12)
	local opacity = (Elements.menu and Elements.menu:is_alive()) and 0.3 or 0.85
	local cx = display.width / 2
	local cy = display.height / 2 - 10

	-- Rotating spinner
	ass:spinner(cx, cy, size, {color = fg, opacity = opacity})

	-- Speed and buffer calculation
	local speed_bytes = mp.get_property_number('cache-speed', 0) or 0
	if speed_bytes == 0 then
		local dcs = mp.get_property_native('demuxer-cache-state')
		if type(dcs) == 'table' and dcs['raw-input-rate'] then
			speed_bytes = tonumber(dcs['raw-input-rate']) or 0
		end
	end

	local speed_str = ''
	if speed_bytes > 0 then
		if speed_bytes < 1024 * 1024 then
			speed_str = string.format('%.0f KB/s', speed_bytes / 1024)
		else
			speed_str = string.format('%.1f MB/s', speed_bytes / (1024 * 1024))
		end
	end

	local cache_dur = mp.get_property_number('demuxer-cache-duration', 0) or 0
	local text = ''
	if speed_str ~= '' then
		text = speed_str
		if cache_dur > 0 then
			text = text .. string.format(' · 已缓冲 %.1fs', cache_dur)
		end
	elseif cache_dur > 0 then
		text = string.format('已缓冲 %.1fs', cache_dur)
	else
		text = self.is_loading and '正在加载...' or '正在缓冲...'
	end

	ass:txt(cx, cy + size / 2 + 20, 5, text, {
		size = round(math.max(14, size / 3.2)),
		color = fg,
		opacity = opacity,
		bold = true,
	})
	return ass
end

return BufferingIndicator
