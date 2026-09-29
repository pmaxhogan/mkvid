import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { GlobalFonts } from '@napi-rs/canvas'

/**
 * Fonts are bundled under assets/fonts and registered by path: the production
 * container has no fontconfig, so nothing may depend on system fonts.
 * Inter covers Latin, Greek and Cyrillic; the Noto files cover the scripts
 * DJ track lists most often contain beyond that.
 */
const FILES = [
  'inter/Inter-Regular.ttf',
  'inter/Inter-Medium.ttf',
  'inter/Inter-SemiBold.ttf',
  'inter/InterDisplay-Bold.ttf',
  'noto/NotoSansJP-Medium.otf',
  'noto/NotoSansJP-Bold.otf',
  'noto/NotoSansKR-Medium.otf',
  'noto/NotoSansKR-Bold.otf',
  'noto/NotoSansArabic-Regular.ttf',
  'noto/NotoSansArabic-Bold.ttf',
  'noto/NotoSansHebrew-Regular.ttf',
  'noto/NotoSansHebrew-Bold.ttf',
  'noto/NotoSansThai-Regular.ttf',
  'noto/NotoSansThai-Bold.ttf',
  'noto/NotoSansDevanagari-Regular.ttf',
  'noto/NotoSansDevanagari-Bold.ttf',
]

const FALLBACKS = '"Noto Sans JP", "Noto Sans KR", "Noto Sans Arabic", "Noto Sans Hebrew", "Noto Sans Thai", "Noto Sans Devanagari"'

/** Font shorthand for the display face (titles). */
export function displayFont(px: number): string {
  return `700 ${px.toFixed(1)}px "Inter Display", ${FALLBACKS}`
}

/** Font shorthand for the text face at a given weight (400, 500 or 600). */
export function textFont(weight: 400 | 500 | 600, px: number): string {
  return `${weight} ${px.toFixed(1)}px Inter, ${FALLBACKS}`
}

export function fontsDir(): string {
  const fromEnv = process.env.MKVID_FONTS_DIR
  if (fromEnv) return fromEnv
  // Same relative position from src/viz/scene (tsx) and dist/viz/scene (built).
  return fileURLToPath(new URL('../../../assets/fonts/', import.meta.url))
}

let registered = false

/** Registers the bundled fonts once per thread. Throws if Inter is missing. */
export function registerFonts(): void {
  if (registered) return
  const dir = fontsDir()
  for (const rel of FILES) {
    const file = path.join(dir, rel)
    if (!existsSync(file)) {
      if (rel.startsWith('inter/')) throw new Error(`visualizer font missing: ${file}`)
      continue
    }
    GlobalFonts.registerFromPath(file)
  }
  registered = true
}
