import { storeJson } from '../fileModels/store.json'
import { CliError, Tools } from './tools'

/**
 * Where the SHA256d and BLAKE2b chains part.
 * - `split`: the first height at which the two chains hold different blocks.
 * - `activation`: the first height with a 164-byte BLAKE2b header.
 * - `rescanFrom`: a height safely below the split, for lightningd's --rescan.
 */
export type SplitHeights = {
  split: number
  activation: number
  rescanFrom: number
}

const mainnet: SplitHeights = {
  split: 961_632,
  activation: 961_640,
  rescanFrom: 961_600,
}

/**
 * Mainnet has fixed heights. Regtest takes the BLAKE2b test activation height
 * from General Settings, and has none until that is set.
 */
export async function splitHeights(
  network: string,
): Promise<SplitHeights | null> {
  if (network !== 'regtest') return mainnet
  const height = await storeJson.read((s) => s.blake2bActivationHeight).once()
  if (!height) return null
  return {
    split: height,
    activation: height,
    rescanFrom: Math.max(height - 40, 0),
  }
}

export const sha256dHeaderBytes = 80

export type Block = { height: number; hash: string; headerBytes: number }

/** The backend's block at a height, or null when it has none there. */
export async function backendBlock(
  tools: Tools,
  height: number,
): Promise<Block | null> {
  try {
    const hash = await tools.bitcoinText('getblockhash', [height])
    const header = await tools.bitcoinText('getblockheader', [hash, false])
    return { height, hash, headerBytes: header.length / 2 }
  } catch (e) {
    // -8: block height out of range. Anything else is a real failure.
    if (e instanceof CliError && e.code === -8) return null
    throw e
  }
}

/**
 * Blocks lightningd's database holds, read from the file so that it works
 * with lightningd stopped. lightningd keeps only a recent window of blocks.
 */
export async function databaseBlocks(tools: Tools) {
  const rows = await tools.sqlite<{ height: number; hash: string }>(
    'SELECT height, lower(hex(hash)) AS hash FROM blocks ORDER BY height',
  )
  // Stored in internal byte order; RPC shows hashes reversed.
  return rows.map((r) => ({
    height: r.height,
    hash: (r.hash.match(/../g) ?? []).reverse().join(''),
  }))
}

export type ChainComparison = {
  /** Lowest and highest block in lightningd's database. */
  databaseFirst: number | null
  databaseTip: number | null
  /** The block at the database tip: it identifies the chain the node followed. */
  databaseTipHash: string | null
  backendTip: number
  /** The backend's block at the activation height: 80 bytes is SHA256d. */
  activationBlock: Block | null
  /** Heights where the database and the backend hold different blocks. */
  mismatches: { height: number; database: string; backend: string | null }[]
  /** How many heights were compared. */
  compared: number
}

/**
 * Compares the blocks in lightningd's database with the backend's, at the
 * heights around the split and at the database tip.
 */
export async function compareChains(
  tools: Tools,
  heights: SplitHeights | null,
): Promise<ChainComparison> {
  const backendTip = await tools.bitcoin<number>('getblockcount')
  const blocks = await databaseBlocks(tools).catch(() => [])
  const byHeight = new Map(blocks.map((b) => [b.height, b.hash]))
  const databaseFirst = blocks.at(0)?.height ?? null
  const databaseTip = blocks.at(-1)?.height ?? null

  const wanted = new Set<number>()
  if (databaseFirst !== null) wanted.add(databaseFirst)
  if (databaseTip !== null) wanted.add(databaseTip)
  if (heights) {
    for (const h of [
      heights.split - 1,
      heights.split,
      heights.activation - 1,
      heights.activation,
      heights.activation + 1,
    ]) {
      wanted.add(h)
    }
  }

  const mismatches: ChainComparison['mismatches'] = []
  let compared = 0
  for (const height of [...wanted].sort((a, b) => a - b)) {
    const database = byHeight.get(height)
    if (!database) continue
    compared++
    const backend =
      height > backendTip
        ? null
        : await tools.bitcoinText('getblockhash', [height])
    if (backend !== database) mismatches.push({ height, database, backend })
  }

  return {
    databaseFirst,
    databaseTip,
    databaseTipHash: blocks.at(-1)?.hash ?? null,
    backendTip,
    activationBlock: heights
      ? await backendBlock(tools, heights.activation)
      : null,
    mismatches,
    compared,
  }
}
