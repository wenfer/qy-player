export default function PosterSkeleton({ count = 8 }: { count?: number }) {
  return (
    <div className="grid grid-cols-3 md:grid-cols-5 lg:grid-cols-6 gap-x-4 gap-y-6" aria-busy="true" aria-label="加载海报">
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} className="w-full" aria-hidden="true">
          <div className="aspect-[2/3] bg-muted rounded-lg animate-pulse" />
          <div className="mt-2 space-y-1.5">
            <div className="h-4 bg-muted rounded animate-pulse w-3/4" />
            <div className="h-3 bg-muted rounded animate-pulse w-1/2" />
          </div>
        </div>
      ))}
    </div>
  );
}
