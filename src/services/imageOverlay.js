import { open } from '@tauri-apps/plugin-dialog'
import { readFile } from '@tauri-apps/plugin-fs'

const MIME_TYPES = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp'
}

// Opens a file picker filtered to supported image types, reads the selected
// file, and returns { src, naturalWidth, naturalHeight } where `src` is a
// base64 data URL. Returns null if the user cancels the dialog.
export async function pickAndReadImage() {
  const filePath = await open({
    multiple: false,
    filters: [{ name: 'Images', extensions: Object.keys(MIME_TYPES) }]
  })
  if (!filePath) return null

  const ext = String(filePath).split('.').pop().toLowerCase()
  const mimeType = MIME_TYPES[ext] ?? 'image/png'

  const bytes = await readFile(filePath)

  // Build base64 in chunks to avoid call-stack overflow on large files.
  let binary = ''
  const chunk = 8192
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk))
  }
  const src = `data:${mimeType};base64,${btoa(binary)}`

  const { naturalWidth, naturalHeight } = await new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve({ naturalWidth: img.naturalWidth, naturalHeight: img.naturalHeight })
    img.onerror = () => reject(new Error('Failed to decode image'))
    img.src = src
  })

  return { src, naturalWidth, naturalHeight }
}
