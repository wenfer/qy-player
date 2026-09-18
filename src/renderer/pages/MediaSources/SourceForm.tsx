import { useState } from 'react';
import { FolderOpen, PlugZap, Loader2, Globe, FolderOpen as Folder, CheckCircle2, XCircle } from 'lucide-react';
import WebDavFields, { validateWebDavUrlHint, type WebDavFieldValues } from './WebDavFields';
import type { SourcePurpose } from '../../../shared/types';

export type SourceFormMode = 'local' | 'webdav';

/** What the form submits; validated main-side per kind (plan §7/§8). */
export type SourceFormPayload =
  | { kind: 'local'; root: string; name: string; purpose: SourcePurpose }
  | {
      kind: 'webdav';
      url: string;
      name: string;
      username: string;
      password: string;
      confirmHttpPlaintext: boolean;
      purpose: SourcePurpose;
    };

interface SourceFormProps {
  saving: boolean;
  testing: boolean;
  formError: string | null;
  /** True when secrets survive restarts (drives the storage hint). */
  persistentSecrets: boolean;
  /** 用途预选（QYP3-039）：视频模式的媒体库预选 'video'，音乐模式 'music'。 */
  defaultPurpose?: SourcePurpose;
  onPick: () => Promise<string | null>;
  onTest: (payload: SourceFormPayload) => Promise<{ ok: boolean; capabilities?: SourceFormCaps; error?: string } | null>;
  onSave: (payload: SourceFormPayload) => Promise<boolean>;
  onCancel: () => void;
}

const PURPOSE_OPTIONS: Array<{ value: SourcePurpose; label: string }> = [
  { value: 'all', label: '两者' },
  { value: 'music', label: '仅音乐' },
  { value: 'video', label: '仅视频' },
];

export interface SourceFormCaps {
  canSeek: boolean;
  canDelete: boolean;
  supportsEtag: boolean;
  supportsRange: boolean;
}

/**
 * Add-source form with a 本地/WebDAV mode toggle (QYP2-013).
 * 1280x800 safe: single-column, wrapping layout; no horizontal scroll.
 */
export default function SourceForm({
  saving,
  testing,
  formError,
  persistentSecrets,
  defaultPurpose = 'all',
  onPick,
  onTest,
  onSave,
  onCancel,
}: SourceFormProps) {
  const [mode, setMode] = useState<SourceFormMode>('local');
  const [purpose, setPurpose] = useState<SourcePurpose>(defaultPurpose);
  const [root, setRoot] = useState('');
  const [name, setName] = useState('');
  const [webdav, setWebdav] = useState<WebDavFieldValues>({
    url: '',
    username: '',
    password: '',
    confirmPlaintext: false,
  });
  const [testResult, setTestResult] = useState<{ ok: boolean; capabilities?: SourceFormCaps; error?: string } | null>(null);

  const buildPayload = (): SourceFormPayload | null => {
    if (mode === 'local') {
      if (!root) return null;
      return { kind: 'local', root, name, purpose };
    }
    if (!webdav.url.trim()) return null;
    return {
      kind: 'webdav',
      url: webdav.url.trim(),
      name,
      username: webdav.username,
      password: webdav.password,
      confirmHttpPlaintext: webdav.confirmPlaintext,
      purpose,
    };
  };

  const reset = (): void => {
    setRoot('');
    setName('');
    setWebdav({ url: '', username: '', password: '', confirmPlaintext: false });
    setTestResult(null);
  };

  const handlePick = async (): Promise<void> => {
    const picked = await onPick();
    if (picked) setRoot(picked);
  };

  const handleTest = async (): Promise<void> => {
    const payload = buildPayload();
    if (!payload) return;
    const result = await onTest(payload);
    setTestResult(result ?? { ok: false, error: '测试失败' });
  };

  const handleSave = async (): Promise<void> => {
    const payload = buildPayload();
    if (!payload) return;
    const saved = await onSave(payload);
    if (saved) reset();
  };

  const urlHint = mode === 'webdav' ? validateWebDavUrlHint(webdav.url) : null;
  const canSubmit =
    mode === 'local' ? root !== '' : webdav.url.trim() !== '' && urlHint === null;

  const capsText = (caps: SourceFormCaps): string => {
    const parts = [`拖动/续播: ${caps.supportsRange ? '支持' : '不可靠'}`, `ETag: ${caps.supportsEtag ? '支持' : '不支持'}`];
    if (!caps.canDelete) parts.push('删除已禁用');
    return parts.join(' · ');
  };

  return (
    <div className="mb-4 p-4 bg-card border border-border rounded-xl space-y-3" data-testid="source-form">
      {formError && (
        <p role="alert" className="text-sm text-destructive">
          {formError}
        </p>
      )}
      {/* Mode toggle: segmented control on a tinted track */}
      <div className="flex items-center gap-1 p-1 bg-secondary rounded-lg w-fit" role="tablist" aria-label="来源类型">
        <button
          type="button"
          role="tab"
          aria-selected={mode === 'local'}
          onClick={() => setMode('local')}
          className={`flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-md transition-all focus-ring ${
            mode === 'local'
              ? 'bg-background text-foreground'
              : 'text-muted-foreground hover:text-foreground'
          }`}
        >
          <Folder size={14} />
          本地目录
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={mode === 'webdav'}
          onClick={() => setMode('webdav')}
          className={`flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-md transition-all focus-ring ${
            mode === 'webdav'
              ? 'bg-background text-foreground'
              : 'text-muted-foreground hover:text-foreground'
          }`}
        >
          <Globe size={14} />
          WebDAV
        </button>
      </div>

      {/* 用途（QYP3-039）：决定该来源被哪个模式的媒体库管理与扫描范围 */}
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm text-muted-foreground">用途</span>
        <div className="flex items-center gap-1 p-1 bg-secondary rounded-lg" role="radiogroup" aria-label="来源用途">
          {PURPOSE_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              type="button"
              role="radio"
              aria-checked={purpose === opt.value}
              onClick={() => setPurpose(opt.value)}
              className={`px-2.5 py-1 text-xs rounded-md transition-all focus-ring ${
                purpose === opt.value
                  ? 'bg-background text-foreground'
                  : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              {opt.label}
            </button>
          ))}
        </div>
        {purpose !== 'all' && (
          <span className="text-[11px] text-muted-foreground">
            {purpose === 'music' ? '扫描时只索引音频文件' : '扫描时只索引视频文件'}
          </span>
        )}
      </div>

      {mode === 'local' ? (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={handlePick}
              className="flex items-center gap-1.5 px-3 py-2 text-sm border border-border rounded-lg hover:bg-accent transition-colors focus-ring"
            >
              <FolderOpen size={15} />
              {root ? '重新选择目录' : '选择目录'}
            </button>
            <span
              className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-sm max-w-full ${
                root ? 'bg-secondary text-foreground' : 'text-muted-foreground'
              }`}
              title={root}
              aria-live="polite"
            >
              <FolderOpen size={13} className="flex-shrink-0 text-muted-foreground" />
              <span className="truncate font-mono text-xs">{root || '尚未选择目录'}</span>
            </span>
          </div>
          <label className="block text-sm">
            <span className="text-muted-foreground">名称（可选）</span>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="例如：电影收藏"
              className="mt-1 w-full px-3 py-2 bg-secondary border border-border rounded-lg text-sm focus-ring"
            />
          </label>
        </>
      ) : (
        <WebDavFields values={webdav} onChange={setWebdav} persistentSecrets={persistentSecrets} />
      )}
      {mode === 'webdav' && (
        <label className="block text-sm">
          <span className="text-muted-foreground">名称（可选）</span>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="例如：家庭云盘"
            className="mt-1 w-full px-3 py-2 bg-secondary border border-border rounded-lg text-sm focus-ring"
          />
        </label>
      )}

      {testResult && (
        <p
          role="status"
          className={`flex items-start gap-1.5 text-xs px-3 py-2 rounded-lg ${
            testResult.ok
              ? 'bg-emerald-500/10 text-emerald-500'
              : 'bg-destructive/10 text-destructive'
          }`}
        >
          {testResult.ok ? <CheckCircle2 size={14} className="flex-shrink-0 mt-0.5" /> : <XCircle size={14} className="flex-shrink-0 mt-0.5" />}
          <span>
            {testResult.ok
              ? `连接成功${testResult.capabilities ? `（${capsText(testResult.capabilities)}）` : ''}`
              : `不可用：${testResult.error ?? '未知错误'}`}
          </span>
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={handleTest}
          disabled={!canSubmit || testing}
          className="flex items-center gap-1.5 px-3 py-2 text-sm border border-border rounded-lg hover:bg-accent transition-colors focus-ring disabled:opacity-50"
        >
          {testing ? <Loader2 size={15} className="animate-spin" /> : <PlugZap size={15} />}
          测试连接
        </button>
        <button
          type="button"
          onClick={handleSave}
          disabled={!canSubmit || saving}
          className="flex items-center gap-1.5 px-4 py-2 text-sm bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 active:scale-[0.98] transition-all focus-ring disabled:opacity-50 disabled:active:scale-100"
        >
          {saving ? <Loader2 size={15} className="animate-spin" /> : null}
          添加来源
        </button>
        <button type="button" onClick={onCancel} className="px-3 py-2 text-sm text-muted-foreground hover:text-foreground focus-ring">
          取消
        </button>
      </div>
      <p className="text-[11px] text-muted-foreground">
        仅会读取该来源的媒体文件用于建立索引；不会修改或删除任何文件。
      </p>
    </div>
  );
}
