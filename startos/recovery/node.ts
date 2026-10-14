import { SplitHeights } from './chain'
import { Tools } from './tools'

export type PeerChannel = {
  peer_id: string
  channel_id: string
  short_channel_id?: string
  state: string
  status?: string[]
  funding_txid: string
  funding_outnum: number
  to_us_msat?: number
  total_msat?: number
  htlcs?: unknown[]
  channel_type?: { names?: string[] }
}

export type ClosedChannel = {
  channel_id: string
  short_channel_id?: string
  funding_txid: string
  funding_outnum: number
  close_cause?: string
  final_to_us_msat?: number
}

export type WalletOutput = {
  txid: string
  output: number
  amount_msat: number
  status: 'unconfirmed' | 'confirmed' | 'spent' | 'immature'
  reserved: boolean
  blockheight?: number
}

export type WalletTx = {
  hash: string
  rawtx: string
  blockheight: number
  inputs: { txid: string; index: number; sequence: number }[]
  outputs: { index: number; amount_msat: number }[]
}

export type Lists = {
  listtransactions: { transactions: WalletTx[] }
  listclosedchannels: { closedchannels: ClosedChannel[] }
  listpeerchannels: { channels: PeerChannel[] }
  listfunds: { outputs: WalletOutput[] }
}

export const listMethods = [
  'listtransactions',
  'listclosedchannels',
  'listpeerchannels',
  'listfunds',
] as const

/** The four lists the recovery works from, straight from lightningd. */
export async function fetchLists(tools: Tools): Promise<Lists> {
  const lists: Record<string, unknown> = {}
  for (const method of listMethods) {
    // listtransactions carries every raw transaction the wallet has seen.
    lists[method] = await tools.lightning(method, {}, 300_000)
  }
  return lists as Lists
}

// The funding output is spent or about to be: nothing left to close.
const closingStates = [
  'AWAITING_UNILATERAL',
  'FUNDING_SPEND_SEEN',
  'ONCHAIN',
  'CLOSED',
]

/** A channel `close` still has work to do on. */
export const isOpen = (c: PeerChannel) => !closingStates.includes(c.state)

/** Closed and every output of the close accounted for. */
export const isResolved = (c: PeerChannel) =>
  c.state === 'CLOSED' ||
  (c.state === 'ONCHAIN' &&
    !!c.status?.some((s) => s.includes('All outputs resolved')))

export const htlcCount = (channels: PeerChannel[]) =>
  channels.reduce((n, c) => n + (c.htlcs?.length ?? 0), 0)

export const sat = (msat: number | undefined) => Math.floor((msat ?? 0) / 1000)

export const shortId = (id: string) => `${id.slice(0, 8)}…${id.slice(-4)}`

/**
 * Height of the transaction that spent a funding output, from the wallet's
 * own transaction list: 0 while unconfirmed, null when the wallet has none.
 */
export const closeHeight = (
  funding: { funding_txid: string; funding_outnum: number },
  transactions: WalletTx[],
) => {
  const spend = transactions.find((t) =>
    t.inputs.some(
      (i) =>
        i.txid === funding.funding_txid && i.index === funding.funding_outnum,
    ),
  )
  return spend ? spend.blockheight : null
}

export type Paths = {
  /** Channels that are still open. */
  open: PeerChannel[]
  /** Closed, with the close below the split: on both chains. */
  closedBefore: number
  /** Closed at or above the split: the close is on this chain only. */
  closedAfter: number
  /** Close seen but not yet in a block, or not in the wallet's list. */
  closedUnknown: number
}

/** Sorts every channel the node knows into the three recovery situations. */
export function recoveryPaths(
  lists: Lists,
  heights: SplitHeights | null,
): Paths {
  const channels = lists.listpeerchannels.channels
  const transactions = lists.listtransactions.transactions
  const paths: Paths = {
    open: channels.filter(isOpen),
    closedBefore: 0,
    closedAfter: 0,
    closedUnknown: 0,
  }
  for (const c of [
    ...channels.filter((c) => !isOpen(c)),
    ...lists.listclosedchannels.closedchannels,
  ]) {
    const height = closeHeight(c, transactions)
    if (!height || !heights) paths.closedUnknown++
    else if (height < heights.split) paths.closedBefore++
    else paths.closedAfter++
  }
  return paths
}

export const walletTotals = (outputs: WalletOutput[]) => {
  const total = (f: (o: WalletOutput) => boolean) =>
    outputs.filter(f).reduce((n, o) => n + sat(o.amount_msat), 0)
  return {
    count: outputs.length,
    confirmed: total((o) => o.status === 'confirmed'),
    unconfirmed: total((o) => o.status === 'unconfirmed'),
    immature: total((o) => o.status === 'immature'),
    reserved: total((o) => o.reserved),
  }
}
