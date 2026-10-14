import { T } from '@start9labs/start-sdk'
import { i18n } from '../../i18n'
import { assertAboveFloor, perkb } from '../../recovery/fees'
import { sat, WalletOutput, walletTotals } from '../../recovery/node'
import { group, literal, row } from '../../recovery/report'
import { audit, saveRawTx } from '../../recovery/snapshot'
import { Tools, withTools } from '../../recovery/tools'
import { sdk } from '../../sdk'

const { InputSpec, Value } = sdk

/** What lightningd holds back for fee-bumping while an anchor channel is unresolved. */
const anchorReserveSat = 25_000

/** SIGHASH_ALL with the unified flag: valid on the BLAKE2b chain only. */
const unifiedSighash = '21'

type Withdrawn = { tx: string; txid: string }
type Decoded = {
  vin: { txinwitness?: string[] }[]
  vout: { value: number }[]
}

/**
 * The sighash byte of each input's signature. A 64-byte Schnorr signature has
 * none (SIGHASH_DEFAULT), shown as 00.
 */
const decode = (tools: Tools, hex: string) =>
  tools.bitcoin<Decoded>('decoderawtransaction', [hex])

const sighashes = (decoded: Decoded) =>
  decoded.vin.map((i) => {
    const sig = (i.txinwitness ?? []).find(
      (w) =>
        w.length === 128 || w.length === 130 || /^30[0-9a-f]{136,144}$/.test(w),
    )
    return !sig ? '??' : sig.length === 128 ? '00' : sig.slice(-2)
  })

/** Whether a transaction left lightningd's anchor reserve behind as change. */
const keepsReserve = (decoded: Decoded) =>
  decoded.vout.some((o) => Math.round(o.value * 1e8) === anchorReserveSat)

const spendable = (o: WalletOutput) => o.status === 'confirmed' && !o.reserved

export const recoverySplit = sdk.Action.withInput(
  'recovery-split',

  async ({ effects }) => ({
    name: i18n('Recovery: Split Coins'),
    description: i18n(
      'Moves the on-chain balance in transactions that are valid on the BLAKE2b chain only, so that the coins on the two chains can no longer be spent by one transaction. First it spends a single output as a test, then everything else.',
    ),
    warning: i18n(
      'Run Recovery: Repair Wallet first, so that the wallet agrees with this chain. This spends the whole confirmed on-chain balance.',
    ),
    allowedStatuses: 'only-running',
    group: i18n('Recovery'),
    visibility: 'enabled',
  }),

  InputSpec.of({
    destination: Value.text({
      name: i18n('Destination Address'),
      description: i18n(
        'Where to send the coins on the BLAKE2b chain. Leave empty to send them to fresh addresses of this node.',
      ),
      required: false,
      default: null,
      placeholder: 'bc1…',
    }),
    feerate: Value.number({
      name: i18n('Feerate'),
      description: i18n(
        'An explicit feerate; values below 1100 are refused. Bitcoin Knots relays nothing below 1 sat per vbyte.',
      ),
      required: true,
      default: 3000,
      min: 1,
      integer: true,
      units: 'sat per 1000 vbytes',
    }),
  }),

  async ({ effects }) => ({}),

  async ({ effects, input }): Promise<T.ActionResult & { version: '1' }> => {
    assertAboveFloor(input.feerate)
    const feerate = perkb(input.feerate)
    const given = input.destination?.trim() || null
    return withTools(effects, 'recovery-split', async (tools) => {
      const address = async () =>
        given ??
        (
          await tools.lightning<{ p2tr: string }>('newaddr', {
            addresstype: 'p2tr',
          })
        ).p2tr
      const funds = async () =>
        (
          await tools.lightning<{ outputs: WalletOutput[] }>(
            'listfunds',
            {},
            300_000,
          )
        ).outputs

      const outputs = (await funds()).filter(spendable)
      if (!outputs.length) {
        return {
          version: '1',
          title: i18n('Nothing to split'),
          message: i18n('The wallet has no confirmed, unreserved output.'),
          result: null,
        }
      }

      // The test spend. A signing refusal in this build takes lightningd down,
      // so the first attempt risks one small output and nothing else.
      const smallest = outputs.reduce((a, b) =>
        b.amount_msat < a.amount_msat ? b : a,
      )
      const first = `${smallest.txid}:${smallest.output}`
      await audit('split-test', { utxo: first, feerate, destination: given })
      let test: Withdrawn
      try {
        test = await tools.lightning<Withdrawn>(
          'withdraw',
          {
            destination: await address(),
            satoshi: 'all',
            feerate,
            utxos: [first],
          },
          300_000,
        )
      } catch (e) {
        throw new Error(
          i18n(
            'The test spend of one output (${utxo}, ${amount} sat) failed, and nothing else was spent: ${error}. If Core Lightning stopped, it refused to sign: check its logs before trying again.',
            {
              utxo: first,
              amount: String(sat(smallest.amount_msat)),
              error: literal(e instanceof Error ? e.message : String(e)),
            },
          ),
        )
      }
      await saveRawTx('split', test.txid, test.tx)
      const testDecoded = await decode(tools, test.tx)
      const testSighashes = sighashes(testDecoded)
      const rows: T.ActionResultMember[] = [
        group(i18n('Test spend'), [
          row(i18n('Transaction ID'), test.txid, true),
          row(
            i18n('Output spent'),
            `${first}, ${sat(smallest.amount_msat)} sat`,
          ),
          row(i18n('Signature hash types'), testSighashes.join(', ')),
          row(i18n('Raw transaction'), test.tx, true),
        ]),
      ]
      if (!testSighashes.every((s) => s === unifiedSighash)) {
        await audit('split-stopped', { txid: test.txid, testSighashes })
        return {
          version: '1',
          title: i18n('Split stopped after the test spend'),
          message: i18n(
            'STOPPED: the test spend ${txid} is not signed with the BLAKE2b-only signature hash (types: ${types}). It may be valid on the other chain as well, so the rest of the wallet was left alone.',
            { txid: test.txid, types: testSighashes.join(', ') },
          ),
          result: { type: 'group', value: rows },
        }
      }

      // Everything else. minconf=1 leaves the unconfirmed test output out.
      let rest: Withdrawn | null = null
      let restError: string | null = null
      if (outputs.length > 1) {
        try {
          rest = await tools.lightning<Withdrawn>(
            'withdraw',
            { destination: await address(), satoshi: 'all', feerate },
            300_000,
          )
          await saveRawTx('split', rest.txid, rest.tx)
        } catch (e) {
          restError = e instanceof Error ? e.message : String(e)
        }
      }
      let reserveKept = keepsReserve(testDecoded)
      if (rest) {
        const restDecoded = await decode(tools, rest.tx)
        reserveKept ||= keepsReserve(restDecoded)
        rows.push(
          group(i18n('Remaining outputs'), [
            row(i18n('Transaction ID'), rest.txid, true),
            row(
              i18n('Signature hash types'),
              sighashes(restDecoded).join(', '),
            ),
            row(i18n('Raw transaction'), rest.tx, true),
          ]),
        )
      }
      await audit('split-result', {
        test: test.txid,
        rest: rest?.txid,
        restError,
      })

      const left = (await funds()).filter(spendable)
      const leftSat = walletTotals(left).confirmed
      rows.push(
        row(i18n('Left unsplit'), `${leftSat} sat in ${left.length} output(s)`),
      )

      return {
        version: '1',
        title: restError ? i18n('Split incomplete') : i18n('Split broadcast'),
        message: [
          i18n(
            'Test spend ${txid} broadcast, signed for the BLAKE2b chain only.',
            { txid: test.txid },
          ),
          ...(rest
            ? [
                i18n('The remaining outputs were swept in ${txid}.', {
                  txid: rest.txid,
                }),
              ]
            : []),
          ...(restError
            ? [
                i18n('Sweeping the remaining outputs failed: ${error}', {
                  error: literal(restError),
                }),
              ]
            : []),
          ...(reserveKept
            ? [
                i18n(
                  'Core Lightning kept ${reserve} sat in this wallet as a change output: its reserve for fee-bumping while a channel with anchor outputs is unresolved. That output was made by the split transaction, so it is split too; it becomes spendable once every channel has been forgotten.',
                  { reserve: String(anchorReserveSat) },
                ),
              ]
            : []),
          ...(leftSat
            ? [
                i18n(
                  '${amount} sat were NOT moved and are still spendable on both chains. Run this action again.',
                  { amount: String(leftSat) },
                ),
              ]
            : []),
          i18n(
            'Wait for the transactions to confirm before Recovery: Finish. Until then the same coins can still be moved on the other chain with an old transaction.',
          ),
        ].join('\n\n'),
        result: { type: 'group', value: rows },
      }
    })
  },
)
