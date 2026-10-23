import type { ReactNode } from 'react';

export function Panel({
  title,
  actions,
  children,
  className = '',
}: {
  title?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={`panel ${className}`}>
      {(title || actions) && (
        <header className="panel-h">
          <span>{title}</span>
          <span className="panel-actions">{actions}</span>
        </header>
      )}
      <div className="panel-b">{children}</div>
    </section>
  );
}

export function Stat({ label, value, hint, tone }: { label: string; value: ReactNode; hint?: ReactNode; tone?: 'ok' | 'warn' | 'bad' }) {
  return (
    <div className={`stat ${tone ?? ''}`}>
      <div className="stat-l">{label}</div>
      <div className="stat-v">{value}</div>
      {hint && <div className="stat-h">{hint}</div>}
    </div>
  );
}

export function Badge({ children, tone = 'idle' }: { children: ReactNode; tone?: 'ok' | 'warn' | 'bad' | 'idle' | 'blue' }) {
  return <span className={`badge ${tone}`}>{children}</span>;
}

export function Button({
  children,
  onClick,
  variant = 'default',
  disabled,
  type = 'button',
  title,
}: {
  children: ReactNode;
  onClick?: () => void;
  variant?: 'default' | 'primary' | 'danger' | 'ghost';
  disabled?: boolean;
  type?: 'button' | 'submit';
  title?: string;
}) {
  return (
    <button className={`btn ${variant}`} onClick={onClick} disabled={disabled} type={type} title={title}>
      {children}
    </button>
  );
}

export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: ReactNode }) {
  return (
    <label className="field">
      <span className="field-l">{label}</span>
      {children}
      {hint && <span className="field-h">{hint}</span>}
    </label>
  );
}

export const statusTone = (status: string): 'ok' | 'warn' | 'bad' | 'idle' | 'blue' => {
  if (status === 'running' || status === 'active' || status === 'installed') return 'ok';
  if (status === 'starting' || status === 'installing') return 'warn';
  if (status === 'error') return 'bad';
  return 'idle';
};

export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>;
}

export function CopyLine({ value, label }: { value: string; label: string }) {
  return (
    <div className="copyline">
      <span className="copyline-l">{label}</span>
      <code>{value}</code>
      <Button variant="ghost" onClick={() => navigator.clipboard?.writeText(value)}>
        copy
      </Button>
    </div>
  );
}
