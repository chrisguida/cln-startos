/**
 * Where the SHA256d and BLAKE2b chains part. No imports: bin-level checks
 * load this file on its own.
 * - `split`: the first height at which the two chains hold different blocks.
 * - `activation`: the first height with a 164-byte BLAKE2b header.
 * - `rescanFrom`: a height safely below the split, for lightningd's --rescan.
 */
export type SplitHeights = {
  split: number
  activation: number
  rescanFrom: number
}

export const mainnetHeights: SplitHeights = {
  split: 961_632,
  activation: 961_640,
  rescanFrom: 961_600,
}

/** How far below the test activation height a regtest rescan starts. */
export const regtestRescanMargin = 40

/**
 * The heights for a network. Mainnet's are fixed. Regtest's follow the
 * BLAKE2b test activation height, and there are none until that is set.
 */
export function heightsFor(
  network: string,
  regtestActivation: number | null | undefined,
): SplitHeights | null {
  if (network !== 'regtest') return mainnetHeights
  if (
    !regtestActivation ||
    !Number.isInteger(regtestActivation) ||
    regtestActivation < 1
  ) {
    return null
  }
  return {
    split: regtestActivation,
    activation: regtestActivation,
    rescanFrom: Math.max(regtestActivation - regtestRescanMargin, 0),
  }
}

/**
 * The value for lightningd's --rescan on entering recovery mode: a negative
 * number is an absolute height. Null when no split height is known.
 */
export const recoveryRescan = (heights: SplitHeights | null) =>
  heights ? -heights.rescanFrom : null
