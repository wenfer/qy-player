import { useState } from 'react';
import { Check, X, Loader2, AlertCircle, Eye, EyeOff } from 'lucide-react';

export interface ServerForm {
  type: 'jellyfin' | 'emby';
  name: string;
  baseUrl: string;
  username: string;
  password: string;
}

interface ServerFormProps {
  form: ServerForm;
  onChange: (form: ServerForm) => void;
  onTest: () => void;
  onSave: () => void;
  onCancel: () => void;
  testing: boolean;
  saving: boolean;
  formError: string | null;
  isEditing: boolean;
}

export default function ServerForm({
  form,
  onChange,
  onTest,
  onSave,
  onCancel,
  testing,
  saving,
  formError,
  isEditing,
}: ServerFormProps) {
  const inputClass =
    'w-full px-3 py-2 bg-background border border-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-ring focus:border-transparent';
  const [showPassword, setShowPassword] = useState(false);

  return (
    <div className="bg-card border border-border rounded-xl p-5 mb-5 space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium">{isEditing ? '编辑服务器' : '添加服务器'}</h3>
        {isEditing && (
          <span className="text-xs text-muted-foreground">留空密码则保留原有登录凭证</span>
        )}
      </div>

      {formError && (
        <div className="flex items-center gap-2 p-3 bg-destructive/10 text-destructive rounded-lg text-sm" role="alert">
          <AlertCircle size={16} />
          {formError}
        </div>
      )}

      <div className="grid grid-cols-2 gap-4">
        <div>
          <label htmlFor="server-type" className="block text-xs font-medium text-muted-foreground mb-1.5">
            类型
          </label>
          <select
            id="server-type"
            value={form.type}
            onChange={(e) => onChange({ ...form, type: e.target.value as 'jellyfin' | 'emby' })}
            className={inputClass}
          >
            <option value="jellyfin">Jellyfin</option>
            <option value="emby">Emby</option>
          </select>
        </div>
        <div>
          <label htmlFor="server-name" className="block text-xs font-medium text-muted-foreground mb-1.5">
            名称
          </label>
          <input
            id="server-name"
            type="text"
            value={form.name}
            onChange={(e) => onChange({ ...form, name: e.target.value })}
            placeholder="我的服务器"
            className={inputClass}
          />
        </div>
      </div>

      <div>
        <label htmlFor="server-url" className="block text-xs font-medium text-muted-foreground mb-1.5">
          服务器地址
        </label>
        <input
          id="server-url"
          type="url"
          value={form.baseUrl}
          onChange={(e) => onChange({ ...form, baseUrl: e.target.value })}
          placeholder="http://192.168.1.100:8096"
          className={inputClass}
        />
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div>
          <label htmlFor="server-username" className="block text-xs font-medium text-muted-foreground mb-1.5">
            用户名
          </label>
          <input
            id="server-username"
            type="text"
            value={form.username}
            onChange={(e) => onChange({ ...form, username: e.target.value })}
            autoComplete="off"
            className={inputClass}
          />
        </div>
        <div>
          <label htmlFor="server-password" className="block text-xs font-medium text-muted-foreground mb-1.5">
            密码
          </label>
          <div className="relative">
            <input
              id="server-password"
              type={showPassword ? 'text' : 'password'}
              value={form.password}
              onChange={(e) => onChange({ ...form, password: e.target.value })}
              placeholder={isEditing ? '••••••••' : ''}
              autoComplete="new-password"
              className={`${inputClass} pr-10`}
            />
            <button
              type="button"
              onClick={() => setShowPassword((v) => !v)}
              className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-muted-foreground hover:text-foreground rounded transition-colors focus-ring"
              aria-label={showPassword ? '隐藏密码' : '显示密码'}
              aria-pressed={showPassword}
            >
              {showPassword ? <EyeOff size={15} /> : <Eye size={15} />}
            </button>
          </div>
        </div>
      </div>

      <div className="flex gap-2 justify-end pt-1">
        <button
          onClick={onTest}
          disabled={testing}
          className="flex items-center gap-1.5 px-4 py-2 border border-border rounded-lg hover:bg-accent transition-colors disabled:opacity-50 text-sm focus-ring"
        >
          {testing ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />}
          测试连接
        </button>
        <button
          onClick={onCancel}
          className="flex items-center gap-1.5 px-4 py-2 border border-border rounded-lg hover:bg-accent transition-colors text-sm focus-ring"
        >
          <X size={14} />
          取消
        </button>
        <button
          onClick={onSave}
          disabled={saving}
          className="flex items-center gap-1.5 px-4 py-2 bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 transition-colors text-sm font-medium focus-ring disabled:opacity-50"
        >
          {saving ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />}
          {isEditing ? '保存修改' : '保存'}
        </button>
      </div>
    </div>
  );
}
