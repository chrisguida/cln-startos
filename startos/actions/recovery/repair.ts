import { T } from '@start9labs/start-sdk'
import { storeJson } from '../../fileModels/store.json'
import { i18n } from '../../i18n'
import { splitHeights } from '../../recovery/chain'
import { sat, shortId, WalletOutput, walletTotals } from '../../recovery/node'
import {
  backendStatus,
  closedChannels,
  readSaved,
  selectChannelTxs,
  unspentFundings,
} from '../../recovery/replay'
import { literal, row } from '../../recovery/report'
import { audit } from '../../recovery/snapshot'
import { withTools } from '../../recovery/tools'
import { sdk } from '../../sdk'

const { InputSpec, Value } = sdk

// dev-rescan-outputs asks the backend about every output the wallet has ever
// had, one gettxout each. Six hours is far beyond what a large wallet needs;
// the point is that it is not the default 30 seconds.
const rescanTimeoutMs = 6 * 60 * 60 * 1000

type Rescanned = {
  txid: string
  output: number
  oldstate: number
  newstate: number
}

export const recoveryRepair = sdk.Action.withInput(
  'recovery-repair',

  async ({ effects }) => ({
    name: i18n('Recovery: Repair Wallet'),
    description: i18n(
      'Checks every output the wallet has ever had against the backend (dev-rescan-outputs) and corrects it: coins spent on the other chain only become spendable again, coins that only exist on the other chain disappear. Run it after the replayed transactions have confirmed. It can be run again.',
    ),
    warning: i18n(
      'Run this only against the backend whose chain you want this wallet to follow from now on. On a large wallet it can take a long time; leave the window open.',
    ),
    allowedStatuses: 'only-running',
    group: i18n('Recovery'),
    visibility: 'enabled',
  }),

  InputSpec.of({
    force: Value.toggle({
      name: i18n('Repair Although Replays Are Pending'),
      description: i18n(
        'Repair even though a channel close is still unreplayed or unconfirmed on this chain. The outputs of such transactions are then marked spent, and this action must be run again after they confirm.',
      ),
      default: false,
    }),
  }),

  async ({ effects }) => ({}),

  async ({ effects, input }): Promise<T.ActionResult & { version: '1' }> => {
    const store = await storeJson.read().once()
    if (!store?.recovery) {
      throw new Error(
        i18n(
          'Refused: recovery mode is off. This action is only for a node that arrived from the stock build and has not run Recovery: Finish.',
        ),
      )
    }
    return withTools(effects, 'recovery-repair', async (tools) => {
      const info = await tools
        .lightning<{
          blockheight: number
          warning_bitcoind_sync?: string
          warning_lightningd_sync?: string
        }>('getinfo')
        .catch(() => null)
      if (!info) throw new Error(i18n('Core Lightning is not answering.'))
      const tip = await tools.bitcoin<number>('getblockcount')
      if (
        info.blockheight !== tip ||
        info.warning_bitcoind_sync ||
        info.warning_lightningd_sync
      ) {
        throw new Error(
          i18n(
            'Refused: Core Lightning is at height ${height} and the backend at ${tip}. Wait until it has caught up (the Synced health check), then run this action again.',
            { height: String(info.blockheight), tip: String(tip) },
          ),
        )
      }

      // Anything replayed, or still to replay, that is not in a block yet.
      const heights = await splitHeights(tools.network)
      const saved = await readSaved()
      const pending: string[] = []
      if (heights) {
        for (const tx of selectChannelTxs(saved, heights).replay) {
          const status = await backendStatus(tools, tx)
          if (status !== 'confirmed') pending.push(`${tx.hash} (${status})`)
        }
      }
      const unreplayed = await unspentFundings(
        tools,
        closedChannels(saved, {
          listpeerchannels: await tools.lightning('listpeerchannels'),
          listclosedchannels: await tools.lightning('listclosedchannels'),
        }),
      )
      const warnings: string[] = []
      if (pending.length) {
        warnings.push(
          i18n(
            'WARNING: ${count} channel transaction(s) from the other chain are not in a block on this chain yet: ${list}. Their outputs are marked spent by a repair done now. Run Recovery: Replay Closes, wait for confirmations, and repair again.',
            {
              count: String(pending.length),
              list: literal(pending.join(', ')),
            },
          ),
        )
      }
      if (unreplayed.length) {
        warnings.push(
          i18n(
            'WARNING: ${count} closed channel(s) still have their funding output unspent on this backend. Run Recovery: Replay Closes first.',
            { count: String(unreplayed.length) },
          ),
        )
      }
      if (warnings.length && !input.force) {
        throw new Error(
          [
            i18n('Refused: replays are pending.'),
            ...warnings,
            i18n(
              'To repair anyway, turn on "Repair Although Replays Are Pending".',
            ),
          ].join(' '),
        )
      }

      await audit('repair', { pending, unreplayed: unreplayed.length })
      const before = await tools.lightning<{ outputs: WalletOutput[] }>(
        'listfunds',
        {},
        300_000,
      )
      const res = await tools.lightning<{ outputs: Rescanned[] }>(
        'dev-rescan-outputs',
        {},
        rescanTimeoutMs,
      )
      const after = await tools.lightning<{ outputs: WalletOutput[] }>(
        'listfunds',
        {},
        300_000,
      )
      const changed = res.outputs.filter((o) => o.oldstate !== o.newstate)
      const totals = walletTotals(after.outputs)
      const was = walletTotals(before.outputs)
      await audit('repair-result', { changed, totals })

      return {
        version: '1',
        title: i18n('Wallet repaired'),
        message: [
          ...warnings,
          i18n(
            '${checked} output(s) checked against the backend, ${changed} changed. Spendable balance: ${balance} sat (was ${was} sat).',
            {
              checked: String(res.outputs.length),
              changed: String(changed.length),
              balance: String(totals.confirmed),
              was: String(was.confirmed),
            },
          ),
        ].join('\n\n'),
        result: {
          type: 'group',
          value: [
            row(
              i18n('Wallet totals'),
              `${totals.confirmed} sat confirmed, ${totals.unconfirmed} sat unconfirmed, ${totals.immature} sat immature, in ${totals.count} output(s); ${totals.reserved} sat reserved`,
            ),
            ...changed.map((o) =>
              row(
                `${i18n('Output')} ${shortId(o.txid)}:${o.output}`,
                // 0 available, 1 reserved, 2 spent
                `${o.oldstate === 2 ? 'spent' : 'unspent'} -> ${
                  o.newstate === 2 ? 'spent' : 'unspent'
                }`,
              ),
            ),
            ...after.outputs.map((o) =>
              row(
                `${i18n('Output')} ${shortId(o.txid)}:${o.output}`,
                `${sat(o.amount_msat)} sat, ${o.status}${
                  o.reserved ? ', reserved' : ''
                }`,
              ),
            ),
          ],
        },
      }
    })
  },
)
