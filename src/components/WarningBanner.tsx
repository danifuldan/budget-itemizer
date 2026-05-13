interface WarningBannerProps {
  title: string;
  description: string;
}

export default function WarningBanner({ title, description }: WarningBannerProps) {
  return (
    <div className="warning-banner" role="status">
      <svg className="warning-banner-icon" width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <path d="M8 1.5L14.5 13.5H1.5L8 1.5Z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
        <line x1="8" y1="6.5" x2="8" y2="9.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        <circle cx="8" cy="11.5" r="0.75" fill="currentColor" />
      </svg>
      <div className="warning-banner-content">
        <div className="warning-banner-title">{title}</div>
        <div className="warning-banner-desc">{description}</div>
      </div>
    </div>
  );
}
