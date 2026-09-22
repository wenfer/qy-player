import { X } from 'lucide-react';
import {
  EQ_FREQ_MAX,
  EQ_FREQ_MIN,
  EQ_GAIN_LIMIT,
  EQ_Q_MAX,
  EQ_Q_MIN,
  type EqBand,
} from '../../../main/modules/playback-engine/audio-fx';

/**
 * 音效面板的控件（QYP3-068v 复查时从 `index.tsx` 抽出）。
 *
 * 抽出的理由是**重复**：每个滑块都要"拖动中只喂引擎、松手才落盘"那三件套
 * （`onMouseUp` / `onTouchEnd` / `onKeyUp`），8 个滑块抄 8 遍；漏掉 `onTouchEnd`
 * 或 `onKeyUp` 的后果是触摸屏/键盘用户改了参数却永远不落盘——界面看着正常，
 * 重启就丢。收在这里就只有一处可漏。
 */

export const ROW = 'flex items-center gap-1.5';
export const LABEL = 'text-[11px] text-muted-foreground shrink-0';
export const SLIDER = 'accent-primary flex-1 min-w-[80px]';
export const ICON_BTN = 'p-1 rounded text-muted-foreground hover:text-foreground hover:bg-accent focus-ring';

/** 滑块的三件套：鼠标松手、触摸抬手、键盘抬手都要落盘。 */
export function commitHandlers(onCommit: () => void): {
  onMouseUp: () => void;
  onTouchEnd: () => void;
  onKeyUp: () => void;
} {
  return { onMouseUp: onCommit, onTouchEnd: onCommit, onKeyUp: onCommit };
}

function freqLabel(freq: number): string {
  return freq >= 1000 ? `${(freq / 1000).toFixed(freq >= 10000 ? 0 : 1)}k` : `${freq}`;
}

interface FxRangeProps {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  disabled: boolean;
  /** 右端读数（调用方决定格式：dB / 百分比 / 文字）。 */
  display: string;
  ariaLabel: string;
  onChange: (value: number) => void;
  onCommit: () => void;
}

/** 一行「标签 + 滑块 + 读数」。 */
export function FxRange({
  label,
  value,
  min,
  max,
  step,
  disabled,
  display,
  ariaLabel,
  onChange,
  onCommit,
}: FxRangeProps) {
  return (
    <div className={ROW}>
      <span className={LABEL}>{label}</span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(Number(e.target.value))}
        {...commitHandlers(onCommit)}
        className={SLIDER}
        aria-label={ariaLabel}
      />
      <span className="w-14 text-right text-[11px] tabular-nums">{display}</span>
    </div>
  );
}

interface EqBandRowProps {
  /** 0 基下标；aria-label 里用 1 基。 */
  index: number;
  band: EqBand;
  disabled: boolean;
  /** 删除按钮的禁用条件更宽（总开关关掉即禁，不要求 EQ 开着）。 */
  removeDisabled: boolean;
  onFreqChange: (freq: number) => void;
  onGainChange: (gain: number) => void;
  onQChange: (q: number) => void;
  onRemove: () => void;
  onCommit: () => void;
}

/**
 * 一段参量 EQ。窄屏（音乐模式只有 380px）必须一行放得下：频率用数字输入
 * （对数滑杆要占掉大半行），增益留滑杆（最常调的就是它），Q 挤成窄条。
 */
export function EqBandRow({
  index,
  band,
  disabled,
  removeDisabled,
  onFreqChange,
  onGainChange,
  onQChange,
  onRemove,
  onCommit,
}: EqBandRowProps) {
  const n = index + 1;
  return (
    <div className={ROW}>
      <input
        type="number"
        min={EQ_FREQ_MIN}
        max={EQ_FREQ_MAX}
        step={10}
        value={band.freq}
        disabled={disabled}
        onChange={(e) => {
          // 输入中途（如想打 1000 时的 "1"）不提交，否则会被夹到下限
          const v = Number(e.target.value);
          if (Number.isFinite(v) && v >= EQ_FREQ_MIN && v <= EQ_FREQ_MAX) onFreqChange(v);
        }}
        onBlur={onCommit}
        className="w-16 bg-input border border-border rounded px-1 py-0.5 text-[11px] tabular-nums focus-ring"
        aria-label={`第 ${n} 段频率 Hz`}
        title={`${band.freq} Hz（${freqLabel(band.freq)}）`}
      />
      <input
        type="range"
        min={-EQ_GAIN_LIMIT}
        max={EQ_GAIN_LIMIT}
        step={0.5}
        value={band.gain}
        disabled={disabled}
        onChange={(e) => onGainChange(Number(e.target.value))}
        {...commitHandlers(onCommit)}
        className={SLIDER}
        aria-label={`第 ${n} 段增益`}
      />
      <span className="w-9 text-right text-[11px] tabular-nums">
        {band.gain > 0 ? '+' : ''}
        {band.gain.toFixed(1)}
      </span>
      <input
        type="range"
        min={EQ_Q_MIN}
        max={EQ_Q_MAX}
        step={0.1}
        value={band.q}
        disabled={disabled}
        onChange={(e) => onQChange(Number(e.target.value))}
        {...commitHandlers(onCommit)}
        className="w-10 accent-primary shrink-0"
        aria-label={`第 ${n} 段 Q 值`}
        title={`Q ${band.q.toFixed(1)}`}
      />
      <button
        type="button"
        onClick={onRemove}
        disabled={removeDisabled}
        className={ICON_BTN}
        aria-label={`删除第 ${n} 段`}
        title="删除该段"
      >
        <X size={12} />
      </button>
    </div>
  );
}
