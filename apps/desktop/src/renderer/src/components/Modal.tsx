import { useEffect, useId } from 'react';
import type { ReactNode } from 'react';
import { Icon } from './Icon';

export interface ModalProps {
  title: string;
  subtitle?: string;
  children: ReactNode;
  footer?: ReactNode;
  onClose?: () => void;
  closable?: boolean;
  size?: 'sm' | 'md' | 'lg';
  /** E2E 用的 data-testid（可选）。 */
  testId?: string;
  /** 步骤条等放在标题下方的自定义内容。 */
  headerExtra?: ReactNode;
}

/** 深色风格模态框；Escape 关闭，点击遮罩不关闭（避免误操作丢失输入）。 */
export function Modal({
  title,
  subtitle,
  children,
  footer,
  onClose,
  closable = true,
  size = 'md',
  testId,
  headerExtra,
}: ModalProps) {
  const titleId = useId();

  useEffect(() => {
    if (!closable || !onClose) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [closable, onClose]);

  return (
    <div className="modal-overlay">
      <div
        className={`modal modal-${size}`}
        data-testid={testId}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
      >
        <header className="modal-header">
          <div className="modal-heading">
            <h2 id={titleId}>{title}</h2>
            {subtitle ? <p className="modal-subtitle">{subtitle}</p> : null}
          </div>
          {closable && onClose ? (
            <button type="button" className="icon-btn" aria-label="关闭" onClick={onClose}>
              <Icon name="close" size={18} />
            </button>
          ) : null}
        </header>
        {headerExtra ? <div className="modal-header-extra">{headerExtra}</div> : null}
        <div className="modal-body">{children}</div>
        {footer ? <footer className="modal-footer">{footer}</footer> : null}
      </div>
    </div>
  );
}

export interface ConfirmDialogProps {
  title: string;
  message: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  busy?: boolean;
  /** 确认按钮的 data-testid，默认 confirm-ok；特殊场景（如卸载）可传入专属 testid。 */
  confirmTestId?: string;
  onConfirm: () => void;
  onCancel: () => void;
}

/** 危险操作二次确认。 */
export function ConfirmDialog({
  title,
  message,
  confirmLabel = '确认',
  cancelLabel = '取消',
  danger = false,
  busy = false,
  confirmTestId = 'confirm-ok',
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  return (
    <Modal
      title={title}
      size="sm"
      closable={!busy}
      onClose={onCancel}
      footer={
        <>
          <button type="button" className="btn btn-ghost" onClick={onCancel} disabled={busy}>
            {cancelLabel}
          </button>
          <button
            type="button"
            className={danger ? 'btn btn-danger' : 'btn btn-primary'}
            data-testid={confirmTestId}
            onClick={onConfirm}
            disabled={busy}
          >
            {busy ? (
              '处理中…'
            ) : confirmTestId !== 'confirm-ok' ? (
              // 同时提供通用 confirm-ok：点击内层 span 会冒泡到按钮触发确认。
              <span data-testid="confirm-ok">{confirmLabel}</span>
            ) : (
              confirmLabel
            )}
          </button>
        </>
      }
    >
      <div className="confirm-message">{message}</div>
    </Modal>
  );
}
