import { Component, type ErrorInfo, type ReactNode } from 'react';
import { AlertTriangle, RefreshCw, RotateCcw, X } from 'lucide-react';

const reported = new Map<string, number>();
let reports = 0;
/** Send a render failure to the main process log; repeats of the same error are dropped for a minute. */
export function reportRenderError(area: string, error: unknown, componentStack?: string | null) {
  const message = error instanceof Error ? error.message : String(error);
  const key = `${area}\n${message}`, at = Date.now();
  if ((reported.get(key) ?? 0) > at - 60000 || reports >= 50) return;
  reported.set(key, at); reports++;
  console.error(`[AIROOM] ${area} 出错`, error);
  try {
    void window.airoom?.invoke('renderer.error', { area, message, stack: error instanceof Error ? error.stack : undefined, componentStack: componentStack ?? undefined }).catch(() => {});
  } catch { /* The bridge may be gone while the window closes. */ }
}

interface Props {
  /** Shown to the user, e.g. "对话区". */
  area: string;
  /** A change (another session, another tab) clears the error and renders again. */
  resetKey?: unknown;
  /** One line inside a list instead of a card. */
  compact?: boolean;
  /** The whole window failed: offer reloading. */
  fullPage?: boolean;
  /** For dialogs: let the user close what failed. */
  onDismiss?: () => void;
  children: ReactNode;
}

/** Keeps one broken part of the interface from blanking the whole window. */
export class ErrorBoundary extends Component<Props, { error?: Error }> {
  state: { error?: Error } = {};
  static getDerivedStateFromError(error: Error) { return { error }; }
  componentDidCatch(error: Error, info: ErrorInfo) { reportRenderError(this.props.area, error, info.componentStack); }
  componentDidUpdate(previous: Props) { if (this.state.error && previous.resetKey !== this.props.resetKey) this.setState({ error: undefined }); }
  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    const { area, compact, fullPage, onDismiss } = this.props;
    const retry = () => this.setState({ error: undefined });
    if (compact) return <div className="error-fallback compact" role="alert">
      <AlertTriangle size={14} /><span>{area}没能显示：{error.message}</span>
      <button type="button" className="link-button" onClick={retry}>重试</button>
    </div>;
    const card = <div className={`error-fallback ${fullPage ? 'full-page' : ''}`} role="alert">
      <AlertTriangle size={22} />
      <div>
        <strong>{area}出了点问题</strong>
        <p>{fullPage ? '界面遇到了意外错误。后台任务不受影响，重新加载窗口即可恢复。' : '其他部分照常可用，后台任务也不受影响。错误已记入诊断记录。'}</p>
        <details><summary>错误信息</summary><pre>{error.message}</pre></details>
        <div className="error-fallback-actions">
          {!fullPage && <button type="button" className="button small secondary" onClick={retry}><RotateCcw size={13} />重试</button>}
          {onDismiss && <button type="button" className="button small quiet" onClick={() => { retry(); onDismiss(); }}><X size={13} />关闭</button>}
          <button type="button" className={`button small ${fullPage ? 'primary' : 'quiet'}`} onClick={() => window.location.reload()}><RefreshCw size={13} />重新加载窗口</button>
        </div>
      </div>
    </div>;
    // A failed dialog keeps its overlay so the user can still close it.
    return onDismiss ? <div className="modal-overlay" onMouseDown={event => { if (event.target === event.currentTarget) { retry(); onDismiss(); } }}>{card}</div> : card;
  }
}
