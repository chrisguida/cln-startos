import { storeJson } from '../../fileModels/store.json'
import { i18n } from '../../i18n'
import { audit } from '../../recovery/snapshot'
import { sdk } from '../../sdk'

const { InputSpec, Value } = sdk

export const recoveryOffline = sdk.Action.withInput(
  'recovery-offline',

  async ({ effects }) => ({
    name: i18n('Recovery: Offline Mode'),
    description: i18n(
      'Starts Core Lightning with --offline: it connects to no peer and accepts no connection, so channels cannot change while you work on a recovery. It still follows the Bitcoin backend and still broadcasts on-chain transactions.',
    ),
    warning: i18n(
      'Core Lightning restarts. While offline it cannot pay, be paid, or close a channel cooperatively.',
    ),
    allowedStatuses: 'any',
    group: i18n('Recovery'),
    visibility: 'enabled',
  }),

  InputSpec.of({
    offline: Value.toggle({
      name: i18n('Offline'),
      description: i18n('Keep Core Lightning disconnected from all peers.'),
      default: false,
    }),
  }),

  async ({ effects }) => ({
    offline: !!(await storeJson.read((s) => s.offline).once()),
  }),

  async ({ effects, input }) => {
    await storeJson.merge(effects, { offline: input.offline })
    await audit('offline', { offline: input.offline })
    return {
      version: '1',
      title: i18n('Success'),
      message: input.offline
        ? i18n(
            'Offline mode is on. If Core Lightning is running it restarts now without peer connections.',
          )
        : i18n(
            'Offline mode is off. If Core Lightning is running it restarts now and reconnects to its peers.',
          ),
      result: null,
    }
  },
)
