import { T } from '@start9labs/start-sdk'
import { i18n } from '../../i18n'
import {
  describeFee,
  feerateInput,
  mempoolFee,
  resolveFeerate,
  storedEstimates,
} from '../../recovery/fees'
import { isResolved, sat, walletTotals } from '../../recovery/node'
import { chainRecord, literal, row, stillRunning } from '../../recovery/report'
import { audit, refreshFinal, saveRawTx } from '../../recovery/snapshot'
import { blake2bSettled, readRecovery, spendable } from '../../recovery/status'
import { slow, withChains } from '../../recovery/tools'
import { sdk } from '../../sdk'

const { InputSpec, Value } = sdk

/** What lightningd holds back for fee-bumping while an anchor channel is unresolved. */
export const anchorReserveSat = 25_000

export const recoveryWithdraw = sdk.Action.withInput(
  'recovery-withdraw',

  async ({ effects }) => ({
    name: i18n('Recovery: Withdraw to SHA256d Wallet'),
    description: i18n(
      'Sends the on-chain balance on the SHA256d chain to one address, and saves the raw transaction in recovery/final. Only coins that are spent or unknown on the BLAKE2b chain are sent: a coin still unspent there would be moved on both chains by the one transaction, so it waits for Recovery: Split Coins.',
    ),
    warning: [
      i18n(
        'Use an address of a wallet whose keys you hold, never an exchange or custodial deposit address. The transaction is signed the old way, so if the BLAKE2b check were ever wrong it could be copied to that chain by anybody.',
      ),
      await storedEstimates(effects, 'sha256d'),
    ].join(' '),
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
    feerate: feerateInput(),
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
    if (!input.acknowledged) {
      throw new Error(
        i18n(
          'Refused: confirm that you hold the keys of the destination address. The transaction can be replayed on the other chain.',
        ),
      )
    }
    const destination = input.destination.trim()
    return withChains(effects, 'recovery-withdraw', async (chains) => {
      const tools = chains.sha256d
      const recovery = await readRecovery(chains)
      const state = recovery.sha256d.state
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

      // The rule: nothing that is still unspent on the BLAKE2b chain, and
      // nothing at all until every close is on that chain and resolved there
      // (a close output or a copied sweep can appear there later and make a
      // withdrawal of it copyable). Both need the BLAKE2b side to answer;
      // without it, nothing. The force toggle does not bypass this.
      if (!chains.blake2b || !recovery.blake2b) {
        throw new Error(
          i18n(
            'Refused: the BLAKE2b instance has not been started, so it cannot be checked which coins still exist on the BLAKE2b chain. Run Recovery: Close All Channels first.',
          ),
        )
      }
      const settled = blake2bSettled(recovery)
      if (settled.length) {
        throw new Error(
          i18n(
            'Refused: the BLAKE2b side is not settled yet: ${reasons} Until every close is on the BLAKE2b chain and resolved there, a coin that looks SHA256d-only can still appear there and make this withdrawal copyable. Run Recovery: Status for the next step.',
            { reasons: literal(settled.join(' ')) },
          ),
        )
      }
      if (!recovery.coins) {
        throw new Error(
          i18n(
            'Refused: the BLAKE2b chain could not be asked which coins still exist there (${error}). Nothing was sent.',
            { error: literal('gettxout failed') },
          ),
        )
      }
      const coins = {
        safe: recovery.coins.safe.filter(spendable),
        shared: [...recovery.coins.shared, ...recovery.coins.pending].filter(
          spendable,
        ),
      }
      if (!coins.safe.length) {
        throw new Error(
          coins.shared.length
            ? i18n(
                'Refused: every spendable coin (${count}, ${amount} sat) is still unspent on the BLAKE2b chain. Run Recovery: Split Coins first, wait for it to confirm, then withdraw.',
                {
                  count: String(coins.shared.length),
                  amount: String(walletTotals(coins.shared).confirmed),
                },
              )
            : i18n('The wallet has no confirmed, unreserved output.'),
        )
      }
      const utxos = coins.safe.map((o) => `${o.txid}:${o.output}`)
      const rate = await resolveFeerate(tools, input.feerate)
      await audit('withdraw', {
        destination,
        feerate: rate.param,
        estimates: rate.estimates,
        utxos,
        held: coins.shared.map((o) => `${o.txid}:${o.output}`),
      })
      let res: { tx: string; txid: string }
      try {
        res = await tools.lightning<{ tx: string; txid: string }>(
          'withdraw',
          {
            destination,
            satoshi: 'all',
            feerate: rate.param,
            utxos,
          },
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
          ...(coins.shared.length
            ? [
                i18n(
                  'HELD BACK: ${count} coin(s) worth ${amount} sat are still unspent on the BLAKE2b chain and were not sent. Run Recovery: Split Coins, wait for it to confirm, then withdraw again.',
                  {
                    count: String(coins.shared.length),
                    amount: String(walletTotals(coins.shared).confirmed),
                  },
                ),
              ]
            : remaining
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
            row(i18n('Feerate'), rate.source),
            row(i18n('Fee paid'), describeFee(fee)),
            row(
              i18n('Coins sent'),
              `${utxos.length}, ${walletTotals(coins.safe).confirmed} sat`,
            ),
            row(
              i18n('Coins held back (unspent on BLAKE2b)'),
              coins.shared.length
                ? coins.shared
                    .map(
                      (o) =>
                        `${o.txid}:${o.output} (${sat(o.amount_msat)} sat)`,
                    )
                    .join(', ')
                : '-',
            ),
            row(i18n('Remaining in the wallet'), `${remaining} sat`),
            row(i18n('Raw transaction'), res.tx, true),
          ],
        },
      }
    })
  },
)
