import { T } from '@start9labs/start-sdk'
import { mkdir, readdir, readFile, rename, rm } from 'fs/promises'
import { storeJson } from '../../fileModels/store.json'
import { i18n } from '../../i18n'
import { doNotRestoreText, preRecoveryPath } from '../../recovery/instance'
import { literal, row } from '../../recovery/report'
import {
  audit,
  host,
  recoveryPath,
  snapshotDirs,
  writePrivate,
} from '../../recovery/snapshot'
import { finishReadyPath } from '../../recovery/status'
import { withChains } from '../../recovery/tools'
import { sdk } from '../../sdk'
import { blake2bBackend } from '../../utils'

const { InputSpec, Value } = sdk

/** How old the last Status may be for Finish to trust it. */
const readyMaxAgeMs = 6 * 60 * 60 * 1000

/** Where the SHA256d instance's data goes. */
const archivePath = `${recoveryPath}/sha256d`

const exists = (path: string) =>
  readdir(path).then(
    () => true,
    () => false,
  )

export const recoveryFinish = sdk.Action.withInput(
  'recovery-finish',

  async ({ effects }) => ({
    name: i18n('Recovery: Finish'),
    description: i18n(
      "Ends the recovery once the SHA256d chain holds nothing of this node's: moves the BLAKE2b instance's data into place, archives the SHA256d data under recovery/sha256d, deletes the database copies (every copy is a risk and no longer of any value), and sets the node to run on the BLAKE2b chain alone, online, on the bitcoind service. Stop Core Lightning first; start it afterwards.",
    ),
    warning: i18n(
      'Only finish once Recovery: Status says so. Afterwards the node reconnects to its peers on the BLAKE2b chain, and the SHA256d side is no longer watched.',
    ),
    allowedStatuses: 'only-stopped',
    group: i18n('Recovery'),
    visibility: 'enabled',
  }),

  InputSpec.of({
    force: Value.toggle({
      name: i18n('Finish Although Not Ready'),
      description: i18n(
        'Finish even though the last Recovery: Status did not find every step done, or is older than six hours. The SHA256d wallet must still be empty.',
      ),
      default: false,
    }),
    'keep-copies': Value.toggle({
      name: i18n('Keep the Database Copies'),
      description: i18n(
        'Leave the pre-recovery backup, the snapshots and the archived SHA256d database in place instead of deleting them. hsm_secret, emergency.recover and the saved lists are kept either way.',
      ),
      default: false,
    }),
  }),

  async ({ effects }) => ({}),

  async ({ effects, input }): Promise<T.ActionResult & { version: '1' }> => {
    const store = await storeJson.read().once()
    if (!store?.recovery) {
      return {
        version: '1',
        title: i18n('Nothing to finish'),
        message: i18n('Recovery mode is off.'),
        result: null,
      }
    }
    if (!store.blake2b) {
      throw new Error(
        i18n(
          'Refused: the BLAKE2b instance has not been started, so there is nothing to move into place. Run Recovery: Close All Channels first.',
        ),
      )
    }

    // The last Status: it ran with the service up and checked both chains.
    const ready = await readFile(host(finishReadyPath), 'utf-8').then(
      (s) => JSON.parse(s) as { at: string; ready: boolean; reasons: string[] },
      () => null,
    )
    const age = ready ? Date.now() - Date.parse(ready.at) : Infinity
    if (!input.force) {
      if (!ready || age > readyMaxAgeMs) {
        throw new Error(
          i18n(
            'Refused: no Recovery: Status from the last six hours. Start Core Lightning, run Recovery: Status, stop it, then finish; or turn on "Finish Although Not Ready".',
          ),
        )
      }
      if (!ready.ready) {
        throw new Error(
          i18n(
            'Refused: the last Recovery: Status was not ready to finish: ${reasons}',
            {
              reasons: literal(ready.reasons.join(' ')),
            },
          ),
        )
      }
    }

    return withChains(effects, 'recovery-finish', async (chains) => {
      const sha = chains.sha256d
      const blake = chains.blake2b!
      // The one check that cannot be skipped: coins left in the archived
      // database would be out of reach. 0 available, 1 reserved, 2 spent.
      const [{ n }] = await sha.sqlite<{ n: number }>(
        'SELECT count(*) AS n FROM outputs WHERE status IN (0, 1)',
      )
      if (n > 0) {
        throw new Error(
          i18n(
            'Refused: the SHA256d wallet still has ${count} unspent output(s). Withdraw them first.',
            { count: String(n) },
          ),
        )
      }
      const network = sha.network
      const live = host(network)
      const archive = `${archivePath}/${network}`
      const copy = host(`${recoveryPath}/blake2b/${network}`)
      if (!(await exists(copy))) {
        throw new Error(
          i18n(
            'Refused: the BLAKE2b instance has no data under recovery/blake2b.',
          ),
        )
      }
      if (await exists(host(archive))) {
        throw new Error(
          i18n(
            'Refused: recovery/sha256d already holds data from an earlier Finish. Move it away by hand before running this again.',
          ),
        )
      }

      await audit('finish', {
        forced: input.force,
        keepCopies: input['keep-copies'],
      })
      await mkdir(host(archivePath), { recursive: true, mode: 0o700 })
      // Two renames inside one volume: each is atomic, and a failure between
      // them leaves the node's directory absent, which the next start fails
      // on loudly rather than running the wrong data.
      await rename(live, host(archive))
      await rename(copy, live)
      await rename(
        host(`${recoveryPath}/blake2b/config`),
        host(`${archivePath}/blake2b-instance-config`),
      ).catch(() => {})
      await rm(host(`${recoveryPath}/blake2b`), {
        recursive: true,
        force: true,
      })
      await writePrivate(
        `${archivePath}/DO-NOT-RESTORE.txt`,
        doNotRestoreText(
          'The SHA256d data of this node at the end of its recovery: every channel closed and every coin withdrawn',
          new Date().toISOString(),
        ),
      )

      const deleted: string[] = []
      if (!input['keep-copies']) {
        const databases = [
          `${archive}/lightningd.sqlite3`,
          `${archive}/lightningd.sqlite3-wal`,
          `${archive}/lightningd.sqlite3-shm`,
          `${archive}/gossip_store`,
          `${preRecoveryPath}/lightningd.sqlite3`,
          `${preRecoveryPath}/lightningd.sqlite3-wal`,
          `${preRecoveryPath}/lightningd.sqlite3-shm`,
          ...(await snapshotDirs()).flatMap((d) => [
            `${d}/lightningd.sqlite3`,
            `${d}/blake2b-lightningd.sqlite3`,
          ]),
        ]
        for (const path of databases) {
          const gone = await rm(host(path), { force: false }).then(
            () => true,
            () => false,
          )
          if (gone) deleted.push(path)
        }
      }

      await storeJson.merge(effects, {
        recovery: false,
        blake2b: false,
        blake2bRescan: undefined,
        offline: false,
        rescan: undefined,
        bitcoinBackend: blake2bBackend,
        wipeGossip: true,
      })
      await audit('finish-result', { archive, deleted })
      return {
        version: '1',
        title: i18n('Recovery finished'),
        message: i18n(
          'The node now runs on the BLAKE2b chain alone, following the bitcoind service. Start Core Lightning: it starts online, with an empty gossip store. The SHA256d data is archived under ${archive}; the BLAKE2b build of Core Lightning can be installed over this package when you like.',
          { archive: literal(archivePath) },
        ),
        result: {
          type: 'group',
          value: [
            row(i18n('Archived'), archive),
            row(i18n('Database copies deleted'), deleted.join(', ') || '-'),
            row(
              i18n('Last Recovery: Status'),
              ready
                ? `${ready.at}, ${ready.ready ? 'ready' : 'not ready'}`
                : '-',
            ),
          ],
        },
      }
    })
  },
)
