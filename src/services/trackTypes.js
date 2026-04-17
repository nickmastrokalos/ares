export const TRACK_TYPE_CATALOG = [
  {
    key: 'ground',
    label: 'Ground',
    types: [
      { label: 'Generic',   suffix: 'G' },
      { label: 'Infantry',  suffix: 'G-U-C-I' },
      { label: 'Armor',     suffix: 'G-U-C-A' },
      { label: 'Artillery', suffix: 'G-U-C-F' },
      { label: 'Engineer',  suffix: 'G-U-C-E' },
      { label: 'Recon',     suffix: 'G-U-C-R' },
      { label: 'HQ',        suffix: 'G-U-H' },
      { label: 'Support',   suffix: 'G-U-S' },
      { label: 'Unmanned',  suffix: 'G-U-C-V-U' },
    ]
  },
  {
    key: 'air',
    label: 'Air',
    types: [
      { label: 'Generic',    suffix: 'A' },
      { label: 'Fixed Wing', suffix: 'A-M-F' },
      { label: 'UAV',        suffix: 'A-M-F-Q' },
      { label: 'Helicopter', suffix: 'A-M-H' },
      { label: 'Atk Helo',  suffix: 'A-M-H-H' },
    ]
  },
  {
    key: 'sea',
    label: 'Sea',
    types: [
      { label: 'Surface',   suffix: 'S' },
      { label: 'Combatant', suffix: 'S-C' },
      { label: 'Unmanned',  suffix: 'S-C-U' },
      { label: 'Sub',       suffix: 'U' },
    ]
  },
  {
    key: 'sof',
    label: 'SOF',
    types: [
      { label: 'Generic',   suffix: 'F' },
    ]
  },
]

/**
 * Get the display label for a full cotType string (e.g. "a-f-G-U-C-I" → "Infantry").
 * Returns null if not found in the catalog.
 */
export function labelFromCotType(cotType) {
  if (!cotType) return null
  const parts = cotType.split('-')
  if (parts.length < 3 || parts[0] !== 'a') return null
  const suffix = parts.slice(2).join('-')
  for (const cat of TRACK_TYPE_CATALOG) {
    const found = cat.types.find(t => t.suffix === suffix)
    if (found) return found.label
  }
  return null
}
