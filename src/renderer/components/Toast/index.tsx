import { X, CheckCircle, AlertCircle, Info, AlertTriangle } from 'lucide-react';
import { useToastStore } from '../../stores/toast-store';

const typeStyles = {
  info: 'text-sky-400',
  success: 'text-emerald-400',
  warning: 'text-amber-400',
  error: 'text-rose-400',
};

const typeIcons = {
  info: Info,
  success: CheckCircle,
  warning: AlertTriangle,
  error: AlertCircle,
};

export default function ToastContainer() {
  const { toasts, removeToast } = useToastStore();

  if (toasts.length === 0) return null;

  return (
    // 让开自绘标题栏（QYP3-042）
    <div className="fixed top-12 right-4 z-[100] flex flex-col gap-2 max-w-sm">
      {toasts.map((toast) => {
        const Icon = typeIcons[toast.type];
        return (
          <div
            key={toast.id}
            role="alert"
            className="bg-card/95 border border-border text-foreground px-4 py-3 rounded-xl shadow-xl backdrop-blur-md flex items-start gap-3 animate-in slide-in-from-right fade-in duration-200"
          >
            <Icon size={18} className={`flex-shrink-0 mt-0.5 ${typeStyles[toast.type]}`} />
            <p className="text-sm leading-snug flex-1 font-medium">{toast.message}</p>
            <button
              onClick={() => removeToast(toast.id)}
              className="flex-shrink-0 p-0.5 text-muted-foreground hover:text-foreground hover:bg-secondary rounded-lg transition-colors focus-ring"
              aria-label="关闭通知"
            >
              <X size={14} />
            </button>
          </div>
        );
      })}
    </div>
  );
}
