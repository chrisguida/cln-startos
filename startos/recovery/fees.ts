import { i18n } from '../i18n'
import { Tools } from './tools'

/**
 * Bitcoin Knots relays nothing below 1 sat/vB (1000 per kvB), per transaction.
 * A transaction that is to be replayed on the other chain must pay that on its
 * own, so the recovery actions refuse anything below this margin above it.
 */
export const minPerkb = 1100
export const relayFloorPerkb = 1000

export const perkb = (rate: number) => `${rate}perkb`

export function assertAboveFloor(rate: number) {
  if (rate < minPerkb) {
    throw new Error(
      i18n(
        'Refused: ${rate} sat per 1000 vbytes is below the minimum of ${min}. A transaction below 1 sat per vbyte is not relayed by Bitcoin Knots and could not be replayed on the other chain.',
        { rate: String(rate), min: String(minPerkb) },
      ),
    )
  }
}

/** What a transaction in the backend's mempool actually pays, or null if it is not there. */
export async function mempoolFee(tools: Tools, txid: string) {
  const entry = await tools
    .bitcoin<{
      vsize: number
      fees: { base: number }
    }>('getmempoolentry', [txid])
    .catch(() => null)
  if (!entry) return null
  const fee = Math.round(entry.fees.base * 1e8)
  return {
    fee,
    vsize: entry.vsize,
    perkb: Math.floor((fee * 1000) / entry.vsize),
  }
}

export const describeFee = (f: Awaited<ReturnType<typeof mempoolFee>>) =>
  f
    ? `${f.fee} sat for ${f.vsize} vB (${(f.perkb / 1000).toFixed(3)} sat/vB)${
        f.perkb < relayFloorPerkb ? ' BELOW THE KNOTS RELAY FLOOR' : ''
      }`
    : '-'
