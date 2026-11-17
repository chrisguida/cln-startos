import { T } from '@start9labs/start-sdk'
import { i18n } from '../../i18n'
import {
  describeFee,
  feerateInput,
  mempoolFee,
  resolveFeerate,
  storedEstimates,
} from '../../recovery/fees'
import { WalletOutput, walletTotals } from '../../recovery/node'
import { group, literal, row, stillRunning } from '../../recovery/report'
import { audit, saveRawTx } from '../../recovery/snapshot'
import { spendable } from '../../recovery/status'
import { slow, Tools, withChains } from '../../recovery/tools'
import { sdk } from '../../sdk'
import { anchorReserveSat } from './withdraw'

const { InputSpec, Value } = sdk

/** SIGHASH_ALL with the unified flag: valid on the BLAKE2b chain only. */
const unifiedSighash = '21'

type Decoded = {
  txid: string
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

const msatNumber = (v: number | string) =>
  typeof v === 'number' ? v : parseInt(String(v), 10)

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e))

/**
 * The weight fundpsbt does not add itself: the transaction's fixed fields
 * (version, locktime, counts, segwit marker: 42) and the one P2TR output
 * (8 + 1 + 34 bytes: 172).
 */
const startweight = 214

export const recoverySplit = sdk.Action.withInput(
  'recovery-split',

  async ({ effects }) => ({
    name: i18n('Recovery: Split Coins'),
    description: i18n(
      "Moves the BLAKE2b instance's whole on-chain balance in one transaction that is valid on the BLAKE2b chain only, so that the coins on the two chains can no longer be spent by one transaction. The transaction is built and signed first, and sent only once every input is seen to carry the BLAKE2b-only signature hash; otherwise nothing is sent. Afterwards Withdraw can send the SHA256d coins.",
    ),
    warning: [
      i18n(
        'Run it once Recovery: Status shows the BLAKE2b wallet in agreement with its chain. This spends the whole confirmed on-chain balance of the BLAKE2b instance.',
      ),
      await storedEstimates(effects, 'blake2b'),
    ].join(' '),
    allowedStatuses: 'only-running',
    group: i18n('Recovery'),
    visibility: 'enabled',
  }),

  InputSpec.of({
    destination: Value.text({
      name: i18n('Destination Address (optional)'),
      description: i18n(
        'Where to send the coins on the BLAKE2b chain. Leave empty to send them to fresh addresses of this node.',
      ),
      required: false,
      default: null,
      placeholder: 'bc1…',
    }),
    feerate: feerateInput(),
  }),

  async ({ effects }) => ({}),

  async ({ effects, input }): Promise<T.ActionResult & { version: '1' }> => {
    const given = input.destination?.trim() || null
    return withChains(effects, 'recovery-split', async (chains) => {
      const tools = chains.blake2b
      if (!tools) {
        throw new Error(
          i18n(
            'Refused: the BLAKE2b instance has not been started. Run Recovery: Close All Channels first.',
          ),
        )
      }
      if (!(await tools.lightningUp())) {
        throw new Error(i18n('The BLAKE2b instance is not answering.'))
      }
      const fee = await resolveFeerate(tools, input.feerate)
      const feerate = fee.param
      const funds = async () =>
        (
          await tools.lightning<{ outputs: WalletOutput[] }>(
            'listfunds',
            {},
            slow,
          )
        ).outputs

      const outputs = (await funds()).filter(spendable)
      if (!outputs.length) {
        return {
          version: '1',
          title: i18n('Nothing to split'),
          message: i18n(
            'The BLAKE2b wallet has no confirmed, unreserved output.',
          ),
          result: null,
        }
      }
      const total = walletTotals(outputs).confirmed
      await audit('split', {
        feerate,
        destination: given,
        estimates: fee.estimates,
        outputs: outputs.length,
        total,
      })

      // One transaction for everything, built and signed inside lightningd.
      // Nothing is broadcast until every input is seen to carry the
      // BLAKE2b-only sighash, so a wrongly signed transaction costs nothing.
      let psbt: string
      let excessSat: number
      try {
        const funded = await tools.lightning<{
          psbt: string
          excess_msat: number | string
          change_outnum?: number
          estimated_final_weight: number
        }>(
          'fundpsbt',
          { satoshi: 'all', feerate, startweight, reserve: 72 },
          slow,
        )
        psbt = funded.psbt
        excessSat = Math.floor(msatNumber(funded.excess_msat) / 1000)
      } catch (e) {
        const running = stillRunning('fundpsbt', e)
        if (running) return running
        throw new Error(
          i18n(
            'Building the transaction failed, and nothing was spent: ${error}',
            { error: literal(errorText(e)) },
          ),
        )
      }
      const release = () =>
        tools.lightning('unreserveinputs', { psbt }).catch(() => {})

      try {
        const destination =
          given ??
          (
            await tools.lightning<{ p2tr: string }>('newaddr', {
              addresstype: 'p2tr',
            })
          ).p2tr
        psbt = (
          await tools.lightning<{ psbt: string }>('addpsbtoutput', {
            satoshi: `${excessSat}sat`,
            initialpsbt: psbt,
            destination,
          })
        ).psbt
        psbt = (
          await tools.lightning<{ signed_psbt: string }>(
            'signpsbt',
            { psbt },
            slow,
          )
        ).signed_psbt
      } catch (e) {
        const running = stillRunning('signpsbt', e)
        if (running) return running
        await release()
        throw new Error(
          i18n(
            'Signing the transaction failed, and nothing was spent: ${error}. If the BLAKE2b instance stopped, it refused to sign: check its logs before trying again.',
            { error: literal(errorText(e)) },
          ),
        )
      }

      // Read the signatures back through the backend (PSBT version 0 for it).
      let decoded: Decoded
      try {
        const v0 = (
          await tools.lightning<{ psbt: string }>('setpsbtversion', {
            psbt,
            version: 0,
          })
        ).psbt
        const final = await tools.bitcoin<{ hex?: string; complete: boolean }>(
          'finalizepsbt',
          [v0, true],
        )
        if (!final.complete || !final.hex) {
          throw new Error('the backend could not finalize the signed PSBT')
        }
        decoded = await decode(tools, final.hex)
      } catch (e) {
        await release()
        throw new Error(
          i18n(
            'The signed transaction could not be checked, so it was not sent and its inputs were released: ${error}',
            { error: literal(errorText(e)) },
          ),
        )
      }
      const types = sighashes(decoded)
      const rows: T.ActionResultMember[] = [
        row(i18n('Transaction ID'), decoded.txid, true),
        row(
          i18n('Coins moved'),
          `${decoded.vin.length} input(s), ${total} sat, to ${excessSat} sat`,
        ),
        row(i18n('Signature hash types'), types.join(', ')),
        row(i18n('Feerate'), fee.source),
      ]
      if (!types.every((s) => s === unifiedSighash)) {
        await release()
        await audit('split-stopped', { txid: decoded.txid, types })
        return {
          version: '1',
          title: i18n('Split stopped before broadcast'),
          message: i18n(
            'STOPPED: the signed transaction ${txid} does not carry the BLAKE2b-only signature hash on every input (types: ${types}). It would be valid on the other chain as well, so it was NOT sent and its inputs were released. Nothing was spent.',
            { txid: decoded.txid, types: types.join(', ') },
          ),
          result: { type: 'group', value: rows },
        }
      }

      let sent: { tx: string; txid: string }
      try {
        sent = await tools.lightning<{ tx: string; txid: string }>(
          'sendpsbt',
          { psbt },
          slow,
        )
      } catch (e) {
        const running = stillRunning('sendpsbt', e)
        if (running) return running
        await release()
        throw new Error(
          i18n(
            'Broadcasting the transaction failed, and its inputs were released: ${error}',
            { error: literal(errorText(e)) },
          ),
        )
      }
      await saveRawTx('split', sent.txid, sent.tx)
      rows.push(
        row(i18n('Fee paid'), describeFee(await mempoolFee(tools, sent.txid))),
        row(i18n('Raw transaction'), sent.tx, true),
      )
      const reserveKept = keepsReserve(decoded)
      await audit('split-result', {
        txid: sent.txid,
        inputs: decoded.vin.length,
        types,
        reserveKept,
      })

      const left = (await funds()).filter(spendable)
      const leftSat = walletTotals(left).confirmed
      rows.push(
        row(i18n('Left unsplit'), `${leftSat} sat in ${left.length} output(s)`),
      )

      return {
        version: '1',
        title: i18n('Split broadcast'),
        message: [
          i18n(
            'Split ${txid} broadcast: ${count} coin(s) worth ${amount} sat moved in one transaction, every input signed for the BLAKE2b chain only (checked before sending).',
            {
              txid: sent.txid,
              count: String(decoded.vin.length),
              amount: String(total),
            },
          ),
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
            'Wait for the transaction to confirm, then run Recovery: Status: Withdraw can then send the SHA256d coins.',
          ),
        ].join('\n\n'),
        result: { type: 'group', value: rows },
      }
    })
  },
)
