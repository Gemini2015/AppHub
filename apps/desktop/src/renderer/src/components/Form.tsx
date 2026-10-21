import { useId } from 'react';
import type { ReactNode } from 'react';
import type { IconName } from './Icon';
import { Icon } from './Icon';
import type { ApiError } from '../types';

// ---------------------------------------------------------------------------
// 表单字段
// ---------------------------------------------------------------------------

interface BaseFieldProps {
  label: string;
  error?: string;
  hint?: string;
  required?: boolean;
  disabled?: boolean;
  /** 覆盖自动生成的 input id（一般不需要）。 */
  id?: string;
  /** E2E 用的 data-testid（可选）。 */
  testId?: string;
}

function fieldIds(id: string, hint?: string, error?: string): string | undefined {
  const ids = [hint ? `${id}-hint` : null, error ? `${id}-error` : null].filter(Boolean);
  return ids.length > 0 ? ids.join(' ') : undefined;
}

export interface TextFieldProps extends BaseFieldProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  type?: 'text' | 'password' | 'url' | 'number' | 'search';
  autoComplete?: string;
  maxLength?: number;
  mono?: boolean;
}

export function TextField({
  label,
  value,
  onChange,
  placeholder,
  type = 'text',
  autoComplete,
  maxLength,
  error,
  hint,
  required,
  disabled,
  mono,
  id,
  testId,
}: TextFieldProps) {
  const autoId = useId();
  const inputId = id ?? autoId;
  return (
    <div className={error ? 'field field-invalid' : 'field'}>
      <label className="field-label" htmlFor={inputId}>
        {label}
        {required ? (
          <span className="field-req" aria-hidden="true">
            {' '}
            *
          </span>
        ) : null}
      </label>
      <input
        id={inputId}
        data-testid={testId}
        className={mono ? 'input mono' : 'input'}
        type={type}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        autoComplete={autoComplete}
        maxLength={maxLength}
        disabled={disabled}
        aria-invalid={error ? true : undefined}
        aria-describedby={fieldIds(inputId, hint, error)}
      />
      {hint ? (
        <p className="field-hint" id={`${inputId}-hint`}>
          {hint}
        </p>
      ) : null}
      {error ? (
        <p className="field-error" id={`${inputId}-error`} role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}

export interface TextAreaFieldProps extends BaseFieldProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  rows?: number;
  maxLength?: number;
}

export function TextAreaField({
  label,
  value,
  onChange,
  placeholder,
  rows = 3,
  maxLength,
  error,
  hint,
  required,
  disabled,
  id,
  testId,
}: TextAreaFieldProps) {
  const autoId = useId();
  const inputId = id ?? autoId;
  return (
    <div className={error ? 'field field-invalid' : 'field'}>
      <label className="field-label" htmlFor={inputId}>
        {label}
        {required ? (
          <span className="field-req" aria-hidden="true">
            {' '}
            *
          </span>
        ) : null}
      </label>
      <textarea
        id={inputId}
        data-testid={testId}
        className="input textarea"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        rows={rows}
        maxLength={maxLength}
        disabled={disabled}
        aria-invalid={error ? true : undefined}
        aria-describedby={fieldIds(inputId, hint, error)}
      />
      {hint ? (
        <p className="field-hint" id={`${inputId}-hint`}>
          {hint}
        </p>
      ) : null}
      {error ? (
        <p className="field-error" id={`${inputId}-error`} role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}

export interface SelectOption {
  value: string;
  label: string;
}

export interface SelectFieldProps extends BaseFieldProps {
  value: string;
  onChange: (value: string) => void;
  options: SelectOption[];
  placeholder?: string;
}

export function SelectField({
  label,
  value,
  onChange,
  options,
  placeholder,
  error,
  hint,
  required,
  disabled,
  id,
  testId,
}: SelectFieldProps) {
  const autoId = useId();
  const inputId = id ?? autoId;
  return (
    <div className={error ? 'field field-invalid' : 'field'}>
      <label className="field-label" htmlFor={inputId}>
        {label}
        {required ? (
          <span className="field-req" aria-hidden="true">
            {' '}
            *
          </span>
        ) : null}
      </label>
      <select
        id={inputId}
        data-testid={testId}
        className="input select"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        disabled={disabled}
        aria-invalid={error ? true : undefined}
        aria-describedby={fieldIds(inputId, hint, error)}
      >
        {placeholder ? <option value="">{placeholder}</option> : null}
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
      {hint ? (
        <p className="field-hint" id={`${inputId}-hint`}>
          {hint}
        </p>
      ) : null}
      {error ? (
        <p className="field-error" id={`${inputId}-error`} role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}

export interface CheckboxFieldProps {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  hint?: string;
  error?: string;
  disabled?: boolean;
  id?: string;
}

export function CheckboxField({
  label,
  checked,
  onChange,
  hint,
  error,
  disabled,
  id,
}: CheckboxFieldProps) {
  const autoId = useId();
  const inputId = id ?? autoId;
  return (
    <div className={error ? 'field field-invalid' : 'field'}>
      <label className="checkbox" htmlFor={inputId}>
        <input
          id={inputId}
          type="checkbox"
          checked={checked}
          onChange={(event) => onChange(event.target.checked)}
          disabled={disabled}
          aria-invalid={error ? true : undefined}
        />
        <span>{label}</span>
      </label>
      {hint ? <p className="field-hint">{hint}</p> : null}
      {error ? (
        <p className="field-error" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// 通用提示条
// ---------------------------------------------------------------------------

export type BannerTone = 'error' | 'warn' | 'info' | 'success';

function bannerIcon(tone: BannerTone): IconName {
  switch (tone) {
    case 'error':
      return 'x-circle';
    case 'warn':
      return 'alert';
    case 'success':
      return 'check-circle';
    default:
      return 'info';
  }
}

export interface InfoBannerProps {
  tone?: BannerTone;
  title?: string;
  children?: ReactNode;
  icon?: IconName;
  className?: string;
}

export function InfoBanner({ tone = 'info', title, children, icon, className }: InfoBannerProps) {
  return (
    <div className={`banner banner-${tone}${className ? ` ${className}` : ''}`} role={tone === 'error' ? 'alert' : undefined}>
      <Icon name={icon ?? bannerIcon(tone)} size={18} />
      <div className="banner-body">
        {title ? <strong>{title}</strong> : null}
        {children ? <div className="banner-text">{children}</div> : null}
      </div>
    </div>
  );
}

/** 把 ApiError 渲染成带错误码的提示条。 */
export function ApiErrorBanner({ error, title }: { error: ApiError; title?: string }) {
  return (
    <div className="banner banner-error" role="alert">
      <Icon name="x-circle" size={18} />
      <div className="banner-body">
        <strong>{title ?? '操作失败'}</strong>
        <div className="banner-text">
          {error.message}
          <code className="error-code">{error.code}</code>
        </div>
      </div>
    </div>
  );
}

export function CodeBlock({ children, label }: { children: string; label?: string }) {
  return (
    <div className="code-block-wrap">
      {label ? <span className="code-block-label">{label}</span> : null}
      <pre className="code-block">{children}</pre>
    </div>
  );
}
