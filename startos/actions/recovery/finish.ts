import { T } from '@start9labs/start-sdk'
import { storeJson } from '../../fileModels/store.json'
import { i18n } from '../../i18n'
import { walletDrift } from '../../recovery/replay'
import { audit } from '../../recovery/snapshot'
import { withTools } from '../../recovery/tools'
import { sdk } from '../../sdk'

const { InputSpec, Value } = sdk

export const recoveryFinish = sdk.Action.withInput(
  'recovery-finish',

  async ({ effects }) => ({
    name: i18n('Recovery: Finish'),
    description: i18n(
      'Leaves recovery mode: turns off offline and developer mode, drops a rescan that has not run yet, deletes the gossip store gathered on the other chain, and restarts Core Lightning online.',
    ),
    warning: i18n(
      'Core Lightning reconnects to its peers. Only finish once Recovery: Status shows that the wallet agrees with the backend.',
    ),
    allowedStatuses: 'any',
    group: i18n('Recovery'),
    visibility: 'enabled',
  }),

  InputSpec.of({
    force: Value.toggle({
      name: i18n('Finish Although The Wallet Disagrees'),
      description: i18n(
        'Leave recovery mode even though the wallet still disagrees with the backend, or cannot be checked because Core Lightning is not running.',
      ),
      default: false,
    }),
  }),

  async ({ effects }) => ({}),

  async ({ effects, input }): Promise<T.ActionResult & { version: '1' }> => {
    const store = await storeJson.read().once()
    if (!store?.recovery && !store?.offline && !store?.developer) {
      return {
        version: '1',
        title: i18n('Nothing to finish'),
        message: i18n('Recovery mode is off.'),
        result: null,
      }
    }
    if (!input.force) {
      const drift = await withTools(
        effects,
        'recovery-finish',
        async (tools) =>
          (await tools.lightningUp()) ? walletDrift(tools) : null,
      )
      if (!drift) {
        throw new Error(
          i18n(
            'Refused: Core Lightning is not answering, so the wallet cannot be checked against the backend. Start it, or turn on "Finish Although The Wallet Disagrees".',
          ),
        )
      }
      if (drift.phantom.length || drift.restorable.length) {
        throw new Error(
          i18n(
            'Refused: the wallet disagrees with the backend on ${count} output(s). Run Recovery: Status, then Recovery: Repair Wallet, or turn on "Finish Although The Wallet Disagrees".',
            { count: String(drift.phantom.length + drift.restorable.length) },
          ),
        )
      }
    }

    await audit('finish', { forced: input.force })
    // main deletes the gossip store on its next start (wipeGossip); changing
    // offline/developer is what restarts a running service.
    await storeJson.merge(effects, {
      recovery: false,
      offline: false,
      developer: false,
      rescan: undefined,
      wipeGossip: true,
    })
    return {
      version: '1',
      title: i18n('Recovery finished'),
      message: i18n(
        'Recovery mode is off. If Core Lightning is running it restarts now, online, with an empty gossip store; if it is stopped, that happens at its next start.',
      ),
      result: null,
    }
  },
)
