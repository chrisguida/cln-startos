import { T } from '@start9labs/start-sdk'
import { storeJson } from '../fileModels/store.json'
import { i18n } from '../i18n'
import { sha256dHeaderBytes } from './chain'
import {
  ClosedChannel,
  htlcCount,
  isOpen,
  isResolved,
  PeerChannel,
  recoveryPaths,
  sat,
  shortId,
  WalletOutput,
  walletTotals,
} from './node'
import {
  backendStatus,
  closedChannels,
  Drift,
  readSaved,
  Saved,
  selectChannelTxs,
  sharedCoins,
  unspentFundings,
  walletDrift,
} from './replay'
import {
  chainRows,
  chainVerdict,
  closingBlocks,
  group,
  literal,
  nodeRows,
  pathVerdict,
  readState,
  row,
  State,
} from './report'
import { recoveryPath, writePrivate } from './snapshot'
import { Chains, outpointKey, Tools } from './tools'

/**
 * Everything Recovery: Status reports and the other actions decide on, for
 * both chains, read in one go.
 */
export type Recovery = {
  store: {
    recovery: boolean
    blake2b: boolean
    blake2bRescan: number | undefined
    offline: boolean
  }
  sha256d: { tools: Tools; state: State }
  blake2b: {
    tools: Tools
    state: State
    /** The lists the SHA256d instance saved: what Replay works from. */
    saved: Saved
    /** Closed channels whose funding output the BLAKE2b service still has unspent. */
    unreplayed: (PeerChannel | ClosedChannel)[]
    /** Selected channel transactions not in a BLAKE2b block yet, as "txid (status)". */
    pendingReplays: string[]
    /**
     * Channel transactions the wallet saw but no block took (a stale
     * commitment of a channel that closed by another transaction), whose
     * inputs the BLAKE2b chain has spent otherwise: nothing to wait for.
     */
    superseded: string[]
    drift: Drift | null
  } | null
  /** The primary wallet's spendable coins, by whether BLAKE2b still has them unspent. */
  coins: {
    shared: WalletOutput[]
    safe: WalletOutput[]
    /** Shared coins the BLAKE2b wallet does not count: Split would miss them. */
    unknownToBlake2b: WalletOutput[]
  } | null
}

/** A channel whose close is decided: the close transaction is in the database. */
const pastNegotiation = (c: PeerChannel) =>
  !isOpen(c) || c.state === 'CLOSINGD_COMPLETE'

export const spendable = (o: WalletOutput) =>
  o.status === 'confirmed' && !o.reserved

export async function readRecovery(chains: Chains): Promise<Recovery> {
  const store = await storeJson.read().once()
  const sha256d = {
    tools: chains.sha256d,
    state: await readState(chains.sha256d),
  }
  let blake2b: Recovery['blake2b'] = null
  let coins: Recovery['coins'] = null
  if (chains.blake2b) {
    const tools = chains.blake2b
    const state = await readState(tools)
    const saved = await readSaved()
    const closed = closedChannels(saved, state.lists)
    const unreplayed = await unspentFundings(tools, closed).catch(() => [])
    const pendingReplays: string[] = []
    const superseded: string[] = []
    if (state.heights) {
      // Closes only: the sweeps are the BLAKE2b instance's own business, and a
      // withdrawal of a close output would otherwise count as one forever.
      for (const tx of selectChannelTxs(saved, state.heights).replay) {
        const status = await backendStatus(tools, tx).catch(() => 'unknown')
        if (status === 'confirmed') continue
        if (status === 'unknown') {
          // A commitment the wallet saw but no block took (the channel closed
          // by another transaction, on both chains) spends inputs that the
          // BLAKE2b chain has spent otherwise: it can never land there, so it
          // is not pending (P23). If the backend does not answer, it stays
          // pending: "no answer" never reads as "settled".
          const live = await tools
            .unspent(tx.inputs.map((i) => ({ txid: i.txid, index: i.index })))
            .catch(() => null)
          if (live && live.size === 0) {
            superseded.push(tx.hash)
            continue
          }
        }
        pendingReplays.push(`${tx.hash} (${status})`)
      }
    }
    const drift = state.lists
      ? await walletDrift(tools).catch(() => null)
      : null
    blake2b = {
      tools,
      state,
      saved,
      unreplayed,
      pendingReplays,
      superseded,
      drift,
    }

    if (sha256d.state.lists) {
      const outputs = sha256d.state.lists.listfunds.outputs.filter(
        (o) => o.status !== 'spent',
      )
      const split = await sharedCoins(tools, outputs).catch(() => null)
      if (split) {
        const known = new Set(
          (state.lists?.listfunds.outputs ?? []).map((o) =>
            outpointKey({ txid: o.txid, index: o.output }),
          ),
        )
        coins = {
          ...split,
          unknownToBlake2b: state.lists
            ? split.shared.filter(
                (o) =>
                  !known.has(outpointKey({ txid: o.txid, index: o.output })),
              )
            : [],
        }
      }
    }
  }
  return {
    store: {
      recovery: !!store?.recovery,
      blake2b: !!store?.blake2b,
      blake2bRescan: store?.blake2bRescan,
      offline: !!store?.offline,
    },
    sha256d,
    blake2b,
    coins,
  }
}

/** The channels that are closed but still have outputs to resolve, on one instance. */
const resolving = (state: State) =>
  (state.lists?.listpeerchannels.channels ?? []).filter(
    (c) => !isOpen(c) && !isResolved(c),
  )

const waitLine = (what: string, channels: PeerChannel[]) => {
  const blocks = closingBlocks(channels)
  return blocks
    ? i18n(
        'NEXT: wait. ${count} closing channel(s) on the ${chain} chain still have outputs to resolve; the longest wait is ${blocks} block(s), about ${hours} hour(s) at 10 minutes a block. Then run Recovery: Status again.',
        {
          count: String(channels.length),
          chain: literal(what),
          blocks: String(blocks),
          hours: String(Math.ceil(blocks / 6)),
        },
      )
    : i18n(
        'NEXT: wait. ${count} closing channel(s) on the ${chain} chain still have outputs to resolve. Run Recovery: Status again later.',
        { count: String(channels.length), chain: literal(what) },
      )
}

/** Whether every step before Finish is done. */
export function readyToFinish(r: Recovery): string[] {
  const reasons: string[] = []
  const lists = r.sha256d.state.lists
  if (!lists) return [i18n('The SHA256d instance is not answering.')]
  if (lists.listpeerchannels.channels.some((c) => !isResolved(c))) {
    reasons.push(i18n('A channel is open or unresolved on the SHA256d chain.'))
  }
  const totals = walletTotals(
    lists.listfunds.outputs.filter((o) => o.status !== 'spent'),
  )
  if (totals.confirmed + totals.unconfirmed + totals.immature) {
    reasons.push(
      i18n('The SHA256d wallet still holds ${amount} sat.', {
        amount: String(totals.confirmed + totals.unconfirmed + totals.immature),
      }),
    )
  }
  if (!r.blake2b?.state.lists) {
    reasons.push(i18n('The BLAKE2b instance is not answering.'))
    return reasons
  }
  if (r.blake2b.unreplayed.length || r.blake2b.pendingReplays.length) {
    reasons.push(i18n('A channel close is not on the BLAKE2b chain yet.'))
  }
  if (
    r.blake2b.state.lists.listpeerchannels.channels.some((c) => !isResolved(c))
  ) {
    reasons.push(i18n('A channel is open or unresolved on the BLAKE2b chain.'))
  }
  if (r.blake2b.drift?.phantom.length || r.blake2b.drift?.restorable.length) {
    reasons.push(i18n('The BLAKE2b wallet disagrees with its backend.'))
  }
  return reasons
}

/** The file Recovery: Finish reads, since it runs with the service stopped. */
export const finishReadyPath = `${recoveryPath}/finish-ready.json`

/** The one step the operator should take now. */
export function nextStep(r: Recovery): string {
  if (!r.store.recovery) {
    return i18n(
      'Recovery is finished: this node runs on the BLAKE2b chain alone. Install the BLAKE2b build of Core Lightning over this one when you like.',
    )
  }
  const lists = r.sha256d.state.lists
  if (!lists) {
    return i18n(
      'NEXT: start Core Lightning, or wait for it to answer, then run Recovery: Status again.',
    )
  }
  const channels = lists.listpeerchannels.channels
  if (channels.some(isOpen) && !channels.every(pastNegotiation)) {
    return channels.some((c) => isOpen(c) && c.state !== 'CLOSINGD_COMPLETE')
      ? i18n('NEXT: Recovery: Snapshot, then Recovery: Close All Channels.')
      : i18n(
          'NEXT: wait for the closes to be broadcast, then run Recovery: Status again.',
        )
  }
  if (!r.store.blake2b) {
    return i18n(
      'NEXT: run Recovery: Close All Channels once more. With nothing left to close it starts the BLAKE2b instance, which watches the BLAKE2b chain from here on.',
    )
  }
  const b = r.blake2b
  if (!b?.state.lists) {
    return i18n(
      'NEXT: wait for the BLAKE2b instance to start (the "BLAKE2b Instance" health check), then run Recovery: Status again.',
    )
  }
  if (
    r.store.blake2bRescan !== undefined ||
    b.state.node!.blockheight < b.state.chain.backendTip
  ) {
    return i18n(
      'NEXT: wait. The BLAKE2b instance is reading the BLAKE2b chain (block ${height} of ${tip}, the "BLAKE2b Chain" health check). Then run Recovery: Status again.',
      {
        height: String(b.state.node!.blockheight),
        tip: String(b.state.chain.backendTip),
      },
    )
  }
  if (b.unreplayed.length) {
    return i18n(
      'NEXT: Recovery: Replay Closes, which copies ${count} channel close(s) to the BLAKE2b chain.',
      { count: String(b.unreplayed.length) },
    )
  }
  if (b.pendingReplays.length) {
    return i18n(
      'NEXT: wait for ${count} replayed close(s) to be in a BLAKE2b block, then run Recovery: Status again.',
      { count: String(b.pendingReplays.length) },
    )
  }
  const closingSha = resolving(r.sha256d.state)
  if (closingSha.length) return waitLine('SHA256d', closingSha)
  const closingBlake = resolving(b.state)
  if (closingBlake.length) return waitLine('BLAKE2b', closingBlake)
  if (b.drift?.phantom.length || b.drift?.restorable.length) {
    return i18n(
      'NEXT: Recovery: Repair Wallet, so that the BLAKE2b wallet agrees with the BLAKE2b chain.',
    )
  }
  if (r.coins?.unknownToBlake2b.length) {
    return i18n(
      'NEXT: ${count} coin(s) on both chains are unknown to the BLAKE2b wallet. Run Recovery: Repair Wallet; if they stay unknown, send the diagnostics to the person helping you.',
      { count: String(r.coins.unknownToBlake2b.length) },
    )
  }
  const blakeTotals = walletTotals(b.state.lists.listfunds.outputs)
  if (r.coins?.shared.length) {
    return blakeTotals.unconfirmed || blakeTotals.immature
      ? i18n(
          'NEXT: wait for the BLAKE2b transactions to confirm, then run Recovery: Status again.',
        )
      : i18n(
          'NEXT: Recovery: Split Coins, which moves ${count} coin(s) that exist on both chains to BLAKE2b-only coins.',
          { count: String(r.coins.shared.length) },
        )
  }
  const totals = walletTotals(
    lists.listfunds.outputs.filter((o) => o.status !== 'spent'),
  )
  if (totals.unconfirmed || totals.immature) {
    return i18n(
      'NEXT: wait for the SHA256d transactions to confirm, then run Recovery: Status again.',
    )
  }
  if (r.coins?.safe.filter(spendable).length && !blake2bSettled(r).length) {
    return i18n(
      'NEXT: Recovery: Snapshot, then Recovery: Withdraw to SHA256d Wallet (${count} coin(s), ${amount} sat).',
      {
        count: String(r.coins.safe.filter(spendable).length),
        amount: String(walletTotals(r.coins.safe.filter(spendable)).confirmed),
      },
    )
  }
  if (totals.confirmed) {
    return i18n(
      'NEXT: ${amount} sat on SHA256d are reserved and cannot be withdrawn yet. Wait until every channel is forgotten, then run Recovery: Status again.',
      { amount: String(totals.confirmed) },
    )
  }
  const reasons = readyToFinish(r)
  if (reasons.length) {
    return i18n('NEXT: wait. Not ready to finish: ${reasons}', {
      reasons: literal(reasons.join(' ')),
    })
  }
  return i18n(
    'NEXT: take a last Recovery: Snapshot, stop Core Lightning, then run Recovery: Finish.',
  )
}

/** Lines about the BLAKE2b side, in the order the operator needs them. */
function blake2bVerdict(r: Recovery): string[] {
  const lines: string[] = []
  if (!r.store.blake2b) {
    lines.push(
      i18n(
        'The BLAKE2b instance has not been started yet: Recovery: Close All Channels starts it once every close is broadcast.',
      ),
    )
    return lines
  }
  const b = r.blake2b
  if (!b) return lines
  lines.push(...chainVerdict(b.tools, b.state))
  if (b.state.chain.activationBlock?.headerBytes === sha256dHeaderBytes) {
    lines.push(
      i18n(
        'WRONG BACKEND: the BLAKE2b instance follows ${backend}, which is on the SHA256d chain. Point the bitcoind service at the BLAKE2b chain (Bitcoin Knots).',
        { backend: b.tools.backend },
      ),
    )
  }
  if (!b.state.lists) {
    lines.push(i18n('The BLAKE2b instance is not answering.'))
    return lines
  }
  if (b.unreplayed.length) {
    lines.push(
      i18n(
        'REPLAY NEEDED: ${count} closed channel(s) still have their funding output unspent on the BLAKE2b chain. Their close happened on SHA256d only.',
        { count: String(b.unreplayed.length) },
      ),
    )
  } else if (closedChannels(b.saved, b.state.lists).length) {
    lines.push(
      i18n(
        'Every closed channel has its funding output spent on the BLAKE2b chain: no close is left to replay.',
      ),
    )
  }
  if (b.pendingReplays.length) {
    lines.push(
      i18n(
        '${count} channel transaction(s) are not in a BLAKE2b block yet: ${list}.',
        {
          count: String(b.pendingReplays.length),
          list: literal(b.pendingReplays.join(', ')),
        },
      ),
    )
  }
  if (b.superseded.length) {
    lines.push(
      i18n(
        'SUPERSEDED: ${count} channel transaction(s) the wallet saw but no block took (${list}) spend inputs that the BLAKE2b chain has spent by other transactions: a stale commitment of a channel that closed another way. Nothing to wait for.',
        {
          count: String(b.superseded.length),
          list: literal(b.superseded.map(shortId).join(', ')),
        },
      ),
    )
  }
  if (!b.saved.sources.length) {
    lines.push(
      i18n(
        'No saved lists were found under recovery/. Replay Closes needs the lists that Recovery: Close All Channels and Recovery: Snapshot write.',
      ),
    )
  }
  const d = b.drift
  if (d && (d.phantom.length || d.restorable.length)) {
    lines.push(
      i18n(
        'REPAIR NEEDED: the BLAKE2b wallet disagrees with the BLAKE2b chain. ${phantom} output(s) it counts do not exist unspent there, and ${restorable} output(s) worth ${amount} sat it has as spent are unspent there.',
        {
          phantom: String(d.phantom.length),
          restorable: String(d.restorable.length),
          amount: String(
            d.restorable.reduce((n, o) => n + sat(o.amount_msat), 0),
          ),
        },
      ),
    )
  } else if (d) {
    lines.push(
      i18n('The BLAKE2b wallet agrees with the BLAKE2b chain on every output.'),
    )
  }
  const resolvingBlake = resolving(b.state)
  if (resolvingBlake.length) {
    lines.push(
      i18n(
        '${count} channel close(s) are still being resolved on the BLAKE2b chain.',
        { count: String(resolvingBlake.length) },
      ),
    )
  }
  return lines
}

/**
 * Why the SHA256d side cannot be withdrawn from yet: a close that is not on
 * the BLAKE2b chain, or not resolved there, can still put a coin there that
 * looks SHA256d-only today (a close output, a copied sweep), after which a
 * SHA256d withdrawal of that coin could be copied. Empty once settled.
 */
export function blake2bSettled(r: Recovery): string[] {
  const b = r.blake2b
  if (!b?.state.lists) return [i18n('The BLAKE2b instance is not answering.')]
  const reasons: string[] = []
  if (b.unreplayed.length || b.pendingReplays.length) {
    reasons.push(i18n('A channel close is not on the BLAKE2b chain yet.'))
  }
  if (b.state.lists.listpeerchannels.channels.some((c) => !isResolved(c))) {
    reasons.push(i18n('A channel is open or unresolved on the BLAKE2b chain.'))
  }
  return reasons
}

function coinsVerdict(r: Recovery): string[] {
  if (!r.coins) return []
  const lines: string[] = []
  if (r.coins.shared.length) {
    lines.push(
      i18n(
        'ON BOTH CHAINS: ${count} coin(s) worth ${amount} sat are unspent on both chains. A SHA256d withdrawal of them could be copied to BLAKE2b, so Withdraw refuses them until Recovery: Split Coins has moved them on BLAKE2b.',
        {
          count: String(r.coins.shared.length),
          amount: String(walletTotals(r.coins.shared).confirmed),
        },
      ),
    )
  }
  if (r.coins.unknownToBlake2b.length) {
    lines.push(
      i18n(
        'UNKNOWN TO THE BLAKE2b WALLET: ${count} of those coin(s) are not in the BLAKE2b wallet, so Split would not move them.',
        { count: String(r.coins.unknownToBlake2b.length) },
      ),
    )
  }
  if (r.coins.safe.length) {
    const args = {
      count: String(r.coins.safe.length),
      amount: String(walletTotals(r.coins.safe).confirmed),
    }
    lines.push(
      blake2bSettled(r).length
        ? i18n(
            'SHA256d ONLY FOR NOW: ${count} coin(s) worth ${amount} sat are not on BLAKE2b at the moment. Withdraw refuses them until every close is on the BLAKE2b chain and resolved there: a close output or sweep copied there later would make their withdrawal copyable too.',
            args,
          )
        : i18n(
            'SHA256d ONLY: ${count} coin(s) worth ${amount} sat are spent or unknown on BLAKE2b and can be withdrawn.',
            args,
          ),
    )
  }
  return lines
}

const coinRow = (o: WalletOutput, note: string) =>
  row(
    `${i18n('Output')} ${shortId(o.txid)}:${o.output}`,
    `${sat(o.amount_msat)} sat, ${o.status}${o.reserved ? ', reserved' : ''}: ${note}`,
  )

/** The Status result, also written into Recovery: Export Diagnostics. */
export async function statusResult(
  r: Recovery,
): Promise<T.ActionResult & { version: '1' }> {
  const next = nextStep(r)
  const reasons = r.store.recovery ? readyToFinish(r) : []
  await writePrivate(
    finishReadyPath,
    JSON.stringify({
      at: new Date().toISOString(),
      ready: !reasons.length,
      reasons,
    }),
  ).catch(() => {})

  const sha = r.sha256d
  const shaLines = [
    ...chainVerdict(sha.tools, sha.state),
    ...(sha.state.chain.activationBlock &&
    sha.state.chain.activationBlock.headerBytes !== sha256dHeaderBytes &&
    r.store.recovery
      ? [
          i18n(
            'WRONG BACKEND: the SHA256d instance follows ${backend}, which is on the BLAKE2b chain. In General Settings choose the Knots (pre-RDTS) service as the Bitcoin Backend.',
            { backend: sha.tools.backend },
          ),
        ]
      : []),
    ...pathVerdict(sha.state),
  ]
  const b = r.blake2b
  return {
    version: '1',
    title: i18n('Recovery: Status'),
    message: [
      ...(r.store.recovery
        ? [
            i18n('SHA256d chain (${backend}):', { backend: sha.tools.backend }),
            ...shaLines,
            i18n('BLAKE2b chain:'),
            ...blake2bVerdict(r),
            ...coinsVerdict(r),
          ]
        : shaLines),
      next,
    ].join('\n\n'),
    result: {
      type: 'group',
      value: [
        group(r.store.recovery ? i18n('SHA256d chain') : i18n('Chain'), [
          ...chainRows(sha.tools, sha.state),
          row(i18n('Offline mode'), r.store.offline ? 'on' : 'off'),
          ...nodeRows(sha.state),
        ]),
        ...(r.store.recovery
          ? [
              group(i18n('BLAKE2b chain'), [
                row(
                  i18n('BLAKE2b instance'),
                  !r.store.blake2b
                    ? i18n('not started yet')
                    : b?.state.node
                      ? `${b.state.node.version}, height ${b.state.node.blockheight}${
                          r.store.blake2bRescan !== undefined
                            ? ', first rescan pending'
                            : ''
                        }`
                      : i18n('not answering'),
                ),
                ...(b ? chainRows(b.tools, b.state) : []),
                ...(b
                  ? [
                      row(
                        i18n('Saved lists'),
                        b.saved.sources.join(', ') || '-',
                      ),
                      ...closedChannels(b.saved, b.state.lists).map((c) =>
                        row(
                          `${i18n('Channel')} ${shortId(c.channel_id)}`,
                          `funding ${c.funding_txid}:${c.funding_outnum} ${
                            b.unreplayed.includes(c)
                              ? 'UNSPENT on BLAKE2b: replay needed'
                              : 'spent on BLAKE2b'
                          }`,
                        ),
                      ),
                      row(
                        i18n('Outputs checked'),
                        String(b.drift?.checked ?? 0),
                      ),
                      ...(b.drift?.phantom ?? []).map((o) =>
                        coinRow(
                          o,
                          'wallet: counted, BLAKE2b: spent or unknown',
                        ),
                      ),
                      ...(b.drift?.restorable ?? []).map((o) =>
                        coinRow(o, 'wallet: not counted, BLAKE2b: unspent'),
                      ),
                      ...nodeRows(b.state),
                    ]
                  : []),
              ]),
              group(i18n('Coins on both chains'), [
                ...(r.coins?.shared ?? []).map((o) =>
                  coinRow(
                    o,
                    r.coins?.unknownToBlake2b.includes(o)
                      ? 'unspent on both chains, unknown to the BLAKE2b wallet'
                      : 'unspent on both chains: Split before Withdraw',
                  ),
                ),
                ...(r.coins?.safe ?? []).map((o) =>
                  coinRow(o, 'SHA256d only: can be withdrawn'),
                ),
              ]),
            ]
          : []),
      ],
    },
  }
}
