import { ArrowRight, Repeat, Repeat1, Shuffle } from 'lucide-react';
import { playModeLabel, playModeOf, useMusicPlaybackStore, type PlayMode } from '../../stores/music-playback-store';

/**
 * 播放模式按钮（QYP3-068t/068u）：循环与随机在 UI 上是**一个**按钮的四态
 * （顺序 → 列表循环 → 单曲循环 → 随机），存储层仍是 `repeat` + `shuffle`
 * 两个字段——换算只认 `playModeOf`/`playModeLabel`，UI 不自己拼图标与文案。
 *
 * 精简浮窗与播放条共用这一个组件：图标、文案、切换行为只有一份。
 * 按钮尺寸/间距两处不同，所以 className 与 size 由调用方给。
 */
function playModeIcon(mode: PlayMode, size: number) {
  if (mode === 'repeat-one') return <Repeat1 size={size} />;
  if (mode === 'repeat-all') return <Repeat size={size} />;
  if (mode === 'shuffle') return <Shuffle size={size} />;
  return <ArrowRight size={size} />;
}

interface PlayModeButtonProps {
  className?: string;
  size?: number;
}

export default function PlayModeButton({ className = '', size = 16 }: PlayModeButtonProps) {
  const repeat = useMusicPlaybackStore((s) => s.repeat);
  const shuffle = useMusicPlaybackStore((s) => s.shuffle);
  const cyclePlayMode = useMusicPlaybackStore((s) => s.cyclePlayMode);
  const mode = playModeOf(repeat, shuffle);

  return (
    <button
      type="button"
      onClick={cyclePlayMode}
      aria-label="播放模式"
      aria-pressed={mode !== 'sequence'}
      title={playModeLabel(mode)}
      className={`${className} ${mode !== 'sequence' ? 'text-primary' : ''}`}
    >
      {playModeIcon(mode, size)}
    </button>
  );
}
