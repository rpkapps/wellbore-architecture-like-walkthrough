/** The BoreWalk mark: a well path turning horizontal under a rig. */
export function Logo({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" fill="none" aria-hidden className={className}>
      <path d="M16 3v11c0 5.5 6.5 7.5 11 7.5" stroke="var(--ui-accent)" strokeWidth="2.6" strokeLinecap="round" />
      <circle cx="16" cy="3.8" r="2.3" fill="var(--tecton-palette-saffron-560)" />
      <path d="M5 26h22" stroke="currentColor" strokeOpacity=".3" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}
