import { T } from '@start9labs/start-sdk'
import { readFile, rm } from 'fs/promises'
import { storeJson } from '../../fileModels/store.json'
import { i18n } from '../../i18n'
import {
  archivePath,
  finishMove,
  finishPrecheck,
  finishRefusedPath,
  lightningdGone,
  Refusal,
} from '../../recovery/finish'
import { literal, row } from '../../recovery/report'
import { audit, host } from '../../recovery/snapshot'
import {
  finishReadyPath,
  readRecovery,
  readyToFinish,
} from '../../recovery/status'
import { withChains } from '../../recovery/tools'
import { sdk } from '../../sdk'

const { InputSpec, Value } = sdk

/** How old the last Status may be for Finish to trust it. */
const readyMaxAgeMs = 6 * 60 * 60 * 1000

/**
 * How long the action waits for a lightningd that is shutting down, when the
 * service was stopped just before. StartOS ends an action after 120 s.
 */
const goneInActionMs = 60_000

export const recoveryFinish = sdk.Action.withInput(
  'recovery-finish',

  async ({ effects }) => ({
    name: i18n('Recovery: Finish'),
    description: i18n(
      "Ends the recovery once the SHA256d chain holds nothing of this node's: moves the BLAKE2b instance's data into place, archives the SHA256d data under recovery/sha256d, deletes the database copies (every copy is a risk and no longer of any value), and sets the node to run on the BLAKE2b chain alone, online, on the bitcoind service. Core Lightning is restarted for it by this action; if it is stopped, start it afterwards.",
    ),
    warning: i18n(
      'Only finish once Recovery: Status says so. Afterwards the node reconnects to its peers on the BLAKE2b chain, and the SHA256d side is no longer watched.',
    ),
    allowedStatuses: 'any',
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
    const options = { force: input.force, keepCopies: input['keep-copies'] }
    // Stopped means the user asked for it; anything else (running, starting,
    // restarting, a crash loop) has, or soon has, a lightningd on the data.
    const status = await effects.getStatus({})
    const stopped = status?.desired.main === 'stopped'

    // The last Status: it ran with the service up and checked both chains.
    const ready = await readFile(host(finishReadyPath), 'utf-8').then(
      (s) => JSON.parse(s) as { at: string; ready: boolean; reasons: string[] },
      () => null,
    )
    const age = ready ? Date.now() - Date.parse(ready.at) : Infinity
    const fresh = !!ready && age <= readyMaxAgeMs

    try {
      let restart = false
      const result = await withChains(
        effects,
        'recovery-finish',
        async (chains) => {
          let checked = ready
            ? `${ready.at}, ${ready.ready ? 'ready' : 'not ready'}`
            : '-'
          if (!input.force) {
            let reasons: string[] | null = fresh ? ready!.reasons : null
            // No recent Status: read both chains now, which needs the daemons.
            if (!reasons && !stopped) {
              reasons = readyToFinish(await readRecovery(chains))
              checked = `${new Date().toISOString()}, ${reasons.length ? 'not ready' : 'ready'}`
            }
            if (!reasons) {
              throw new Refusal(
                i18n(
                  'Refused: Core Lightning is stopped and there is no Recovery: Status from the last six hours. Start Core Lightning and run Recovery: Finish again; or turn on "Finish Although Not Ready".',
                ),
              )
            }
            if (reasons.length) {
              throw new Refusal(
                i18n('Refused: not ready to finish: ${reasons}', {
                  reasons: literal(reasons.join(' ')),
                }),
              )
            }
          }
          if (!stopped) {
            // (Stopped: finishMove runs this check below, once lightningd is
            // known to be gone.)
            await finishPrecheck(chains)
            // The data cannot be moved under a running lightningd, and this
            // action is ended after 120 s: main does the move at its next
            // start, before it starts any daemon.
            restart = true
            return {
              version: '1' as const,
              title: i18n('Finishing the recovery'),
              message: i18n(
                'Every check passed. Core Lightning is restarting now: it moves to the BLAKE2b chain before it starts again, and nothing else is needed from you. Run Recovery: Status in a few minutes; it says "Recovery is finished" once the move is done, and names the reason if it could not be done.',
              ),
              result: {
                type: 'group' as const,
                value: [row(i18n('Readiness checked'), checked)],
              },
            }
          }

          if (!(await lightningdGone(chains, goneInActionMs))) {
            throw new Refusal(
              i18n(
                'Refused: Core Lightning is still shutting down. Nothing was changed; run Recovery: Finish again in a minute.',
              ),
            )
          }
          const done = await finishMove(effects, chains, options)
          return {
            version: '1' as const,
            title: i18n('Recovery finished'),
            message: i18n(
              'The node now runs on the BLAKE2b chain alone, following the bitcoind service. Start Core Lightning: it starts online, with an empty gossip store. The SHA256d data is archived under ${archive}; the BLAKE2b build of Core Lightning can be installed over this package when you like.',
              { archive: literal(archivePath) },
            ),
            result: {
              type: 'group' as const,
              value: [
                row(i18n('Archived'), done.archive),
                row(
                  i18n('Database copies deleted'),
                  done.deleted.join(', ') || '-',
                ),
                row(i18n('Last Recovery: Status'), checked),
              ],
            },
          }
        },
      )
      if (restart) {
        // Only once the temporary subcontainer of the checks is gone: the
        // restart tears the service's containers down.
        await rm(host(finishRefusedPath), { force: true })
        await audit('finish-requested', options)
        await storeJson.merge(effects, {
          finish: { ...options, at: new Date().toISOString() },
        })
        await sdk.restart(effects)
      }
      return result
    } catch (e) {
      // A refusal is an answer, not a failure of the action.
      if (e instanceof Refusal) throw new Error(e.message)
      throw e
    }
  },
)
