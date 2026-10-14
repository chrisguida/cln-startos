import { T } from '@start9labs/start-sdk'
import { i18n } from '../i18n'
import {
  ChainComparison,
  compareChains,
  sha256dHeaderBytes,
  SplitHeights,
  splitHeights,
} from './chain'
import {
  fetchLists,
  htlcCount,
  isOpen,
  isResolved,
  Lists,
  sat,
  shortId,
  walletTotals,
} from './node'
import { ChainRecord } from './snapshot'
import { Tools } from './tools'

/** `$` starts a placeholder in an i18n parameter: double it in free text. */
export const literal = (text: string) => text.replace(/\$/g, '$$$$')

export const row = (
  name: string,
  value: string,
  copyable = false,
): T.ActionResultMember => ({
  name,
  description: null,
  type: 'single',
  value,
  copyable,
  qr: false,
  masked: false,
})

export const group = (
  name: string,
  value: T.ActionResultMember[],
): T.ActionResultMember => ({ name, description: null, type: 'group', value })

export type State = {
  heights: SplitHeights | null
  chain: ChainComparison
  node: ChainRecord['node']
  /** null when lightningd is not answering. */
  lists: Lists | null
}

/** Everything the recovery actions decide on, read in one go. */
export async function readState(tools: Tools): Promise<State> {
  const heights = await splitHeights(tools.network)
  const chain = await compareChains(tools, heights)
  const info = await tools
    .lightning<{ id: string; version: string; blockheight: number }>('getinfo')
    .catch(() => null)
  return {
    heights,
    chain,
    node: info && {
      id: info.id,
      version: info.version,
      blockheight: info.blockheight,
    },
    lists: info ? await fetchLists(tools) : null,
  }
}

export const chainRecord = (
  tools: Tools,
  state: State,
): Omit<ChainRecord, 'takenAt'> => ({
  network: tools.network,
  backend: tools.backend,
  heights: state.heights,
  node: state.node,
  chain: state.chain,
})

/** Plain-language sentences about which chain the backend and the database are on. */
export function chainVerdict(tools: Tools, state: State): string[] {
  const { heights, chain } = state
  if (!heights) {
    return [
      i18n(
        'No split height is known for regtest. Set the BLAKE2b Test Activation Height in General Settings to use the Recovery actions.',
      ),
    ]
  }
  const lines: string[] = []
  const block = chain.activationBlock
  if (!block) {
    lines.push(
      i18n(
        'The Bitcoin backend (${backend}) is at height ${tip} and has not reached the activation height ${height}: the chains have not parted yet.',
        {
          backend: tools.backend,
          tip: String(chain.backendTip),
          height: String(heights.activation),
        },
      ),
    )
  } else if (block.headerBytes === sha256dHeaderBytes) {
    lines.push(
      i18n(
        'The Bitcoin backend (${backend}) follows the SHA256d chain: its block at height ${height} has an 80-byte header.',
        { backend: tools.backend, height: String(heights.activation) },
      ),
    )
  } else {
    lines.push(
      i18n(
        'The Bitcoin backend (${backend}) follows the BLAKE2b chain: its block at height ${height} has a ${bytes}-byte header.',
        {
          backend: tools.backend,
          height: String(heights.activation),
          bytes: String(block.headerBytes),
        },
      ),
    )
  }
  if (chain.databaseTip === null) {
    lines.push(i18n('The Core Lightning database holds no blocks yet.'))
  } else if (chain.databaseTip < heights.split) {
    lines.push(
      i18n(
        'The Core Lightning database ends at height ${tip}, below the split at ${split}: it has not followed either chain past the split.',
        { tip: String(chain.databaseTip), split: String(heights.split) },
      ),
    )
  } else {
    lines.push(
      i18n(
        'The Core Lightning database has followed a chain past the split at ${split}, up to height ${tip}.',
        { tip: String(chain.databaseTip), split: String(heights.split) },
      ),
    )
  }
  const differing = chain.mismatches.filter((m) => m.backend !== null)
  if (differing.length) {
    lines.push(
      i18n(
        'WRONG CHAIN: at height ${height} the database holds a different block than the backend. The database followed another chain than this backend.',
        { height: String(differing[0].height) },
      ),
    )
  } else if (chain.mismatches.length) {
    lines.push(
      i18n(
        'The backend (height ${tip}) is behind the Core Lightning database (height ${dbtip}).',
        { tip: String(chain.backendTip), dbtip: String(chain.databaseTip) },
      ),
    )
  }
  return lines
}

export function chainRows(tools: Tools, state: State): T.ActionResultMember[] {
  const { heights, chain } = state
  const block = chain.activationBlock
  return [
    row(
      i18n('Bitcoin backend'),
      `${tools.backend}, ${tools.network}, height ${chain.backendTip}`,
    ),
    row(
      i18n('Split heights'),
      heights
        ? `split ${heights.split}, BLAKE2b activation ${heights.activation}, rescan from ${heights.rescanFrom}`
        : '-',
    ),
    row(
      i18n('Backend block at the activation height'),
      block
        ? `${block.hash} (${block.headerBytes}-byte header: ${
            block.headerBytes === sha256dHeaderBytes ? 'SHA256d' : 'BLAKE2b'
          })`
        : '-',
      !!block,
    ),
    row(
      i18n('Core Lightning database blocks'),
      chain.databaseTip === null
        ? '-'
        : `${chain.databaseFirst}..${chain.databaseTip}`,
    ),
    row(
      i18n('Database compared with the backend'),
      chain.mismatches.length
        ? chain.mismatches
            .map(
              (m) =>
                `height ${m.height}: database ${m.database}, backend ${m.backend ?? 'none'}`,
            )
            .join('; ')
        : `${chain.compared} heights compared, all equal`,
    ),
  ]
}

/** What the node's channels still need on this chain. */
export function pathVerdict(state: State): string[] {
  const { lists } = state
  if (!lists) {
    return [
      i18n(
        'Core Lightning is not answering, so channels and funds are not shown. Start it and run this action again.',
      ),
    ]
  }
  const channels = lists.listpeerchannels.channels
  const open = channels.filter(isOpen)
  const resolving = channels.filter((c) => !isOpen(c) && !isResolved(c))
  const htlcs = htlcCount(channels)
  const lines: string[] = []
  if (open.length) {
    lines.push(
      i18n(
        'STILL OPEN: ${count} channel(s). A peer that has not moved to this chain cannot be reached from this build; close such a channel unilaterally here.',
        { count: String(open.length) },
      ),
    )
  }
  if (resolving.length) {
    lines.push(
      i18n(
        '${count} channel close(s) are still being resolved on this chain. Wait for them before splitting the coins.',
        { count: String(resolving.length) },
      ),
    )
  }
  if (htlcs) {
    lines.push(
      i18n('${count} HTLC(s) are in flight.', { count: String(htlcs) }),
    )
  }
  return lines
}

export function nodeRows(state: State): T.ActionResultMember[] {
  const { lists, node } = state
  if (!lists || !node) return []
  const channels = lists.listpeerchannels.channels
  const closed = lists.listclosedchannels.closedchannels
  const outputs = lists.listfunds.outputs
  const totals = walletTotals(outputs)
  const byState = new Map<string, number>()
  for (const c of channels)
    byState.set(c.state, (byState.get(c.state) ?? 0) + 1)
  return [
    row(
      i18n('Core Lightning'),
      `${node.version}, height ${node.blockheight}, ${node.id}`,
    ),
    row(
      i18n('Channels by state'),
      [...byState].map(([s, n]) => `${s}: ${n}`).join(', ') || '-',
    ),
    ...channels.map((c) =>
      row(
        `${i18n('Channel')} ${shortId(c.channel_id)}`,
        `${c.state}, ours ${sat(c.to_us_msat)} of ${sat(c.total_msat)} sat, ${
          c.htlcs?.length ?? 0
        } HTLC(s), ${c.channel_type?.names?.join('/') ?? '-'}, funding ${c.funding_txid}:${c.funding_outnum}`,
      ),
    ),
    row(i18n('Closed channels'), String(closed.length)),
    row(i18n('HTLCs in flight'), String(htlcCount(channels))),
    row(
      i18n('Wallet totals'),
      `${totals.confirmed} sat confirmed, ${totals.unconfirmed} sat unconfirmed, ${totals.immature} sat immature, in ${totals.count} output(s); ${totals.reserved} sat reserved`,
    ),
    ...outputs.map((o) =>
      row(
        `${i18n('Output')} ${shortId(o.txid)}:${o.output}`,
        `${sat(o.amount_msat)} sat, ${o.status}${
          o.blockheight ? ` at ${o.blockheight}` : ''
        }${o.reserved ? ', reserved' : ''}`,
      ),
    ),
  ]
}
