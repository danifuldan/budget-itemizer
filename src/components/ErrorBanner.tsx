interface ErrorBannerProps {
  title: string;
  description: string;
  onRetry?: () => void;
  onSettings?: () => void;
}

export default function ErrorBanner({ title, description, onRetry, onSettings }: ErrorBannerProps) {
  return (
    <div className="error-banner" role="alert">
      <svg className="error-banner-icon" viewBox="0 0 20 20" fill="none" aria-hidden="true">
        <circle cx="10" cy="10" r="8.5" stroke="currentColor" strokeWidth="1.5" />
        <line x1="10" y1="6" x2="10" y2="11" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        <circle cx="10" cy="14" r="1" fill="currentColor" />
      </svg>
      <div className="error-banner-content">
        <div className="error-banner-title">{title}</div>
        <div className="error-banner-desc">{description}</div>
        {(onRetry || onSettings) && (
          <div className="error-banner-actions">
            {onRetry && (
              <button className="btn btn-sm btn-primary" onClick={onRetry}>Retry</button>
            )}
            {onSettings && (
              <button className="btn btn-sm btn-secondary" onClick={onSettings}>Settings</button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
