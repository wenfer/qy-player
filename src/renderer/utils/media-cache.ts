/**
 * 媒体库静态数据缓存与 SWR (Stale-While-Revalidate) 辅助工具。
 * 将首页继续观看、最近添加、媒体库卡片以及浏览页首屏条目持久化到本地存储。
 * 进入页面时先瞬间呈现已缓存内容（0ms 秒开），后台异步静默校验更新；
 * 在网络抖动、超时或离线状态下保留已有展示，防止白屏与长时间等待。
 */
import type { MediaItem } from '../components/HorizontalRow';

export interface CachedLibraryRow {
  viewId: string;
  rawViewId: string;
  serverId: number;
  title: string;
  collectionType: string;
  viewImageUrl?: string;
  viewThumbUrl?: string;
  items: MediaItem[];
}

export interface HomeCachePayload {
  continueWatching?: MediaItem[];
  recentAdditions?: MediaItem[];
  libraryRows?: CachedLibraryRow[];
  timestamp: number;
}

const HOME_CACHE_KEY = 'qy_cache_home_v1';
const LIB_CACHE_PREFIX = 'qy_cache_lib_v1_';

function isStorageAvailable(): boolean {
  try {
    return typeof window !== 'undefined' && typeof window.localStorage !== 'undefined';
  } catch {
    return false;
  }
}

/** 读取首页本地缓存数据 */
export function getCachedHomeData(): HomeCachePayload | null {
  if (!isStorageAvailable()) return null;
  try {
    const raw = window.localStorage.getItem(HOME_CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as HomeCachePayload;
    if (typeof parsed !== 'object' || parsed === null) return null;
    return parsed;
  } catch {
    return null;
  }
}

/** 保存或增量更新首页本地缓存数据 */
export function setCachedHomeData(patch: Partial<Omit<HomeCachePayload, 'timestamp'>>): void {
  if (!isStorageAvailable()) return;
  try {
    const prev = getCachedHomeData() || { timestamp: 0 };
    const next: HomeCachePayload = {
      continueWatching: patch.continueWatching ?? prev.continueWatching,
      recentAdditions: patch.recentAdditions ?? prev.recentAdditions,
      libraryRows: patch.libraryRows ?? prev.libraryRows,
      timestamp: Date.now(),
    };
    window.localStorage.setItem(HOME_CACHE_KEY, JSON.stringify(next));
  } catch {
    // localStorage 满了或被禁用时静默忽略
  }
}

/** 读取特定媒体库首屏条目缓存 */
export function getCachedLibraryItems(serverId: number, viewId: string): MediaItem[] | null {
  if (!isStorageAvailable()) return null;
  try {
    const raw = window.localStorage.getItem(`${LIB_CACHE_PREFIX}${serverId}_${encodeURIComponent(viewId)}`);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** 保存特定媒体库首屏条目缓存（截取前 100 条） */
export function setCachedLibraryItems(serverId: number, viewId: string, items: MediaItem[]): void {
  if (!isStorageAvailable()) return;
  try {
    const slice = items.slice(0, 100);
    window.localStorage.setItem(`${LIB_CACHE_PREFIX}${serverId}_${encodeURIComponent(viewId)}`, JSON.stringify(slice));
  } catch {
    // 忽略写入异常
  }
}
