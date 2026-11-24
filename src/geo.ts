export interface View { south: number; west: number; north: number; east: number }
/** A scan tile: centre plus half-extents in degrees. */
export interface Tile { lat: number; lon: number; hLat: number; hLon: number }

export const tileView = (t: Tile): View =>
  ({ south: t.lat - t.hLat, north: t.lat + t.hLat, west: t.lon - t.hLon, east: t.lon + t.hLon })
export const inView = (a: { lat: number; lon: number }, v: View) =>
  a.lat >= v.south && a.lat <= v.north && a.lon >= v.west && a.lon <= v.east
export const tileKey = (t: Tile) =>
  `${t.lat.toFixed(4)},${t.lon.toFixed(4)},${t.hLat.toFixed(4)},${t.hLon.toFixed(4)}`
