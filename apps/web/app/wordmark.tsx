const lockups = {
  ink: "/brand/corotum-lockup.svg",
  light: "/brand/corotum-lockup-light.svg",
} as const;

export function Wordmark({
  href,
  variant = "ink",
  label,
}: {
  href: string;
  variant?: keyof typeof lockups;
  label?: string;
}) {
  return (
    <a className="wordmark" href={href} aria-label={label}>
      {/* biome-ignore lint/performance/noImgElement: Brand lockup is a static public SVG. */}
      <img alt="Corotum" height={600} src={lockups[variant]} width={3120} />
    </a>
  );
}
