import { useCallback, useEffect, useRef, useState } from 'react';
import { AlertTriangle, ChevronDown, Film, RefreshCw, WifiOff, Video, XCircle } from 'lucide-react';
import type { MediaProbeOutcome, ProbeItemInput } from '../../../shared/types/media-info';

/**
 * Technical-info panel (QYP2-019, plan §15). Collapsible, wrapping, and
 * strictly informational: probe failures never block playback. Each
 * terminal state has its own distinct presentation (probing / unsupported /
 * timeout / no-mpv / offline) per the acceptance criteria.
 */

export type ProbePhase =
  | 'idle'
  | 'probing'
  | 'ok'
  | 'unsupported'
  | 'timeout'
  | 'no-mpv'
  | 'offline'
  /** Probe target refused credentials (expired login). */
  | 'auth';

export interface MediaInfoPanelProps {
  /** Probe request; when null the panel renders nothing. */
  request: ProbeItemInput | null;
  /** Triggered on mount and on retry. */
  onProbe: () => void;
  /** Latest probe outcome (null while probing). */
  outcome: MediaProbeOutcome | null;
  phase: ProbePhase;
}

function formatDuration(seconds: number): string {
  const total = Math.floor(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

const STATUS_TEXT: Record<'timeout' | 'no-mpv' | 'offline' | 'auth', string> = {
  timeout: '读取超时：媒体响应过慢，可稍后重试',
  'no-mpv': '未找到可用的 mpv，无法读取技术信息',
  offline: '来源暂不可达或连接中断',
  auth: '登录已过期，请重新登录后再试',
};

export default function MediaInfoPanel({ request, onProbe, outcome, phase }: MediaInfoPanelProps) {
  const [expanded, setExpanded] = useState(false);
  const lastRequestedKey = useRef<string | null>(null);

  // Probe on mount / request change (non-blocking; failures stay here).
  useEffect(() => {
    if (!request) return;
    const key = `${request.ref.provider}:${request.ref.serverId ?? ''}:${request.ref.itemId ?? ''}:${request.mode ?? ''}`;
    if (lastRequestedKey.current === key) return;
    lastRequestedKey.current = key;
    onProbe();
  }, [request, onProbe]);

  const retry = useCallback(() => {
    if (phase !== 'probing') onProbe();
  }, [phase, onProbe]);

  if (!request) return null;

  const info = outcome?.info;
  const trackCount = info?.tracks.length ?? 0;
  const subtitleCount = info?.tracks.filter((t) => t.kind === 'subtitle').length ?? 0;
  const audioCount = info?.tracks.filter((t) => t.kind === 'audio').length ?? 0;
  const summary = info
    ? [
        info.container,
        info.video ? `${info.video.width}×${info.video.height}` : undefined,
        info.duration !== undefined ? formatDuration(info.duration) : undefined,
      ]
        .filter(Boolean)
        .join(' · ')
    : undefined;

  return (
    <section className="mt-8" aria-label="技术信息">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        className="flex items-center gap-1.5 text-sm font-semibold focus-ring rounded-md py-1 text-foreground hover:text-foreground"
      >
        <Film size={14} className="text-muted-foreground" />
        技术信息
        <ChevronDown
          size={14}
          className={`text-muted-foreground transition-transform ${expanded ? 'rotate-180' : ''}`}
        />
        {summary && <span className="text-xs font-normal text-muted-foreground">{summary}</span>}
      </button>

      {expanded && (
        <div className="mt-3 text-sm" aria-busy={phase === 'probing'}>
          {phase === 'probing' && (
            <p className="text-muted-foreground flex items-center gap-2">
              <RefreshCw size={14} className="animate-spin" aria-hidden />
              正在读取技术信息…
            </p>
          )}

          {phase === 'ok' && info && (
            <dl className="flex flex-wrap gap-x-6 gap-y-2">
              {info.container && (
                <div className="flex gap-1.5">
                  <dt className="text-muted-foreground">容器</dt>
                  <dd>{info.container}</dd>
                </div>
              )}
              {info.video?.codec && (
                <div className="flex gap-1.5">
                  <dt className="text-muted-foreground">视频</dt>
                  <dd>
                    {info.video.codec.toUpperCase()}
                    {info.video.width !== undefined && info.video.height !== undefined && (
                      <> · {info.video.width}×{info.video.height}</>
                    )}
                    {info.video.fps !== undefined && <> · {info.video.fps.toFixed(2)} fps</>}
                  </dd>
                </div>
              )}
              {info.audio?.codec && (
                <div className="flex gap-1.5">
                  <dt className="text-muted-foreground">音频</dt>
                  <dd>
                    {info.audio.codec.toUpperCase()}
                    {info.audio.channels !== undefined && <> · {info.audio.channels} 声道</>}
                    {info.audio.samplerate !== undefined && (
                      <> · {(info.audio.samplerate / 1000).toFixed(1)} kHz</>
                    )}
                  </dd>
                </div>
              )}
              {trackCount > 0 && (
                <div className="flex gap-1.5">
                  <dt className="text-muted-foreground">轨道</dt>
                  <dd>
                    {audioCount} 音频 · {subtitleCount} 字幕
                  </dd>
                </div>
              )}
            </dl>
          )}

          {/* Track list: collapsible-safe, wraps, no horizontal scroll. */}
          {phase === 'ok' && trackCount > 0 && (
            <ul className="mt-3 flex flex-wrap gap-2">
              {info?.tracks.map((track, index) => (
                <li
                  key={`${track.kind}-${index}`}
                  className="px-2 py-1 bg-card border border-border rounded-md text-xs text-muted-foreground"
                >
                  {track.kind === 'video' && <Video size={11} className="inline mr-1" aria-hidden />}
                  {track.kind === 'video' && '视频'}
                  {track.kind === 'audio' && `音频${track.language ? ` ${track.language}` : ''}`}
                  {track.kind === 'subtitle' && `字幕${track.language ? ` ${track.language}` : ''}`}
                  {track.title ? ` · ${track.title}` : ''}
                  {track.codec ? ` · ${track.codec}` : ''}
                  {track.isDefault ? ' · 默认' : ''}
                </li>
              ))}
            </ul>
          )}

          {phase === 'unsupported' && (
            <p className="text-muted-foreground flex items-center gap-2">
              <AlertTriangle size={14} className="text-yellow-500" aria-hidden />
              该文件不含可读取的技术信息
            </p>
          )}

          {(phase === 'timeout' || phase === 'no-mpv' || phase === 'offline' || phase === 'auth') && (
            <div className="flex flex-wrap items-center gap-3">
              <p
                className="text-muted-foreground flex items-center gap-2"
                role="status"
              >
                {phase === 'offline' ? (
                  <WifiOff size={14} aria-hidden />
                ) : (
                  <XCircle size={14} className="text-destructive" aria-hidden />
                )}
                {STATUS_TEXT[phase]}
              </p>
              <button
                type="button"
                onClick={retry}
                className="px-2.5 py-1 text-xs border border-border rounded-md hover:bg-accent focus-ring text-muted-foreground hover:text-foreground"
              >
                重试
              </button>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
