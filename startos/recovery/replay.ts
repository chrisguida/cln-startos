import { SplitHeights } from './heights'
import {
  ClosedChannel,
  isOpen,
  Lists,
  PeerChannel,
  WalletOutput,
  WalletTx,
} from './node'
import { readdir } from 'fs/promises'
import { finalPath, host, readLists, snapshotDirs } from './snapshot'
import { CliError, outpointKey, slow, Tools } from './tools'

/** Transaction ids of the withdrawals saved by Recovery: Withdraw. */
const savedWithdrawals = async () =>
  new Set(
    (await readdir(host(finalPath)).catch(() => [] as string[]))
      .map((n) => n.match(/^withdraw-([0-9a-f]{64})\.hex$/)?.[1])
      .filter((t): t is string => !!t),
  )

type Funding = { funding_txid: string; funding_outnum: number }
const outpoint = (txid: string, index: number) => `${txid}:${index}`

export type Saved = {
  /** Directories the lists were read from. */
  sources: string[]
  transactions: WalletTx[]
  /** Every channel the SHA256d instance knew, open, closing or forgotten. */
  channels: (PeerChannel | ClosedChannel)[]
  /**
   * Withdrawals this package made (recovery/final/withdraw-<txid>.hex). One
   * that spends only close outputs looks like a sweep to the descent guard,
   * and replaying it would pay the SHA256d destination on BLAKE2b too.
   */
  withdrawals: Set<string>
}

/**
 * Everything the SHA256d instance saved: recovery/final plus every timestamped
 * snapshot, merged. A later list wins, so a transaction carries the height
 * that instance last knew for it.
 */
export async function readSaved(): Promise<Saved> {
  const sources: string[] = []
  const transactions = new Map<string, WalletTx>()
  const channels = new Map<string, PeerChannel | ClosedChannel>()
  for (const dir of [...(await snapshotDirs()), finalPath]) {
    const lists: Lists | null = await readLists(dir)
    if (!lists) continue
    sources.push(dir)
    for (const t of lists.listtransactions.transactions) {
      transactions.set(t.hash, t)
    }
    for (const c of [
      ...lists.listpeerchannels.channels,
      ...lists.listclosedchannels.closedchannels,
    ]) {
      if (c.funding_txid) {
        channels.set(outpoint(c.funding_txid, c.funding_outnum), c)
      }
    }
  }
  return {
    sources,
    transactions: [...transactions.values()],
    channels: [...channels.values()],
    withdrawals: await savedWithdrawals(),
  }
}

/**
 * Channels the node has as closed or closing, by its latest knowledge: the
 * running instance's own lists where there are any, the saved ones otherwise.
 */
export function closedChannels(
  saved: Saved,
  live: Pick<Lists, 'listpeerchannels' | 'listclosedchannels'> | null,
) {
  const latest = new Map<string, PeerChannel | ClosedChannel>()
  for (const c of [
    ...saved.channels,
    ...(live?.listpeerchannels.channels ?? []),
    ...(live?.listclosedchannels.closedchannels ?? []),
  ]) {
    if (c.funding_txid)
      latest.set(outpoint(c.funding_txid, c.funding_outnum), c)
  }
  // Only an entry of listpeerchannels has a state; a forgotten channel has none.
  return [...latest.values()].filter((c) => !('state' in c) || !isOpen(c))
}

export type Selection = {
  /** Channel transactions at or above the split, parents first. */
  replay: WalletTx[]
  /** Channel transactions below the split: on both chains already. */
  shared: number
  /** Transactions at or above the split that are not channel transactions. */
  skipped: WalletTx[]
}

/**
 * The descent guard. A transaction may be replayed only if every one of its
 * inputs is a channel funding outpoint or an output of a transaction that is
 * itself selected: closes, and whatever spends only their outputs (sweeps,
 * HTLC transactions). A wallet withdrawal has wallet inputs and is never
 * selected, nor is anything that mixes in another input.
 *
 * With `closesOnly`, only the closes themselves (every input a funding
 * outpoint). The BLAKE2b instance makes its own sweeps, signed for that
 * chain only, so copying the SHA256d sweeps would only create more coins that
 * exist on both chains.
 */
export function selectChannelTxs(
  saved: Saved,
  heights: SplitHeights,
  closesOnly = true,
): Selection {
  const funding = new Set(
    saved.channels.map((c: Funding) =>
      outpoint(c.funding_txid, c.funding_outnum),
    ),
  )
  const selected: WalletTx[] = []
  const ids = new Set<string>()
  let remaining = saved.transactions.filter(
    (t) => t.inputs.length > 0 && !saved.withdrawals.has(t.hash),
  )
  for (;;) {
    const next = remaining.filter((t) =>
      t.inputs.every(
        (i) =>
          funding.has(outpoint(i.txid, i.index)) ||
          (!closesOnly && ids.has(i.txid)),
      ),
    )
    if (!next.length) break
    for (const t of next) {
      selected.push(t)
      ids.add(t.hash)
    }
    remaining = remaining.filter((t) => !ids.has(t.hash))
  }
  // blockheight 0 is "not in a block yet" on the SHA256d side: still to replay.
  const afterSplit = (t: WalletTx) =>
    t.blockheight === 0 || t.blockheight >= heights.split
  return {
    replay: selected.filter(afterSplit),
    shared: selected.filter((t) => !afterSplit(t)).length,
    skipped: remaining.filter(afterSplit),
  }
}

type TxOut = { confirmations: number; value: number } | null

export const txOut = (tools: Tools, txid: string, index: number) =>
  tools.bitcoin<TxOut>('gettxout', [txid, index]).catch((e) => {
    // gettxout prints nothing for a spent or unknown output
    if (e instanceof SyntaxError) return null
    throw e
  })

/** Where the backend has a transaction: in a block, in its mempool, or nowhere it can see. */
export async function backendStatus(
  tools: Tools,
  tx: WalletTx,
): Promise<'confirmed' | 'mempool' | 'unknown'> {
  const inMempool = await tools.bitcoin('getmempoolentry', [tx.hash]).then(
    () => true,
    () => false,
  )
  if (inMempool) return 'mempool'
  for (const o of tx.outputs) {
    if ((await txOut(tools, tx.hash, o.index)) !== null) return 'confirmed'
  }
  // Every output spent already, or never seen. With txindex the node can tell.
  const raw = await tools
    .bitcoin<{ confirmations?: number }>('getrawtransaction', [tx.hash, true])
    .catch(() => null)
  return raw?.confirmations ? 'confirmed' : 'unknown'
}

export type Verdict =
  | { kind: 'confirmed' | 'mempool' | 'sent' | 'acceptable'; fee?: string }
  | { kind: 'wait-blocks'; blocks: number }
  | { kind: 'wait-parent' }
  | { kind: 'wait-height'; height: number }
  | { kind: 'fee-too-low'; detail: string }
  | { kind: 'conflict' | 'rejected'; detail: string }

type Accept = {
  allowed: boolean
  vsize?: number
  fees?: { base: number }
  'reject-reason'?: string
  'reject-details'?: string
}

/** Blocks still to wait before a BIP68 relative locktime on an input is met. */
async function csvWait(tools: Tools, tx: WalletTx) {
  let wait = 0
  for (const i of tx.inputs) {
    // bit 31: no relative locktime. bit 22: time-based, not used by channels.
    if (i.sequence & 0x80000000 || i.sequence & 0x00400000) continue
    const needed = i.sequence & 0xffff
    const parent = await txOut(tools, i.txid, i.index)
    wait = Math.max(wait, needed - (parent?.confirmations ?? 0))
  }
  return wait
}

/**
 * Tests one transaction against the backend's mempool and, unless `dryRun`,
 * broadcasts it. A transaction the backend already has counts as done.
 */
export async function replayOne(
  tools: Tools,
  tx: WalletTx,
  dryRun: boolean,
  pendingParents: Set<string>,
): Promise<Verdict> {
  const status = await backendStatus(tools, tx)
  if (status !== 'unknown') return { kind: status }
  if (tx.inputs.some((i) => pendingParents.has(i.txid))) {
    return { kind: 'wait-parent' }
  }

  const [accept] = await tools.bitcoin<Accept[]>('testmempoolaccept', [
    [tx.rawtx],
  ])
  if (!accept.allowed) {
    const reason = accept['reject-reason'] ?? 'rejected'
    const detail = accept['reject-details'] ?? reason
    if (reason === 'txn-already-in-mempool') return { kind: 'mempool' }
    if (reason === 'txn-already-known') return { kind: 'confirmed' }
    if (reason === 'non-BIP68-final') {
      return {
        kind: 'wait-blocks',
        blocks: Math.max(await csvWait(tools, tx), 1),
      }
    }
    if (reason === 'non-final') {
      const decoded = await tools.bitcoin<{ locktime: number }>(
        'decoderawtransaction',
        [tx.rawtx],
      )
      return { kind: 'wait-height', height: decoded.locktime }
    }
    if (reason.includes('min relay fee not met')) {
      return { kind: 'fee-too-low', detail }
    }
    if (reason === 'missing-inputs' || reason.includes('missingorspent')) {
      return { kind: 'conflict', detail }
    }
    return { kind: 'rejected', detail }
  }

  const fee =
    accept.fees && accept.vsize
      ? `${Math.round(accept.fees.base * 1e8)} sat for ${accept.vsize} vB`
      : undefined
  if (dryRun) return { kind: 'acceptable', fee }
  try {
    await tools.bitcoinText('sendrawtransaction', [tx.rawtx])
    return { kind: 'sent', fee }
  } catch (e) {
    // -27: already in the chain. Raced with a block or another broadcaster.
    if (e instanceof CliError && e.code === -27) return { kind: 'confirmed' }
    if (e instanceof CliError && /already in mempool/.test(e.message)) {
      return { kind: 'mempool' }
    }
    return {
      kind: 'rejected',
      detail: e instanceof Error ? e.message : String(e),
    }
  }
}

export const isDone = (v: Verdict) =>
  v.kind === 'confirmed' || v.kind === 'mempool' || v.kind === 'sent'

/** Channels whose funding output the backend still shows unspent: their close is not on this chain. */
export async function unspentFundings<C extends Funding>(
  tools: Tools,
  channels: C[],
) {
  const point = (c: Funding) => ({
    txid: c.funding_txid,
    index: c.funding_outnum,
  })
  const unspent = await tools.unspent(channels.map(point))
  return channels.filter((c) => unspent.has(outpointKey(point(c))))
}

export type Drift = {
  /** The wallet counts these, the backend does not have them unspent. */
  phantom: WalletOutput[]
  /** The wallet has these as spent, the backend has them unspent. */
  restorable: WalletOutput[]
  /** How many outputs were checked. */
  checked: number
}

/**
 * What `dev-rescan-outputs` would change: every wallet output checked against
 * the backend's UTXO set. Whether the wallet counts an output is taken from
 * the plain `listfunds`, not from the `status` of `listfunds spent=true`: an
 * output whose spend was on the other chain shows there as "unconfirmed".
 */
export async function walletDrift(tools: Tools): Promise<Drift> {
  const list = (spent: boolean) =>
    tools
      .lightning<{ outputs: WalletOutput[] }>('listfunds', { spent }, slow)
      .then((r) => r.outputs)
  const point = (o: WalletOutput) => ({ txid: o.txid, index: o.output })
  const counted = await list(false)
  const all = await list(true)
  const countedKeys = new Set(counted.map((o) => outpointKey(point(o))))
  // The chain alone: an output spent by a transaction still in the mempool
  // (the split, say) is not a disagreement, the wallet keeps it reserved.
  const unspent = await tools.unspent(all.map(point), false)
  return {
    // An output the wallet has as unconfirmed is not in the chain's UTXO set
    // yet by definition (the split's own output, while it waits for a block).
    phantom: counted.filter(
      (o) => o.status === 'confirmed' && !unspent.has(outpointKey(point(o))),
    ),
    restorable: all.filter(
      (o) =>
        !countedKeys.has(outpointKey(point(o))) &&
        unspent.has(outpointKey(point(o))),
    ),
    checked: all.length,
  }
}

/**
 * The primary wallet's spendable coins sorted by whether the BLAKE2b service
 * still has them unspent. A coin unspent there would be moved on both chains
 * by one SHA256d withdrawal: it waits for Recovery: Split Coins.
 */
export async function sharedCoins(blake2b: Tools, outputs: WalletOutput[]) {
  const point = (o: WalletOutput) => ({ txid: o.txid, index: o.output })
  const points = outputs.map(point)
  // Spent in a block, or spent only in the mempool so far: a mempool spend can
  // still be evicted, so such a coin is not safe to withdraw yet (P26).
  const inChain = await blake2b.unspent(points, false)
  const withMempool = await blake2b.unspent(points, true)
  const key = (o: WalletOutput) => outpointKey(point(o))
  return {
    shared: outputs.filter((o) => withMempool.has(key(o))),
    pending: outputs.filter(
      (o) => inChain.has(key(o)) && !withMempool.has(key(o)),
    ),
    safe: outputs.filter((o) => !inChain.has(key(o))),
  }
}
