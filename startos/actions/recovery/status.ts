import { T } from '@start9labs/start-sdk'
import { storeJson } from '../../fileModels/store.json'
import { i18n } from '../../i18n'
import { sha256dHeaderBytes } from '../../recovery/chain'
import { sat, shortId } from '../../recovery/node'
import {
  closedChannels,
  readSaved,
  selectChannelTxs,
  unspentFundings,
  walletDrift,
} from '../../recovery/replay'
import {
  chainRows,
  chainVerdict,
  group,
  nodeRows,
  pathVerdict,
  readState,
  row,
} from '../../recovery/report'
import { finalPath, readChainRecord } from '../../recovery/snapshot'
import { withTools } from '../../recovery/tools'
import { sdk } from '../../sdk'

export const recoveryStatus = sdk.Action.withoutInput(
  'recovery-status',

  async ({ effects }) => ({
    name: i18n('Recovery: Status'),
    description: i18n(
      "Shows which chain the Bitcoin backend is on, whether this node's database followed another chain, which channel closes still have to be replayed here, and whether the wallet agrees with the backend. Changes nothing.",
    ),
    warning: null,
    allowedStatuses: 'any',
    group: i18n('Recovery'),
    visibility: 'enabled',
  }),

  async ({ effects }): Promise<T.ActionResult & { version: '1' }> =>
    withTools(effects, 'recovery-status', async (tools) => {
      const state = await readState(tools)
      const store = await storeJson.read().once()
      const lines = chainVerdict(tools, state)

      if (state.chain.activationBlock?.headerBytes === sha256dHeaderBytes) {
        lines.push(
          i18n(
            'WRONG BACKEND: this build follows the BLAKE2b chain and stops on an 80-byte header at or above the activation height. Point it at a Bitcoin service that follows BLAKE2b.',
          ),
        )
      }

      // What the stock build recorded about the chain it was on.
      const before = await readChainRecord(finalPath)
      const tip = before?.chain?.databaseTip ?? null
      const tipHash = before?.chain?.databaseTipHash ?? null
      let followedOther = false
      if (
        state.heights &&
        tip !== null &&
        tipHash &&
        tip >= state.heights.split
      ) {
        const here =
          tip <= state.chain.backendTip
            ? await tools.bitcoinText('getblockhash', [tip])
            : null
        followedOther = here !== tipHash
        lines.push(
          followedOther
            ? i18n(
                'OTHER CHAIN: before the switch this node had followed another chain to height ${height} (its block there is not the block of this backend). Its wallet and closed channels reflect that chain until Replay and Repair have been done.',
                { height: String(tip) },
              )
            : i18n(
                'Before the switch this node had followed this same chain to height ${height}.',
                { height: String(tip) },
              ),
        )
      }

      // Closes that are not on this chain.
      const saved = await readSaved()
      const closed = closedChannels(saved, state.lists)
      const unspent = await unspentFundings(tools, closed)
      const selection = state.heights
        ? selectChannelTxs(saved, state.heights)
        : null
      if (unspent.length) {
        lines.push(
          i18n(
            'REPLAY NEEDED: ${count} channel(s) this node has as closed still have their funding output unspent on this backend. Their close happened on the other chain only. Run Recovery: Replay Closes.',
            { count: String(unspent.length) },
          ),
        )
      } else if (closed.length) {
        lines.push(
          i18n(
            'All ${count} closed channel(s) have their funding output spent on this backend: no close is left to replay.',
            { count: String(closed.length) },
          ),
        )
      }
      if (!saved.sources.length) {
        lines.push(
          i18n(
            'No saved lists were found under recovery/. Replay Closes needs the lists that Recovery: Snapshot of the stock build writes.',
          ),
        )
      }

      // Wallet against the backend's UTXO set.
      const drift = state.lists ? await walletDrift(tools) : null
      if (drift && (drift.phantom.length || drift.restorable.length)) {
        lines.push(
          i18n(
            'REPAIR NEEDED: the wallet disagrees with the backend. ${phantom} output(s) it counts do not exist unspent here, and ${restorable} output(s) worth ${amount} sat it has as spent are unspent here. Run Recovery: Repair Wallet once the replayed transactions have confirmed.',
            {
              phantom: String(drift.phantom.length),
              restorable: String(drift.restorable.length),
              amount: String(
                drift.restorable.reduce((n, o) => n + sat(o.amount_msat), 0),
              ),
            },
          ),
        )
      } else if (drift) {
        lines.push(i18n('The wallet agrees with the backend on every output.'))
      }

      lines.push(
        store?.recovery
          ? i18n(
              'Recovery mode is ON: Core Lightning runs offline and in developer mode. Run Recovery: Finish when the wallet is right.',
            )
          : i18n('Recovery mode is off.'),
      )

      return {
        version: '1',
        title: i18n('Recovery: Status'),
        message: [...lines, ...pathVerdict(state)].join('\n\n'),
        result: {
          type: 'group',
          value: [
            group(i18n('Chain'), [
              ...chainRows(tools, state),
              row(
                i18n('Recovery flags'),
                `recovery ${store?.recovery ? 'on' : 'off'}, offline ${
                  store?.offline ? 'on' : 'off'
                }, developer ${store?.developer ? 'on' : 'off'}, pending rescan ${
                  store?.rescan ?? 'none'
                }`,
              ),
              row(
                i18n('Stock build last followed'),
                tip === null ? '-' : `height ${tip}, block ${tipHash}`,
              ),
            ]),
            group(i18n('Closes'), [
              row(i18n('Saved lists'), saved.sources.join(', ') || '-'),
              row(
                i18n('Channel transactions to replay'),
                selection
                  ? `${selection.replay.length} at or above the split, ${selection.shared} below it, ${selection.skipped.length} other transaction(s) skipped`
                  : '-',
              ),
              ...closed.map((c) =>
                row(
                  `${i18n('Channel')} ${shortId(c.channel_id)}`,
                  `funding ${c.funding_txid}:${c.funding_outnum} ${
                    unspent.includes(c)
                      ? 'UNSPENT on this backend: replay needed'
                      : 'spent on this backend'
                  }`,
                ),
              ),
            ]),
            group(i18n('Wallet against the backend'), [
              row(i18n('Outputs checked'), String(drift?.checked ?? 0)),
              ...(drift?.phantom ?? []).map((o) =>
                row(
                  `${i18n('Output')} ${shortId(o.txid)}:${o.output}`,
                  `${sat(o.amount_msat)} sat, wallet: counted (${o.status}), backend: spent or unknown`,
                ),
              ),
              ...(drift?.restorable ?? []).map((o) =>
                row(
                  `${i18n('Output')} ${shortId(o.txid)}:${o.output}`,
                  `${sat(o.amount_msat)} sat, wallet: not counted, backend: unspent`,
                ),
              ),
            ]),
            group(i18n('Channels and wallet'), nodeRows(state)),
          ],
        },
      }
    }),
)
