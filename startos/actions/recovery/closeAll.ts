import { T } from '@start9labs/start-sdk'
import { i18n } from '../../i18n'
import {
  assertAboveFloor,
  describeFee,
  mempoolFee,
  perkb,
} from '../../recovery/fees'
import { htlcCount, isOpen, PeerChannel, shortId } from '../../recovery/node'
import {
  chainRecord,
  group,
  literal,
  readState,
  row,
} from '../../recovery/report'
import { audit, refreshFinal, saveRawTx } from '../../recovery/snapshot'
import { Tools, withTools } from '../../recovery/tools'
import { sdk } from '../../sdk'

const { InputSpec, Value } = sdk

// `txs`/`txids` are arrays: a close can be more than one transaction.
type CloseResult = { type: string; txids?: string[]; txs?: string[] }

const closeChannel = async (
  tools: Tools,
  channel: PeerChannel,
  timeout: number,
  feerange: [string, string],
) => {
  try {
    // `close` answers once the close transaction is broadcast: at once for a
    // peer that cooperates, after `unilateraltimeout` seconds for one that
    // does not. The client waits for the longer of the two, and a little more.
    const res = await tools.lightning<CloseResult>(
      'close',
      { id: channel.channel_id, unilateraltimeout: timeout, feerange },
      (timeout + 120) * 1000,
    )
    return { channel, res, error: null }
  } catch (e) {
    return {
      channel,
      res: null,
      error: e instanceof Error ? e.message : String(e),
    }
  }
}

export const recoveryCloseAll = sdk.Action.withInput(
  'recovery-close-all',

  async ({ effects }) => ({
    name: i18n('Recovery: Close All Channels'),
    description: i18n(
      'Closes every open channel. Each close is tried cooperatively first; a peer that has not answered within the unilateral timeout is force-closed. Afterwards the lists in recovery/final are refreshed.',
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
      default: 120,
      min: 1,
      max: 3600,
      integer: true,
      units: 'seconds',
    }),
    'feerange-floor': Value.number({
      name: i18n('Lowest Close Feerate'),
      description: i18n(
        'The lowest feerate this node accepts for a cooperative close. The close transaction must pay at least 1 sat per vbyte by itself to be replayed on the other chain; values below 1100 are refused.',
      ),
      required: true,
      default: 1500,
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
        return {
          version: '1',
          title: i18n('Nothing to close'),
          message: i18n('This node has no open channels.'),
          result: null,
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
        timeout: input['unilateral-timeout'],
        feerange,
      })

      const results = await Promise.all(
        open.map((c) =>
          closeChannel(tools, c, input['unilateral-timeout'], feerange),
        ),
      )

      const rows: T.ActionResultMember[] = []
      for (const { channel, res, error } of results) {
        const name = `${i18n('Channel')} ${shortId(channel.channel_id)}`
        if (!res) {
          rows.push(group(name, [row(i18n('Error'), error ?? '-')]))
          continue
        }
        const txids = res.txids ?? []
        const members = [row(i18n('Close type'), res.type)]
        for (const [i, txid] of txids.entries()) {
          const tx = res.txs?.[i]
          if (tx) await saveRawTx('close', txid, tx)
          members.push(
            row(i18n('Transaction ID'), txid, true),
            row(i18n('Fee paid'), describeFee(await mempoolFee(tools, txid))),
            row(i18n('Raw transaction'), tx ?? '-', !!tx),
          )
        }
        rows.push(group(name, members))
      }
      await refreshFinal(tools, chainRecord(tools, state))
      await audit(
        'close-all-result',
        results.map((r) => ({
          channel: r.channel.channel_id,
          type: r.res?.type,
          txids: r.res?.txids,
          error: r.error,
        })),
      )

      const failed = results.filter((r) => !r.res).length
      const unilateral = results.filter(
        (r) => r.res?.type === 'unilateral',
      ).length
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
          i18n(
            'Wait until Recovery: Status shows every channel resolved (after a unilateral close that includes the CSV delay and the sweep), then take a Recovery: Snapshot so that recovery/final holds every close and sweep transaction.',
          ),
        ].join('\n\n'),
        result: { type: 'group', value: rows },
      }
    })
  },
)
