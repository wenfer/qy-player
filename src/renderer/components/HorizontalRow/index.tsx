import PosterCard from '../PosterCard';

export interface MediaItem {
  id: string;
  name: string;
  imageUrl?: string;
  /** Landscape thumbnail (better for wide cards than a cropped portrait). */
  thumbUrl?: string;
  year?: number;
  rating?: number;
  type: string;
  progress?: number;
  serverId?: number;
  serverType?: string;
  /** Raw ISO date from the server, used for cross-library "recently added" sorting. */
  dateCreated?: string;
}

interface HorizontalRowProps {
  title: string;
  items: MediaItem[];
  onItemClick?: (item: MediaItem) => void;
  onItemPlay?: (item: MediaItem) => void;
}

/**
 * Poster row that wraps instead of scrolling horizontally.
 * On narrow windows the cards flow onto a second line, which matches
 * desktop conventions better than a hidden scroll strip with arrows.
 */
export default function HorizontalRow({ title, items, onItemClick, onItemPlay }: HorizontalRowProps) {
  if (items.length === 0) return null;

  return (
    <section className="mb-10" aria-label={title}>
      <h2 className="text-lg font-semibold tracking-tight mb-4">{title}</h2>
      <div className="flex flex-wrap gap-4" role="list">
        {items.map((item) => (
          <div key={item.id} className="w-[150px] md:w-[170px]" role="listitem">
            <PosterCard
              id={item.id}
              name={item.name}
              imageUrl={item.imageUrl}
              year={item.year}
              rating={item.rating}
              type={item.type}
              progress={item.progress}
              onClick={() => onItemClick?.(item)}
              onPlay={() => onItemPlay?.(item)}
            />
          </div>
        ))}
      </div>
    </section>
  );
}
