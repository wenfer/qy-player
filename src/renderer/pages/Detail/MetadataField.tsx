import { Star, Undo2 } from 'lucide-react';
import type { MetadataConflict, MetadataFieldInfo, MetadataValue } from '../../../shared/types/metadata-editor';

/**
 * One editable metadata field row (QYP2-023): provider provenance badge,
 * shape-appropriate control, restore button, conflict diff (§14.1).
 */

const PROVIDER_LABEL: Record<string, string> = {
  manual: '手工',
  nfo: 'NFO',
  scraper: '刮削',
  filename: '文件名',
};

export type FieldShape = 'text' | 'longText' | 'number' | 'rating' | 'date' | 'tags' | 'cast' | 'ids' | 'image';

/** Field name → control shape (mirrors the service whitelist). */
export const FIELD_SHAPES: Record<string, FieldShape> = {
  title: 'text',
  originalTitle: 'text',
  sortTitle: 'text',
  tagline: 'text',
  contentRating: 'text',
  plot: 'longText',
  year: 'number',
  season: 'number',
  episode: 'number',
  rating: 'rating',
  premiered: 'date',
  genres: 'tags',
  countries: 'tags',
  directors: 'tags',
  actors: 'cast',
  uniqueIds: 'ids',
  poster: 'image',
  fanart: 'image',
};

/** Convert a wire value into the control's string form (lists → lines). */
export function valueToText(value: MetadataValue | null | undefined, shape: FieldShape): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  if (shape === 'cast') {
    return (value as Array<{ name: string; role?: string }>)
      .map((entry) => (entry.role ? `${entry.name} | ${entry.role}` : entry.name))
      .join('\n');
  }
  if (shape === 'ids') {
    return (value as Array<{ provider: string; id: string }>)
      .map((entry) => `${entry.provider}:${entry.id}`)
      .join('\n');
  }
  if (Array.isArray(value)) return value.join(', ');
  return '';
}

/** Parse the control's text back into the field's wire value (or null). */
export function textToValue(_field: string, shape: FieldShape, text: string): MetadataValue {
  switch (shape) {
    case 'number':
    case 'rating':
      return Number(text);
    case 'tags':
      return text
        .split(/[,，]/)
        .map((part) => part.trim())
        .filter((part) => part.length > 0);
    case 'cast':
      return text
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .map((line) => {
          const [name, role] = line.split('|').map((part) => part.trim());
          return role ? { name, role } : { name };
        });
    case 'ids':
      return text
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .map((line) => {
          const sep = line.indexOf(':');
          return sep <= 0 ? { provider: line, id: '' } : { provider: line.slice(0, sep), id: line.slice(sep + 1) };
        });
    default:
      return text;
  }
}

export interface MetadataFieldProps {
  info: MetadataFieldInfo;
  /** Current draft text ('' = no draft). */
  draftText: string;
  hasDraft: boolean;
  conflict?: MetadataConflict;
  disabled?: boolean;
  onChange: (text: string) => void;
  onRestore: () => void;
  onOverrideConflict: () => void;
  onDropConflict: () => void;
  onImportImage?: () => void;
}

export default function MetadataField({
  info, draftText, hasDraft, conflict, disabled, onChange, onRestore, onOverrideConflict, onDropConflict, onImportImage,
}: MetadataFieldProps) {
  const shape = FIELD_SHAPES[info.field] ?? 'text';
  const displayText = hasDraft ? draftText : valueToText(info.winner?.value, shape);
  const winnerProvider = info.winner?.provider;
  const isDefault = info.winner?.provider === 'manual';
  const inputId = `meta-${info.field}`;

  const commonInput = 'w-full px-3 py-2 bg-secondary border border-border rounded-lg text-sm focus:outline-none focus:border-primary/50';

  return (
    <div className="mb-4">
      <div className="flex items-center justify-between mb-1.5">
        <label htmlFor={shape === 'image' ? undefined : inputId} className="text-xs font-medium text-muted-foreground">
          {info.field}
        </label>
        <div className="flex items-center gap-2">
          {winnerProvider && (
            <span
              className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md text-[10px] font-medium ${
                isDefault ? 'bg-primary/10 text-primary' : 'bg-secondary text-secondary-foreground'
              }`}
            >
              {isDefault && <Star size={10} fill="currentColor" />}
              {PROVIDER_LABEL[winnerProvider] ?? winnerProvider}
            </span>
          )}
          {!conflict && !disabled && (
            <button
              type="button"
              onClick={onRestore}
              disabled={!winnerProvider || winnerProvider === 'manual'}
              title={winnerProvider === 'manual' ? '已是手工值' : '恢复来源值'}
              className="p-0.5 text-muted-foreground hover:text-foreground rounded focus-ring disabled:opacity-40"
              aria-label={`恢复 ${info.field} 的来源值`}
            >
              <Undo2 size={12} />
            </button>
          )}
        </div>
      </div>

      {shape === 'longText' ? (
        <textarea
          id={inputId}
          value={displayText}
          onChange={(e) => onChange(e.target.value)}
          disabled={disabled}
          rows={4}
          className={`${commonInput} resize-y`}
        />
      ) : shape === 'number' || shape === 'rating' ? (
        <input
          id={inputId}
          type="number"
          step={shape === 'rating' ? '0.1' : '1'}
          min={shape === 'rating' ? 0 : 0}
          max={shape === 'rating' ? 10 : undefined}
          value={displayText}
          onChange={(e) => onChange(e.target.value)}
          disabled={disabled}
          className={commonInput}
        />
      ) : shape === 'date' ? (
        <input
          id={inputId}
          type="text"
          placeholder="YYYY-MM-DD"
          value={displayText}
          onChange={(e) => onChange(e.target.value)}
          disabled={disabled}
          className={commonInput}
        />
      ) : shape === 'cast' || shape === 'ids' ? (
        <textarea
          id={inputId}
          value={displayText}
          onChange={(e) => onChange(e.target.value)}
          disabled={disabled}
          rows={3}
          placeholder={shape === 'cast' ? '每行：姓名 | 角色' : '每行：provider:id'}
          className={`${commonInput} resize-y font-mono text-xs`}
        />
      ) : shape === 'image' ? (
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground truncate flex-1 font-mono" title={displayText}>
            {displayText || '未导入'}
          </span>
          <button
            type="button"
            onClick={onImportImage}
            disabled={disabled}
            aria-label={`导入 ${info.field} 图片`}
            className="px-2.5 py-1 text-xs border border-border rounded-md hover:bg-accent focus-ring text-muted-foreground hover:text-foreground"
          >
            导入图片
          </button>
        </div>
      ) : (
        <input
          id={inputId}
          type="text"
          value={displayText}
          onChange={(e) => onChange(e.target.value)}
          disabled={disabled}
          className={commonInput}
        />
      )}

      {conflict && (
        <div className="mt-1.5 p-2 bg-amber-500/10 rounded-lg text-xs" role="alert">
          <p className="text-amber-500 mb-1">
            保存时该字段已被其他修改更新（版本冲突）
          </p>
          <p className="text-muted-foreground">
            当前值：
            <span className="text-foreground">
              {conflict.current ? valueToText(conflict.current.value, shape) : '（空）'}
            </span>
          </p>
          <p className="text-muted-foreground">
            你提交的值：<span className="text-foreground">{draftText || '（空）'}</span>
          </p>
          <div className="flex gap-2 mt-1.5">
            <button
              type="button"
              onClick={onOverrideConflict}
              className="px-2 py-0.5 bg-primary text-primary-foreground rounded-md text-[11px] focus-ring"
            >
              用我的值覆盖
            </button>
            <button
              type="button"
              onClick={onDropConflict}
              className="px-2 py-0.5 border border-border rounded-md text-[11px] focus-ring text-muted-foreground hover:text-foreground"
            >
              放弃我的修改
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
