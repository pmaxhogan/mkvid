/**
 * Geometry of the frame. All sizes scale with height / 1080 so the small
 * frames used in tests go through the same code as 1080p.
 */
export interface Layout {
  w: number
  h: number
  /** One "design pixel" at 1080p. */
  u: number
  /** 'split': artwork left, track text right. 'centred': no track text. */
  mode: 'split' | 'centred'
  cx: number
  cy: number
  card: number
  ringR: number
  ringAmp: number
  margin: number
  text: { x: number; maxWidth: number; cy: number }
  header: { x: number; y: number; maxWidth: number }
  footer: { x0: number; x1: number; barY: number; timeY: number }
}

export function computeLayout(w: number, h: number, withText: boolean): Layout {
  const u = h / 1080
  const margin = Math.round(Math.max(8, 84 * u))
  const card = Math.round((withText ? 372 : 400) * u)
  const ringR = card * 0.5 * Math.SQRT2 + 18 * u
  const ringAmp = 96 * u
  // The ring's centre sits so its outer reach clears header and footer.
  const cy = Math.round(h * 0.47)
  const cx = withText ? Math.round(Math.max(ringR + ringAmp + margin * 0.4, w * 0.29)) : Math.round(w / 2)
  const textX = Math.round(withText ? Math.max(cx + ringR + ringAmp * 0.75 + 40 * u, w * 0.53) : w)
  return {
    w,
    h,
    u,
    mode: withText ? 'split' : 'centred',
    cx,
    cy,
    card,
    ringR,
    ringAmp,
    margin,
    text: { x: textX, maxWidth: Math.max(10, w - margin - textX), cy },
    header: { x: margin, y: Math.round(60 * u), maxWidth: w * 0.62 },
    footer: { x0: margin, x1: w - margin, barY: Math.round(h - 62 * u), timeY: Math.round(h - 84 * u) },
  }
}
