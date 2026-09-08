export default function DetailSkeleton() {
  return (
    <div className="min-h-screen" aria-busy="true" aria-label="加载详情">
      {/* Backdrop */}
      <div className="h-[400px] bg-muted animate-pulse" />
      <div className="px-8 -mt-32 relative z-10">
        <div className="flex gap-8">
          {/* Poster */}
          <div className="flex-shrink-0 w-[200px] md:w-[260px]">
            <div className="aspect-[2/3] bg-muted rounded-xl animate-pulse" />
            <div className="mt-4 h-12 bg-muted rounded-xl animate-pulse" />
          </div>
          {/* Info */}
          <div className="flex-1 space-y-4 pt-8">
            <div className="h-10 bg-muted rounded animate-pulse w-2/3" />
            <div className="flex gap-3">
              <div className="h-5 bg-muted rounded animate-pulse w-16" />
              <div className="h-5 bg-muted rounded animate-pulse w-12" />
              <div className="h-5 bg-muted rounded animate-pulse w-20" />
            </div>
            <div className="space-y-2">
              <div className="h-4 bg-muted rounded animate-pulse" />
              <div className="h-4 bg-muted rounded animate-pulse" />
              <div className="h-4 bg-muted rounded animate-pulse w-3/4" />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
