/**
 * Account pool. Each account holds one shared upstream session; devices are
 * spread across the pool by a stable hash of their id. Credentials come from
 * WAZE_ACCOUNTS: a JSON array of { "username": "...", "password": "..." }.
 */
export interface Account { username: string; password: string }

export function loadPool(accountsJson: string | undefined): Account[] {
  if (!accountsJson) return []
  try {
    const arr = JSON.parse(accountsJson)
    return Array.isArray(arr) ? arr.filter(a => a?.username && a?.password) : []
  } catch {
    console.error('[boot] WAZE_ACCOUNTS is not valid JSON')
    return []
  }
}

/** Stable pick so a given device keeps landing on the same account. */
export function pickIndex(n: number, deviceId: string): number {
  let h = 2166136261
  for (let i = 0; i < deviceId.length; i++) { h ^= deviceId.charCodeAt(i); h = Math.imul(h, 16777619) }
  return (h >>> 0) % n
}
