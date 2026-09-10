import { Lock, Unlock, AlertTriangle } from 'lucide-react';

/**
 * WebDAV form fields (plan §8.1/8.2).
 *
 * Secrets live only in component state until saved: the password input
 * never echoes a stored value (there is no stored value — only the
 * hasCredential flag comes back from main), and autocomplete is disabled.
 * http:// requires an explicit plaintext-transport consent checkbox; the
 * main process re-validates it, this UI is the first gate.
 */
export interface WebDavFieldValues {
  url: string;
  username: string;
  password: string;
  /** Explicit consent for plaintext http transport (plan §8.1). */
  confirmPlaintext: boolean;
}

interface WebDavFieldsProps {
  values: WebDavFieldValues;
  onChange: (values: WebDavFieldValues) => void;
  /** True when the SecretStore survives restarts (main-provided). */
  persistentSecrets: boolean;
}

/** Shared by the form warning and the source list badge (plan §8.1). */
export function urlLooksPlaintextHttp(url: string): boolean {
  return /^http:\/\//i.test(url.trim());
}

/** Cheap renderer-side sanity hints; the strict validation is main-side. */
export function validateWebDavUrlHint(url: string): string | null {
  const trimmed = url.trim();
  if (!trimmed) return null;
  if (/[?#]/.test(trimmed)) return '地址不能包含查询串或片段';
  if (trimmed.includes('@') && /\/\/[^/]*@/.test(trimmed)) return '地址不能包含用户名密码（userinfo）';
  return null;
}

export default function WebDavFields({
  values,
  onChange,
  persistentSecrets,
}: WebDavFieldsProps) {
  const hint = validateWebDavUrlHint(values.url);
  const isHttp = urlLooksPlaintextHttp(values.url);
  return (
    <div className="space-y-3">
      <label className="block text-sm">
        <span className="text-muted-foreground">服务器地址</span>
        <input
          type="url"
          value={values.url}
          onChange={(e) => onChange({ ...values, url: e.target.value })}
          placeholder="https://example.com:5005/dav"
          autoComplete="off"
          spellCheck={false}
          required
          className="mt-1 w-full px-3 py-2 bg-secondary border border-border rounded-lg text-sm focus-ring font-mono"
        />
      </label>
      {hint && (
        <p role="alert" className="text-xs text-destructive">
          {hint}
        </p>
      )}
      {isHttp && (
        <div className="flex items-start gap-2 p-2.5 bg-amber-500/10 border border-amber-500/30 rounded-lg" role="alert">
          <AlertTriangle size={14} className="text-amber-500 flex-shrink-0 mt-0.5" />
          <div className="min-w-0">
            <p className="text-xs text-amber-500">该地址使用 http 明文传输，密码可能被网络中间人截获。</p>
            <label className="flex items-center gap-1.5 mt-1 text-xs text-foreground cursor-pointer">
              <input
                type="checkbox"
                checked={values.confirmPlaintext}
                onChange={(e) => onChange({ ...values, confirmPlaintext: e.target.checked })}
                className="accent-current"
              />
              我了解风险，仍要使用 http 明文连接
            </label>
          </div>
        </div>
      )}
      <div className="flex flex-wrap gap-3">
        <label className="block text-sm flex-1 min-w-[160px]">
          <span className="text-muted-foreground">用户名（无认证可留空）</span>
          <input
            type="text"
            value={values.username}
            onChange={(e) => onChange({ ...values, username: e.target.value })}
            autoComplete="off"
            spellCheck={false}
            className="mt-1 w-full px-3 py-2 bg-secondary border border-border rounded-lg text-sm focus-ring"
          />
        </label>
        <label className="block text-sm flex-1 min-w-[160px]">
          <span className="text-muted-foreground">密码 / 应用密码</span>
          <input
            type="password"
            value={values.password}
            onChange={(e) => onChange({ ...values, password: e.target.value })}
            autoComplete="new-password"
            spellCheck={false}
            className="mt-1 w-full px-3 py-2 bg-secondary border border-border rounded-lg text-sm focus-ring"
          />
        </label>
      </div>
      <p className="text-[11px] text-muted-foreground flex items-center gap-1.5">
        {persistentSecrets ? (
          <>
            <Lock size={11} />
            密码将通过系统加密存储，重启后仍可用。
          </>
        ) : (
          <>
            <Unlock size={11} />
            系统加密存储不可用：密码仅保存在本次会话，重启后需要重新输入。
          </>
        )}
      </p>
    </div>
  );
}
