interface SkeletonRowProps {
  nameWidth?: string;
}

export default function SkeletonRow({ nameWidth }: SkeletonRowProps) {
  return (
    <div className="skeleton-row">
      <div className="skel-bar skel-name" style={nameWidth ? { width: nameWidth } : undefined} />
      <div className="skel-bar skel-amount" />
    </div>
  );
}
