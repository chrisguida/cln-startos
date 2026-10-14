import { T } from '@start9labs/start-sdk'
import { i18n } from '../../i18n'
import { splitHeights } from '../../recovery/chain'
import { WalletTx } from '../../recovery/node'
import {
  isDone,
  readSaved,
  replayOne,
  selectChannelTxs,
  Verdict,
} from '../../recovery/replay'
import { literal, group, row } from '../../recovery/report'
import { audit } from '../../recovery/snapshot'
import { withTools } from '../../recovery/tools'
import { sdk } from '../../sdk'

const { InputSpec, Value } = sdk

const describe = (v: Verdict): string => {
  switch (v.kind) {
    case 'confirmed':
      return i18n('Already in a block on this chain.')
    case 'mempool':
      return i18n(
        'Already in the mempool of this backend; waiting for a block.',
      )
    case 'sent':
      return i18n('Broadcast (${fee}). Waiting for a block.', {
        fee: v.fee ?? '-',
      })
    case 'acceptable':
      return i18n('Dry run: would be accepted (${fee}).', { fee: v.fee ?? '-' })
    case 'wait-blocks':
      return i18n(
        'Not yet: its relative locktime (CSV delay) has not passed. Wait ${blocks} block(s) and run this action again.',
        { blocks: String(v.blocks) },
      )
    case 'wait-parent':
      return i18n(
        'Not yet: it spends a transaction above that is not on this chain yet. Run this action again afterwards.',
      )
    case 'wait-height':
      return i18n(
        'Not yet: its locktime is height ${height}. Run this action again once the chain has reached it.',
        { height: String(v.height) },
      )
    case 'fee-too-low':
      return i18n(
        'REFUSED BY THE BACKEND: its fee is below the relay floor of 1 sat per vbyte (${detail}). It cannot be replayed as it is.',
        { detail: literal(v.detail) },
      )
    case 'conflict':
      return i18n(
        'Cannot be replayed: its inputs are spent by another transaction on this chain, or unknown to it (${detail}).',
        { detail: literal(v.detail) },
      )
    case 'rejected':
      return i18n('Rejected by the backend: ${detail}.', {
        detail: literal(v.detail),
      })
  }
}

const inputsOf = (t: WalletTx) =>
  t.inputs.map((i) => `${i.txid}:${i.index}`).join(', ')

export const recoveryReplay = sdk.Action.withInput(
  'recovery-replay',

  async ({ effects }) => ({
    name: i18n('Recovery: Replay Closes'),
    description: i18n(
      'Rebroadcasts on this chain the channel closes, and the sweeps of their outputs, that happened on the other chain after the split. Works from the lists the stock build saved under recovery/. Only a transaction whose every input is a channel funding output, or an output of a transaction already selected, is replayed; wallet withdrawals and anything else are listed as skipped. Core Lightning does not have to be running.',
    ),
    warning: i18n(
      'A replayed close pays the channel peer on this chain too, exactly as it did on the other one. Start with a dry run.',
    ),
    allowedStatuses: 'any',
    group: i18n('Recovery'),
    visibility: 'enabled',
  }),

  InputSpec.of({
    'dry-run': Value.toggle({
      name: i18n('Dry Run'),
      description: i18n(
        'Only test each transaction against the backend and report. Turn off to broadcast.',
      ),
      default: true,
    }),
  }),

  async ({ effects }) => ({ 'dry-run': true }),

  async ({ effects, input }): Promise<T.ActionResult & { version: '1' }> =>
    withTools(effects, 'recovery-replay', async (tools) => {
      const dryRun = input['dry-run']
      const heights = await splitHeights(tools.network)
      if (!heights) {
        throw new Error(
          i18n(
            'No split height is known for regtest. Set the BLAKE2b Test Activation Height in General Settings to use the Recovery actions.',
          ),
        )
      }
      const saved = await readSaved()
      if (!saved.sources.length) {
        throw new Error(
          i18n(
            'No saved lists were found under recovery/. Replay Closes needs the lists that Recovery: Snapshot of the stock build writes.',
          ),
        )
      }
      const selection = selectChannelTxs(saved, heights)

      const pending = new Set<string>()
      const counts = { done: 0, acceptable: 0, waiting: 0, failed: 0 }
      const rows: T.ActionResultMember[] = []
      const log: unknown[] = []
      for (const tx of selection.replay) {
        const verdict = await replayOne(tools, tx, dryRun, pending)
        if (!isDone(verdict)) pending.add(tx.hash)
        if (isDone(verdict)) counts.done++
        else if (verdict.kind === 'acceptable') counts.acceptable++
        else if (verdict.kind.startsWith('wait-')) counts.waiting++
        else counts.failed++
        log.push({ txid: tx.hash, verdict })
        rows.push(
          group(tx.hash, [
            row(i18n('Result'), describe(verdict)),
            row(i18n('Spends'), inputsOf(tx)),
            row(
              i18n('Height on the other chain'),
              tx.blockheight ? String(tx.blockheight) : '-',
            ),
          ]),
        )
      }
      await audit(dryRun ? 'replay-dry-run' : 'replay', log)

      const summary = i18n(
        '${total} channel transaction(s) to replay from ${sources}: ${done} on this chain or broadcast, ${acceptable} would be accepted, ${waiting} must wait, ${failed} cannot be replayed. ${shared} below the split are on both chains already.',
        {
          total: String(selection.replay.length),
          sources: literal(saved.sources.join(', ')),
          done: String(counts.done),
          acceptable: String(counts.acceptable),
          waiting: String(counts.waiting),
          failed: String(counts.failed),
          shared: String(selection.shared),
        },
      )
      const next = dryRun
        ? i18n(
            'Nothing was broadcast. Run again with Dry Run off to broadcast.',
          )
        : counts.waiting
          ? i18n(
              'Some transactions must wait. Run this action again later, until none is left waiting.',
            )
          : i18n(
              'Wait until every transaction above is in a block, then run Recovery: Repair Wallet.',
            )

      return {
        version: '1',
        title: dryRun ? i18n('Replay: dry run') : i18n('Replay'),
        message: [
          summary,
          ...(selection.skipped.length
            ? [
                i18n(
                  'SKIPPED: ${count} transaction(s) from after the split are not channel transactions (for example a wallet withdrawal) and are never replayed by this action.',
                  { count: String(selection.skipped.length) },
                ),
              ]
            : []),
          next,
        ].join('\n\n'),
        result: {
          type: 'group',
          value: [
            group(i18n('Channel transactions'), rows),
            group(
              i18n('Skipped'),
              selection.skipped.map((tx) =>
                group(tx.hash, [
                  row(i18n('Spends'), inputsOf(tx)),
                  row(
                    i18n('Height on the other chain'),
                    tx.blockheight ? String(tx.blockheight) : '-',
                  ),
                ]),
              ),
            ),
          ],
        },
      }
    }),
)
