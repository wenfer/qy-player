import { useState } from 'react';
import { FolderOpen, PlugZap, Loader2 } from 'lucide-react';

export interface SourceFormValues {
  root: string;
  name: string;
}

interface SourceFormProps {
  saving: boolean;
  testing: boolean;
  formError: string | null;
  onChange: (values: SourceFormValues) => void;
  onPick: () => Promise<string | null>;
  onTest: (values: SourceFormValues) => Promise<{ ok: boolean; error?: string } | null>;
  onSave: (values: SourceFormValues) => Promise<boolean>;
  onCancel: () => void;
}

/**
 * Add-local-source form (plan §7): the renderer only ever holds a path that
 * came from the Electron directory picker; canonicalization and validation
 * happen main-side. 1280x800 safe: single-column, wrapping layout.
 */
export default function SourceForm({
  saving,
  testing,
  formError,
  onChange,
  onPick,
  onTest,
  onSave,
  onCancel,
}: SourceFormProps) {
  const [values, setValues] = useState<SourceFormValues>({ root: '', name: '' });
  const [testResult, setTestResult] = useState<{ ok: boolean; error?: string } | null>(null);

  const update = (patch: Partial<SourceFormValues>): void => {
    const next = { ...values, ...patch };
    setValues(next);
    onChange(next);
  };

  const handlePick = async (): Promise<void> => {
    const picked = await onPick();
    if (picked) update({ root: picked });
  };

  const handleTest = async (): Promise<void> => {
    const result = await onTest(values);
    setTestResult(result ?? { ok: false, error: '测试失败' });
  };

  const handleSave = async (): Promise<void> => {
    const saved = await onSave(values);
    if (saved) {
      setValues({ root: '', name: '' });
      setTestResult(null);
    }
  };

  return (
    <div className="mb-4 p-4 bg-card border border-border rounded-xl space-y-3" data-testid="source-form">
      {formError && (
        <p role="alert" className="text-sm text-destructive">
          {formError}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={handlePick}
          className="flex items-center gap-1.5 px-3 py-2 text-sm border border-border rounded-lg hover:bg-accent transition-colors focus-ring"
        >
          <FolderOpen size={15} />
          {values.root ? '重新选择目录' : '选择目录'}
        </button>
        <span
          className="text-sm text-muted-foreground truncate max-w-full"
          title={values.root}
          aria-live="polite"
        >
          {values.root || '尚未选择目录'}
        </span>
      </div>
      <label className="block text-sm">
        <span className="text-muted-foreground">名称（可选）</span>
        <input
          type="text"
          value={values.name}
          onChange={(e) => update({ name: e.target.value })}
          placeholder="例如：电影收藏"
          className="mt-1 w-full px-3 py-2 bg-secondary border border-border rounded-lg text-sm focus-ring"
        />
      </label>
      {testResult && (
        <p role="status" className={`text-xs ${testResult.ok ? 'text-emerald-500' : 'text-destructive'}`}>
          {testResult.ok ? '目录可用 ✓' : `不可用：${testResult.error ?? '未知错误'}`}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={handleTest}
          disabled={!values.root || testing}
          className="flex items-center gap-1.5 px-3 py-2 text-sm border border-border rounded-lg hover:bg-accent transition-colors focus-ring disabled:opacity-50"
        >
          {testing ? <Loader2 size={15} className="animate-spin" /> : <PlugZap size={15} />}
          测试连接
        </button>
        <button
          type="button"
          onClick={handleSave}
          disabled={!values.root || saving}
          className="px-4 py-2 text-sm bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 transition-colors focus-ring disabled:opacity-50"
        >
          {saving ? <Loader2 size={15} className="animate-spin" /> : '添加来源'}
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="px-3 py-2 text-sm text-muted-foreground hover:text-foreground focus-ring"
        >
          取消
        </button>
      </div>
      <p className="text-[11px] text-muted-foreground">
        仅会读取该目录下的媒体文件用于建立索引；不会修改或删除任何文件。
      </p>
    </div>
  );
}
