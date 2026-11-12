import { T } from '@start9labs/start-sdk'
import { storeJson } from '../../fileModels/store.json'
import { i18n } from '../../i18n'
import {
  assertAboveFloor,
  describeFee,
  mempoolFee,
  perkb,
} from '../../recovery/fees'
import { recoveryRescan, SplitHeights } from '../../recovery/heights'
import {
  htlcCount,
  isOpen,
  Lists,
  PeerChannel,
  shortId,
} from '../../recovery/node'
import {
  chainRecord,
  group,
  literal,
  readState,
  row,
} from '../../recovery/report'
import { audit, refreshFinal, saveRawTx } from '../../recovery/snapshot'
import { CliError, Tools, withTools } from '../../recovery/tools'
import { sdk } from '../../sdk'

const { InputSpec, Value } = sdk

/** A channel whose close transaction is in the database, whether or not it is in a block. */
const closeDecided = (c: PeerChannel) =>
  !isOpen(c) || c.state === 'CLOSINGD_COMPLETE'

/**
 * Starts the BLAKE2b instance once every close is decided: main copies the
 * database (the copy then holds the negotiated shutdown scripts, so the
 * fork recognizes every cooperative close) and runs the fork on it, offline,
 * rescanning from below the split. Returns the line to tell the operator.
 */
async function startBlake2b(
  effects: T.Effects,
  tools: Tools,
  channels: PeerChannel[],
  heights: SplitHeights | null,
): Promise<string | null> {
  const store = await storeJson.read().once()
  if (!store?.recovery) return null
  if (store.blake2b) {
    return i18n('The BLAKE2b instance is already running.')
  }
  if (!channels.every(closeDecided)) {
    return i18n(
      'The BLAKE2b instance is not started yet: a close is still being negotiated. Run this action again once Recovery: Status shows every channel closing.',
    )
  }
  const rescan = recoveryRescan(heights)
  await storeJson.merge(effects, {
    blake2b: true,
    ...(rescan === null ? {} : { blake2bRescan: rescan }),
  })
  await audit('blake2b-start', { rescan })
  return i18n(
    'Every close is broadcast. Core Lightning restarts now with a second instance: a copy of the database run by the BLAKE2b build against the BLAKE2b chain, offline, reading that chain from height ${height}. Its health checks are "BLAKE2b Instance" and "BLAKE2b Chain"; run Recovery: Status once the latter is green.',
    { height: String(heights?.rescanFrom ?? '?') },
  )
}

// `txs`/`txids` are arrays: a close can be more than one transaction.
type CloseResult = { type: string; txids?: string[]; txs?: string[] }

// StartOS 0.4.1 stops an action 120 s after it starts (RunAction in
// core/src/service/action.rs) and nothing after that point runs: no saved
// transaction, no refreshed lists, no result. Everything here fits in 100 s,
// and the closes get what is left after keeping `tailMs` for that work.
const budgetMs = 100_000
const tailMs = 25_000
const maxTimeout = 60

const closeChannel = async (
  tools: Tools,
  channel: PeerChannel,
  timeout: number,
  feerange: [string, string],
  waitMs: number,
) => {
  try {
    // `close` answers once the close transaction is broadcast: at once for a
    // peer that cooperates, after `unilateraltimeout` seconds for one that
    // does not. If the client gives up first, lightningd carries on.
    const res = await tools.lightning<CloseResult>(
      'close',
      { id: channel.channel_id, unilateraltimeout: timeout, feerange },
      waitMs,
    )
    return { channel, res, error: null, timedOut: false }
  } catch (e) {
    return {
      channel,
      res: null,
      error: e instanceof Error ? e.message : String(e),
      timedOut: e instanceof CliError && e.timedOut,
    }
  }
}

/**
 * The wallet transactions spending each closing channel's funding output,
 * saved as raw files. Catches up on closes an earlier run did not live to save.
 */
async function saveCloseTxs(lists: Lists, skip: Set<string>) {
  const out: { channel: PeerChannel; txid: string; rawtx: string }[] = []
  for (const channel of lists.listpeerchannels.channels.filter(
    (c) => !isOpen(c),
  )) {
    for (const t of lists.listtransactions.transactions) {
      const spends = t.inputs.some(
        (i) =>
          i.txid === channel.funding_txid && i.index === channel.funding_outnum,
      )
      if (!spends || skip.has(t.hash)) continue
      await saveRawTx('close', t.hash, t.rawtx)
      out.push({ channel, txid: t.hash, rawtx: t.rawtx })
    }
  }
  return out
}

export const recoveryCloseAll = sdk.Action.withInput(
  'recovery-close-all',

  async ({ effects }) => ({
    name: i18n('Recovery: Close All Channels'),
    description: i18n(
      'Closes every open channel on the SHA256d chain. Each close is tried cooperatively first; a peer that has not answered within the unilateral timeout is force-closed. Afterwards the lists in recovery/final are refreshed, and once every close is broadcast the BLAKE2b instance is started. Run it again with nothing left to close to save close transactions an earlier run missed, or to start the BLAKE2b instance.',
    ),
    warning: i18n(
      "Closing channels cannot be undone. A unilateral close locks your side of the channel for the peer's CSV delay, and its fee was fixed when the commitment was signed.",
    ),
    allowedStatuses: 'only-running',
    group: i18n('Recovery'),
    visibility: 'enabled',
  }),

  InputSpec.of({
    'unilateral-timeout': Value.number({
      name: i18n('Unilateral Timeout'),
      description: i18n(
        'How long to wait for each peer to agree to a cooperative close before closing unilaterally. This action runs until every channel has answered, so it can take this long.',
      ),
      required: true,
      default: 30,
      min: 1,
      max: maxTimeout,
      integer: true,
      units: 'seconds',
    }),
    'feerange-floor': Value.number({
      name: i18n('Lowest Close Feerate'),
      description: i18n(
        'The lowest feerate this node accepts for a cooperative close. The close transaction must pay at least 1 sat per vbyte by itself to be replayed on the other chain; values below 1100 are refused.',
      ),
      required: true,
      // The lowest the replay allows: a higher floor can refuse a peer's
      // offer by a satoshi and turn a cooperative close into a unilateral one.
      default: 1100,
      min: 1,
      integer: true,
      units: 'sat per 1000 vbytes',
    }),
    force: Value.toggle({
      name: i18n('Close With HTLCs In Flight'),
      description: i18n(
        'Close even though payments are still in flight. Their outcome is then settled on chain, which takes longer and costs more.',
      ),
      default: false,
    }),
  }),

  async ({ effects }) => ({}),

  async ({ effects, input }): Promise<T.ActionResult & { version: '1' }> => {
    const started = Date.now()
    const timeout = Math.min(input['unilateral-timeout'], maxTimeout)
    const floor = input['feerange-floor']
    assertAboveFloor(floor)
    return withTools(effects, 'recovery-close-all', async (tools) => {
      const state = await readState(tools)
      if (!state.lists) {
        throw new Error(i18n('Core Lightning is not answering.'))
      }
      const open = state.lists.listpeerchannels.channels.filter(isOpen)
      const htlcs = htlcCount(open)
      if (htlcs && !input.force) {
        throw new Error(
          i18n(
            'Refused: ${count} HTLC(s) are in flight. Wait for them to settle, or turn on "Close With HTLCs In Flight".',
            { count: String(htlcs) },
          ),
        )
      }
      if (!open.length) {
        // Nothing to close, but an earlier run may have been stopped before
        // it saved its close transactions: save them now.
        const lists = await refreshFinal(tools, chainRecord(tools, state))
        const saved = await saveCloseTxs(lists, new Set())
        const closing = lists.listpeerchannels.channels.filter(
          (c) => !isOpen(c),
        )
        await audit('close-all-catch-up', {
          saved: saved.map((s) => s.txid),
        })
        const blake2b = await startBlake2b(
          effects,
          tools,
          lists.listpeerchannels.channels,
          state.heights,
        )
        return {
          version: '1',
          title: i18n('Nothing to close'),
          message: [
            i18n('This node has no open channels.'),
            ...(closing.length
              ? [
                  i18n(
                    'Close transactions of channels already closing were saved, and the lists in recovery/final were refreshed.',
                  ),
                ]
              : []),
            ...(blake2b ? [blake2b] : []),
          ].join('\n\n'),
          result: closing.length
            ? {
                type: 'group',
                value: closing.map((c) =>
                  group(`${i18n('Channel')} ${shortId(c.channel_id)}`, [
                    row(i18n('State'), c.state),
                    ...saved
                      .filter((s) => s.channel.channel_id === c.channel_id)
                      .flatMap((s) => [
                        row(i18n('Transaction ID'), s.txid, true),
                        row(i18n('Raw transaction'), s.rawtx, true),
                      ]),
                  ]),
                ),
              }
            : null,
        }
      }

      // The ceiling is this node's own estimate; with none, the floor is both ends.
      const rates = await tools
        .lightning<{
          perkb?: { unilateral_close?: number; opening?: number }
        }>('feerates', { style: 'perkb' })
        .catch(() => null)
      const ceiling = Math.max(
        floor,
        rates?.perkb?.unilateral_close ?? 0,
        rates?.perkb?.opening ?? 0,
      )
      const feerange: [string, string] = [perkb(floor), perkb(ceiling)]
      await audit('close-all', {
        channels: open.map((c) => c.channel_id),
        timeout,
        feerange,
      })

      const waitMs = Math.max(5_000, started + budgetMs - tailMs - Date.now())
      const results = await Promise.all(
        open.map((c) => closeChannel(tools, c, timeout, feerange, waitMs)),
      )
      const lateFor = () => started + budgetMs - Date.now() < 10_000

      const rows: T.ActionResultMember[] = []
      for (const { channel, res, error, timedOut } of results) {
        const name = `${i18n('Channel')} ${shortId(channel.channel_id)}`
        if (!res) {
          rows.push(
            group(name, [
              timedOut
                ? row(
                    i18n('Still running'),
                    i18n(
                      'No answer within the time StartOS gives an action. The close has not failed: Core Lightning is still working on it. Run this action again in a few minutes to save its close transaction.',
                    ),
                  )
                : row(i18n('Error'), error ?? '-'),
            ]),
          )
          continue
        }
        const txids = res.txids ?? []
        const members = [row(i18n('Close type'), res.type)]
        for (const [i, txid] of txids.entries()) {
          const tx = res.txs?.[i]
          if (tx) await saveRawTx('close', txid, tx)
          members.push(row(i18n('Transaction ID'), txid, true))
          // The fee is only shown; skip it rather than run out of time.
          if (!lateFor()) {
            members.push(
              row(i18n('Fee paid'), describeFee(await mempoolFee(tools, txid))),
            )
          }
          members.push(row(i18n('Raw transaction'), tx ?? '-', !!tx))
        }
        rows.push(group(name, members))
      }
      const lists = await refreshFinal(tools, chainRecord(tools, state))
      await saveCloseTxs(
        lists,
        new Set(results.flatMap((r) => r.res?.txids ?? [])),
      )
      await audit(
        'close-all-result',
        results.map((r) => ({
          channel: r.channel.channel_id,
          type: r.res?.type,
          txids: r.res?.txids,
          error: r.error,
        })),
      )

      const failed = results.filter((r) => !r.res && !r.timedOut).length
      const unilateral = results.filter(
        (r) => r.res?.type === 'unilateral',
      ).length
      const blake2b = lateFor()
        ? null
        : await startBlake2b(
            effects,
            tools,
            lists.listpeerchannels.channels,
            state.heights,
          )
      return {
        version: '1',
        title: failed ? i18n('Some closes failed') : i18n('Channels closing'),
        message: [
          i18n(
            '${closed} of ${total} channel(s) closing: ${unilateral} unilaterally, ${failed} failed. Feerange offered: ${range}.',
            {
              closed: String(results.length - failed),
              total: String(results.length),
              unilateral: String(unilateral),
              failed: String(failed),
              range: literal(feerange.join(' .. ')),
            },
          ),
          blake2b ??
            i18n(
              'Run this action again in a few minutes: with nothing left to close it saves any close transaction this run missed and starts the BLAKE2b instance.',
            ),
        ].join('\n\n'),
        result: { type: 'group', value: rows },
      }
    })
  },
)
