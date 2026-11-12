// The band's icons, drawn for this mod: a microphone in the same spirit as
// Claude Desktop's own (a rounded capsule, a cradle arc, a stem), outlined at
// rest and filled while listening, plus a bar waveform. 1000 units per side.

/** The microphone as an SVG document: outlined, or filled while listening. */
export function micSvg(isFilled: boolean, color: string, size = 16): string {
  const stroke = `stroke="${color}" stroke-width="62" stroke-linecap="round" fill="none"`
  const body = isFilled
    ? `<rect x="360" y="90" width="280" height="500" rx="140" fill="${color}"/>`
    : `<rect x="391" y="121" width="218" height="438" rx="109" ${stroke}/>`
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1000 1000" width="${size}" height="${size}">` +
    body +
    `<path d="M210 450a290 290 0 0 0 580 0" ${stroke}/>` +
    `<path d="M500 740V880" ${stroke}/>` +
    `</svg>`
  )
}

/** A level meter as bars, newest on the right. */
export function waveSvg(levels: number[], color: string, bars = 20): string {
  const recent = levels.slice(-bars)
  const padded = [...Array(Math.max(0, bars - recent.length)).fill(0), ...recent]
  const w = 3
  const gap = 2
  const h = 16
  const rects = padded
    .map((l, i) => {
      const bh = Math.max(2, Math.round(Math.min(1, l) * h))
      return `<rect x="${i * (w + gap)}" y="${(h - bh) / 2}" width="${w}" height="${bh}" rx="1.5" fill="${color}"/>`
    })
    .join('')
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${bars * (w + gap) - gap} ${h}" width="${bars * (w + gap) - gap}" height="${h}">${rects}</svg>`
}
