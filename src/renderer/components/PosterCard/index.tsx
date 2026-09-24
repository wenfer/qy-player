import { useState } from 'react';
import { Play, Star } from 'lucide-react';
import { episodeCode } from '../../utils/media-card';

interface PosterCardProps {
  id: string;
  name: string;
  imageUrl?: string;
  year?: number;
  rating?: number;
  type: string;
  progress?: number;
  /** 剧集条目才有的三项：用来显示 SxxExx 与剧名。 */
  seriesName?: string;
  seasonNumber?: number;
  episodeNumber?: number;
  onClick?: () => void;
  onPlay?: () => void;
}

const TYPE_LABELS: Record<string, string> = {
  Movie: '电影',
  Series: '剧集',
  Episode: '剧集',
  Season: '季',
  Video: '视频',
  MusicVideo: 'MV',
  Trailer: '预告',
  Folder: '文件夹',
  BoxSet: '合集',
};

export default function PosterCard({
  name,
  imageUrl,
  year,
  rating,
  type,
  progress,
  seriesName,
  seasonNumber,
  episodeNumber,
  onClick,
  onPlay,
}: PosterCardProps) {
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState(false);

  const showProgress = progress !== undefined && progress > 0 && progress < 0.95;
  const code = episodeCode(seasonNumber, episodeNumber);
  // 剧名只在没把剧名当标题时才需要单独占一行
  const seriesLine = seriesName && seriesName !== name ? seriesName : undefined;
  const metaLine = [seriesLine, code].filter(Boolean).join(' · ');

  return (
    <article
      className="group relative rounded-lg overflow-hidden cursor-pointer bg-card border border-border transition-all duration-200 hover:border-primary/30 card-lift"
      onClick={onClick}
      tabIndex={0}
      role="button"
      aria-label={`${name}, ${TYPE_LABELS[type] || type}${code ? `, ${code}` : ''}${year ? `, ${year}年` : ''}`}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onClick?.();
        }
      }}
    >
      {/* Image container */}
      <div className="aspect-[2/3] relative bg-muted">
        {imageUrl && !error ? (
          <img
            src={imageUrl}
            alt=""
            loading="lazy"
            className={`w-full h-full object-cover transition-opacity duration-300 ${loaded ? 'opacity-100' : 'opacity-0'}`}
            onLoad={() => setLoaded(true)}
            onError={() => setError(true)}
          />
        ) : (
          <div className="w-full h-full flex items-center justify-center text-muted-foreground">
            <span className="text-5xl font-bold opacity-10 select-none">{name.charAt(0)}</span>
          </div>
        )}

        {/* Hover overlay with play button */}
        {onPlay && (
          <div className="absolute inset-0 bg-black/50 opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100 transition-opacity flex items-center justify-center">
            <button
              onClick={(e) => {
                e.stopPropagation();
                onPlay();
              }}
              className="p-3 bg-primary text-primary-foreground rounded-full hover:bg-primary/90 transition-colors focus-ring"
              aria-label={`播放 ${name}`}
            >
              <Play size={20} fill="currentColor" />
            </button>
          </div>
        )}

        {/* Type badge: movies / TV. Single episodes count as TV too (they come
            back from resume as one episode of a series — labelling them 电影
            was the bug). */}
        {(type === 'Movie' || type === 'Series' || type === 'Episode') && (
          <span className="absolute top-2 right-2 px-1.5 py-0.5 bg-black/70 text-white text-[10px] font-medium rounded">
            {TYPE_LABELS[type]}
          </span>
        )}

        {/* Rating badge */}
        {rating !== undefined && rating > 0 && (
          <span className="absolute top-2 left-2 flex items-center gap-0.5 px-1.5 py-0.5 bg-black/70 text-yellow-400 text-[10px] font-medium rounded">
            <Star size={10} fill="currentColor" />
            {rating.toFixed(1)}
          </span>
        )}

        {/* Progress bar */}
        {showProgress && (
          <div className="absolute bottom-0 left-0 right-0 h-1 bg-white/20">
            <div
              className="h-full bg-primary"
              style={{ width: `${progress * 100}%` }}
              aria-hidden="true"
            />
          </div>
        )}
      </div>

      {/* Info */}
      <div className="p-2.5">
        <h3 className="font-medium text-sm leading-tight line-clamp-2">{name}</h3>
        {metaLine ? (
          <p className="mt-1 text-xs text-muted-foreground truncate" title={metaLine}>
            {metaLine}
          </p>
        ) : (
          year && <p className="mt-1 text-xs text-muted-foreground">{year}</p>
        )}
      </div>
    </article>
  );
}
