import { T } from '@start9labs/start-sdk'
import { i18n } from '../../i18n'
import {
  assertAboveFloor,
  describeFee,
  mempoolFee,
  perkb,
} from '../../recovery/fees'
import { isResolved, walletTotals } from '../../recovery/node'
import {
  chainRecord,
  literal,
  readState,
  row,
  stillRunning,
} from '../../recovery/report'
import { audit, refreshFinal, saveRawTx } from '../../recovery/snapshot'
import { slow, withTools } from '../../recovery/tools'
import { sdk } from '../../sdk'

const { InputSpec, Value } = sdk

/** What lightningd holds back for fee-bumping while an anchor channel is unresolved. */
export const anchorReserveSat = 25_000

export const recoveryWithdraw = sdk.Action.withInput(
  'recovery-withdraw',

  async ({ effects }) => ({
    name: i18n('Recovery: Withdraw to SHA256d Wallet'),
    description: i18n(
      'Sends the whole on-chain balance to one address on the chain this node follows, and saves the raw transaction in recovery/final.',
    ),
    warning: i18n(
      'The transaction is valid on both chains and can be replayed on the other one by anybody. Whoever controls the address receives the coins on both chains: use an address of a wallet whose keys you hold, never an exchange or custodial deposit address.',
    ),
    allowedStatuses: 'only-running',
    group: i18n('Recovery'),
    visibility: 'enabled',
  }),

  InputSpec.of({
    destination: Value.text({
      name: i18n('Destination Address'),
      description: i18n(
        'An address of a wallet whose keys you hold. The coins arrive there on this chain, and on the other chain too if the transaction is replayed.',
      ),
      required: true,
      default: null,
      placeholder: 'bc1…',
    }),
    feerate: Value.number({
      name: i18n('Feerate'),
      description: i18n(
        'Fee for the withdrawal. It must pay at least 1 sat per vbyte by itself to be replayed on the other chain; values below 1100 are refused.',
      ),
      required: true,
      default: 3000,
      min: 1,
      integer: true,
      units: 'sat per 1000 vbytes',
    }),
    acknowledged: Value.toggle({
      name: i18n('I hold the keys of this address'),
      description: i18n(
        'Required. The transaction will be replayable on the other chain, so the address must be self-custodied.',
      ),
      default: false,
    }),
    force: Value.toggle({
      name: i18n('Withdraw With Unresolved Channels'),
      description: i18n(
        'Withdraw although a channel is still open or its close is not fully resolved. Funds still in channels are not included, and 25,000 sat may be held back.',
      ),
      default: false,
    }),
  }),

  async ({ effects }) => ({}),

  async ({ effects, input }): Promise<T.ActionResult & { version: '1' }> => {
    assertAboveFloor(input.feerate)
    if (!input.acknowledged) {
      throw new Error(
        i18n(
          'Refused: confirm that you hold the keys of the destination address. The transaction can be replayed on the other chain.',
        ),
      )
    }
    const destination = input.destination.trim()
    return withTools(effects, 'recovery-withdraw', async (tools) => {
      const state = await readState(tools)
      if (!state.lists) {
        throw new Error(i18n('Core Lightning is not answering.'))
      }
      const unresolved = state.lists.listpeerchannels.channels.filter(
        (c) => !isResolved(c),
      )
      if (unresolved.length && !input.force) {
        throw new Error(
          i18n(
            'Refused: ${count} channel(s) are open or not fully resolved (${states}). Wait, or turn on "Withdraw With Unresolved Channels".',
            {
              count: String(unresolved.length),
              states: literal(
                [...new Set(unresolved.map((c) => c.state))].join(', '),
              ),
            },
          ),
        )
      }
      await audit('withdraw', { destination, feerate: perkb(input.feerate) })
      let res: { tx: string; txid: string }
      try {
        res = await tools.lightning<{ tx: string; txid: string }>(
          'withdraw',
          { destination, satoshi: 'all', feerate: perkb(input.feerate) },
          slow,
        )
      } catch (e) {
        const running = stillRunning('withdraw', e)
        if (running) return running
        throw e
      }
      const saved = await saveRawTx('withdraw', res.txid, res.tx)
      const fee = await mempoolFee(tools, res.txid)
      const lists = await refreshFinal(tools, chainRecord(tools, state))
      await audit('withdraw-result', { txid: res.txid, saved })

      // The inputs just spent stay listed, reserved, until the withdrawal
      // confirms: what remains is whatever is not reserved.
      const left = walletTotals(
        lists.listfunds.outputs.filter(
          (o) => o.status !== 'spent' && !o.reserved,
        ),
      )
      const remaining = left.confirmed + left.unconfirmed + left.immature
      return {
        version: '1',
        title: i18n('Withdrawal broadcast'),
        message: [
          i18n(
            'Withdrawal ${txid} broadcast to ${destination}. The raw transaction is saved as ${file}.',
            {
              txid: res.txid,
              destination: literal(destination),
              file: literal(saved),
            },
          ),
          ...(remaining
            ? [
                i18n(
                  '${amount} sat remain in the wallet. Core Lightning holds back ${reserve} sat for fee-bumping while a channel with anchor outputs is unresolved; withdraw again once every channel has been forgotten.',
                  {
                    amount: String(remaining),
                    reserve: String(anchorReserveSat),
                  },
                ),
              ]
            : []),
        ].join('\n\n'),
        result: {
          type: 'group',
          value: [
            row(i18n('Transaction ID'), res.txid, true),
            row(i18n('Fee paid'), describeFee(fee)),
            row(i18n('Remaining in the wallet'), `${remaining} sat`),
            row(i18n('Raw transaction'), res.tx, true),
          ],
        },
      }
    })
  },
)
