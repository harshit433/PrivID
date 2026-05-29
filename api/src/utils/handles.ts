/** Build handle candidates from a display name (lowercase, underscores, 3–30 chars). */
export function buildHandleCandidates(name: string): string[] {
  const words = name
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .trim()
    .split(/\s+/)
    .filter((w) => w.length > 0);

  if (words.length === 0) return [];

  const first = words[0];
  const last = words.length > 1 ? words[words.length - 1] : '';
  const full = words.join('_').slice(0, 24);
  const rand = () => String(Math.floor(1000 + Math.random() * 9000));

  const raw = [
    full,
    last ? `${first}_${last}` : first,
    `${first}_${rand()}`,
    last ? `${first}${last[0]}_${rand()}` : `${first}_${rand()}`,
    `${first}${last}`.slice(0, 24),
    `${first}_${last.slice(0, 4)}_${rand()}`.replace(/_+/g, '_'),
  ];

  return [
    ...new Set(
      raw
        .map((h) =>
          h
            .replace(/[^a-z0-9_]/g, '')
            .replace(/_+/g, '_')
            .replace(/^_|_$/g, '')
        )
        .filter((h) => h.length >= 3 && h.length <= 30)
    ),
  ];
}
