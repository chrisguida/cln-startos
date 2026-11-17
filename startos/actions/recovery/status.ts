import { T } from '@start9labs/start-sdk'
import { i18n } from '../../i18n'
import { readRecovery, statusResult } from '../../recovery/status'
import { withChains } from '../../recovery/tools'
import { sdk } from '../../sdk'

export const recoveryStatus = sdk.Action.withoutInput(
  'recovery-status',

  async ({ effects }) => ({
    name: i18n('Recovery: Status'),
    description: i18n(
      'Shows both chains: which chain each Bitcoin service is on, how far each Core Lightning instance has followed it, every channel and coin on each, which coins still exist on both chains, and the one step to take next. Changes nothing.',
    ),
    warning: null,
    allowedStatuses: 'any',
    group: i18n('Recovery'),
    visibility: 'enabled',
  }),

  async ({ effects }): Promise<T.ActionResult & { version: '1' }> =>
    withChains(effects, 'recovery-status', async (chains) =>
      statusResult(await readRecovery(chains), effects),
    ),
)
