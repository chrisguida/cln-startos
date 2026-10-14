import { i18n } from '../i18n'

/**
 * Bitcoin Knots relays nothing below 1 sat/vB (1000 per kvB), per transaction.
 * A transaction that is to be replayed on the other chain must pay that on its
 * own, so the recovery actions refuse anything below this margin above it.
 */
export const minPerkb = 1100

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
