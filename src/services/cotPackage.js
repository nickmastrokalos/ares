import JSZip from 'jszip'
import { save } from '@tauri-apps/plugin-dialog'
import { writeFile } from '@tauri-apps/plugin-fs'
import { featureToCoTDoc } from '@/services/cot'
import { esc } from '@/services/xml'

// ── CoT ZIP (flat archive, one .cot per feature) ──────────────────────────────

// Creates a ZIP archive containing one CoT XML document per feature.
// File naming: "{uid}.cot" at the archive root.
export async function exportCotZip(fcFeatures, missionName) {
  const zip   = new JSZip()
  let   count = 0

  for (const feature of fcFeatures) {
    const xml = featureToCoTDoc(feature)
    if (!xml) continue
    const uid = `ares-${feature.properties._dbId}`
    zip.file(`${uid}.cot`, xml)
    count++
  }

  if (!count) throw new Error('No exportable features — all selected items are unsupported types.')

  const filePath = await save({
    defaultPath: `${missionName}-cot.zip`,
    filters: [{ name: 'ZIP', extensions: ['zip'] }]
  })
  if (!filePath) return

  const bytes = await zip.generateAsync({ type: 'uint8array' })
  await writeFile(filePath, bytes)
}

// ── TAK Data Package (ATAK/WinTAK-compatible) ─────────────────────────────────

// Creates a TAK Data Package ZIP with the standard structure:
//
//   MANIFEST/manifest.xml
//   {uid1}/{uid1}.cot
//   {uid2}/{uid2}.cot
//   …
//
// The manifest follows MissionPackageManifest version="2" as expected by
// ATAK and WinTAK. The directory and filename for each .cot file match the
// CoT event uid (e.g. ares-{dbId}).
export async function exportTakDataPackage(fcFeatures, missionName) {
  const zip        = new JSZip()
  const packageUid = crypto.randomUUID()
  const contents   = []

  for (const feature of fcFeatures) {
    const xml = featureToCoTDoc(feature)
    if (!xml) continue

    const uid      = `ares-${feature.properties._dbId}`
    const zipEntry = `${uid}/${uid}.cot`

    zip.file(zipEntry, xml)
    contents.push({ zipEntry, uid })
  }

  if (!contents.length) throw new Error('No exportable features — all selected items are unsupported types.')

  zip.file('MANIFEST/manifest.xml', buildManifest(packageUid, missionName, contents))

  const filePath = await save({
    defaultPath: `${missionName}-tak.zip`,
    filters: [{ name: 'TAK Data Package', extensions: ['zip'] }]
  })
  if (!filePath) return

  const bytes = await zip.generateAsync({ type: 'uint8array' })
  await writeFile(filePath, bytes)
}

// ── Manifest builder ──────────────────────────────────────────────────────────

function buildManifest(packageUid, packageName, contents) {
  const items = contents.map(c =>
    `    <Content ignore="false" zipEntry="${esc(c.zipEntry)}">\n` +
    `      <Parameter name="uid" value="${esc(c.uid)}" />\n` +
    `    </Content>`
  ).join('\n')

  return [
    '<MissionPackageManifest version="2">',
    '  <Configuration>',
    `    <Parameter name="name" value="${esc(packageName)}" />`,
    `    <Parameter name="uid" value="${packageUid}" />`,
    '  </Configuration>',
    '  <Contents>',
    items,
    '  </Contents>',
    '</MissionPackageManifest>'
  ].join('\n')
}
