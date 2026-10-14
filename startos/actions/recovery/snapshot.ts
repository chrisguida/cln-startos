import { T } from '@start9labs/start-sdk'
import { i18n } from '../../i18n'
import { chainRecord, literal, readState, row } from '../../recovery/report'
import { audit, refreshFinal, takeSnapshot } from '../../recovery/snapshot'
import { withTools } from '../../recovery/tools'
import { sdk } from '../../sdk'

export const recoverySnapshot = sdk.Action.withoutInput(
  'recovery-snapshot',

  async ({ effects }) => ({
    name: i18n('Recovery: Snapshot'),
    description: i18n(
      "Writes a timestamped directory under recovery/ on this service's volume with copies of hsm_secret, emergency.recover, the config, a consistent copy of the database, and the lists of transactions, channels and funds. Also refreshes recovery/final, which the BLAKE2b build replays closes from. Take one before closing channels, and a last one after every close has fully resolved.",
    ),
    warning: i18n(
      "The snapshot contains the node's secret key. It stays on this volume and is included in backups of this service. The database copy is as large as the database.",
    ),
    allowedStatuses: 'any',
    group: i18n('Recovery'),
    visibility: 'enabled',
  }),

  async ({ effects }): Promise<T.ActionResult & { version: '1' }> =>
    withTools(effects, 'recovery-snapshot', async (tools) => {
      const state = await readState(tools)
      const record = chainRecord(tools, state)
      const lists = state.lists ? await refreshFinal(tools, record) : null
      const snapshot = await takeSnapshot(tools, record, lists)
      await audit('snapshot', snapshot)
      return {
        version: '1',
        title: i18n('Snapshot written'),
        message: lists
          ? i18n(
              'Snapshot written to ${dir} on the main volume, and recovery/final refreshed.',
              { dir: literal(snapshot.dir) },
            )
          : i18n(
              'Snapshot written to ${dir} on the main volume. Core Lightning is not running, so the lists of transactions, channels and funds are missing and recovery/final was not refreshed: start it and take another snapshot.',
              { dir: literal(snapshot.dir) },
            ),
        result: {
          type: 'group',
          value: [
            row(i18n('Directory'), snapshot.dir, true),
            row(i18n('Files'), snapshot.files.join(', ')),
            row(i18n('Missing'), snapshot.missing.join(', ') || '-'),
            row(
              i18n('Transactions saved'),
              String(lists?.listtransactions.transactions.length ?? 0),
            ),
          ],
        },
      }
    }),
)
