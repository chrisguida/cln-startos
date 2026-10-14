import { T } from '@start9labs/start-sdk'
import { storeJson } from '../../fileModels/store.json'
import { i18n } from '../../i18n'
import {
  chainRows,
  chainVerdict,
  group,
  nodeRows,
  pathVerdict,
  readState,
  row,
} from '../../recovery/report'
import { withTools } from '../../recovery/tools'
import { sdk } from '../../sdk'

export const recoveryStatus = sdk.Action.withoutInput(
  'recovery-status',

  async ({ effects }) => ({
    name: i18n('Recovery: Status'),
    description: i18n(
      'Shows which chain the Bitcoin backend is on, how far this node has followed it, the state of every channel, the on-chain wallet, and which recovery path applies. Changes nothing.',
    ),
    warning: null,
    allowedStatuses: 'any',
    group: i18n('Recovery'),
    visibility: 'enabled',
  }),

  async ({ effects }): Promise<T.ActionResult & { version: '1' }> =>
    withTools(effects, 'recovery-status', async (tools) => {
      const state = await readState(tools)
      const offline = !!(await storeJson.read((s) => s.offline).once())
      return {
        version: '1',
        title: i18n('Recovery: Status'),
        message: [...chainVerdict(tools, state), ...pathVerdict(state)].join(
          '\n\n',
        ),
        result: {
          type: 'group',
          value: [
            group(i18n('Chain'), [
              ...chainRows(tools, state),
              row(i18n('Offline mode'), offline ? 'on' : 'off'),
            ]),
            group(i18n('Channels and wallet'), nodeRows(state)),
          ],
        },
      }
    }),
)
