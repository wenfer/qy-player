import { useEffect, useMemo, useState } from 'react';
import { findCurrentLine, parseLrc, type LrcLine } from '../../../main/modules/playback-engine/lrc-parser';

/**
 * 桌面歌词窗口（ADR-0008 / QYP3-022）：两行式（当前行 + 下一行），
 * 逐字渐变高亮；进度与样式由主进程统一推送（渲染层不复制同步算法）。
 * 锁定状态下窗口鼠标穿透，只有解锁（关闭锁定）时才可拖动。
 */

interface DeskState {
  title: string;
  content: string | null;
  position: number;
  isPlaying: boolean;
}

/** 当前行内的逐字进度（0~1）；无逐字标签时返回 null。 */
function wordProgress(line: LrcLine | undefined, position: number): number | null {
  if (!line?.words || line.words.length === 0) return null;
  const first = line.words[0];
  const last = line.words[line.words.length - 1];
  const total = last.time - first.time;
  if (total <= 0) return 1;
  return Math.min(1, Math.max(0, (position - first.time) / total));
}

export default function DeskLyrics() {
  const [state, setState] = useState<DeskState>({ title: '', content: null, position: 0, isPlaying: false });
  const [fontSize, setFontSize] = useState(28);
  const [locked, setLocked] = useState(true);

  useEffect(() => {
    // 透明窗口：body 不能带主题底色（主窗口的深色底在这里是黑块）
    document.documentElement.style.background = 'transparent';
    document.body.style.background = 'transparent';
    const off = window.electronAPI.onDeskLyricsEvent((payload) => {
      if (payload.type === 'state' && payload.state) setState(payload.state);
      if (payload.type === 'style' && payload.style) {
        setFontSize(payload.style.fontSize);
        setLocked(payload.style.locked);
      }
    });
    return () => {
      if (typeof off === 'function') off();
    };
  }, []);

  const parsed = useMemo(() => (state.content ? parseLrc(state.content) : null), [state.content]);
  const lines = parsed?.lines ?? [];
  const index = lines.length > 0 ? findCurrentLine(lines, state.position) : -1;
  const current = index >= 0 ? lines[index] : undefined;
  const next = index >= 0 ? lines[index + 1] : undefined;
  const progress = wordProgress(current, state.position);

  // 无歌词时不渲染内容（main 侧也会隐藏窗口，这里是双保险）
  if (!state.content || !state.isPlaying) {
    return <div className="w-screen h-screen" />;
  }

  const dragStyle = { WebkitAppRegion: locked ? 'no-drag' : 'drag' } as React.CSSProperties;

  return (
    <div
      className="w-screen h-screen flex flex-col items-center justify-center gap-1 select-none px-6"
      style={dragStyle}
    >
      {current ? (
        <p
          className="text-center font-semibold leading-tight"
          style={{
            fontSize,
            color: '#ffffff',
            textShadow: '0 2px 6px rgba(0,0,0,0.9), 0 0 2px rgba(0,0,0,1)',
            // 卡拉OK 式渐变填充：逐字标签存在时按进度推进
            ...(progress === null
              ? {}
              : {
                  backgroundImage: 'linear-gradient(90deg, #ffd166 0%, #ffd166 100%)',
                  backgroundSize: `${progress * 100}% 100%`,
                  backgroundRepeat: 'no-repeat' as const,
                  WebkitBackgroundClip: 'text',
                  backgroundClip: 'text',
                  WebkitTextFillColor: 'transparent',
                }),
          }}
        >
          {current.text}
        </p>
      ) : (
        <p className="text-center font-semibold" style={{ fontSize, color: '#ffffff', textShadow: '0 2px 6px rgba(0,0,0,0.9)' }}>
          {state.title || '·'}
        </p>
      )}
      {next && (
        <p
          className="text-center opacity-70"
          style={{
            fontSize: Math.round(fontSize * 0.7),
            color: '#ffffff',
            textShadow: '0 2px 6px rgba(0,0,0,0.9)',
          }}
        >
          {next.text}
        </p>
      )}
    </div>
  );
}
