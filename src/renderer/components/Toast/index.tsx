import { X, CheckCircle, AlertCircle, Info, AlertTriangle } from 'lucide-react';
import { useToastStore } from '../../stores/toast-store';

const typeStyles = {
  info: 'bg-blue-500/90 border-blue-400/30',
  success: 'bg-emerald-500/90 border-emerald-400/30',
  warning: 'bg-amber-500/90 border-amber-400/30',
  error: 'bg-red-500/90 border-red-400/30',
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
    <div className="fixed top-4 right-4 z-[100] flex flex-col gap-2 max-w-sm">
      {toasts.map((toast) => {
        const Icon = typeIcons[toast.type];
        return (
          <div
            key={toast.id}
            role="alert"
            className={`${typeStyles[toast.type]} text-white px-4 py-3 rounded-lg shadow-lg border flex items-start gap-3 animate-in slide-in-from-right fade-in duration-200`}
          >
            <Icon size={18} className="flex-shrink-0 mt-0.5" />
            <p className="text-sm leading-snug flex-1">{toast.message}</p>
            <button
              onClick={() => removeToast(toast.id)}
              className="flex-shrink-0 p-0.5 hover:bg-white/20 rounded transition-colors"
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
