interface ToggleProps {
  on: boolean;
  onChange: (value: boolean) => void;
  ariaLabel?: string;
  ariaLabelledBy?: string;
}

export default function Toggle({ on, onChange, ariaLabel, ariaLabelledBy }: ToggleProps) {
  return (
    <button
      className={`toggle${on ? " on" : ""}`}
      onClick={() => onChange(!on)}
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={ariaLabel}
      aria-labelledby={ariaLabelledBy}
    />
  );
}
