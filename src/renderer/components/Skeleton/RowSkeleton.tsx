import PosterSkeleton from './PosterSkeleton';

interface RowSkeletonProps {
  count?: number;
}

export default function RowSkeleton({ count = 6 }: RowSkeletonProps) {
  return (
    <div className="mb-8" aria-busy="true" aria-label="加载内容行">
      <div className="h-6 bg-muted rounded animate-pulse w-32 mb-4" />
      <div className="flex gap-4 overflow-hidden">
        {Array.from({ length: count }).map((_, i) => (
          <PosterSkeleton key={i} />
        ))}
      </div>
    </div>
  );
}
