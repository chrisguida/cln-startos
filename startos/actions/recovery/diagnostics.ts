import { T } from '@start9labs/start-sdk'
import { i18n } from '../../i18n'
import { diagnosticsText } from '../../recovery/diagnostics'
import { readState } from '../../recovery/report'
import { audit } from '../../recovery/snapshot'
import { withTools } from '../../recovery/tools'
import { sdk } from '../../sdk'
import { statusResult } from './status'

const { InputSpec, Value } = sdk

export const recoveryDiagnostics = sdk.Action.withInput(
  'recovery-diagnostics',

  async ({ effects }) => ({
    name: i18n('Recovery: Export Diagnostics'),
    description: i18n(
      'Writes one file with everything needed to look into a recovery problem: the Status report, the chain comparison, every channel and its close transactions, the wallet, the recovery log and the crash logs. Send it to the person helping you with the recovery. Changes nothing.',
    ),
    warning: i18n(
      'With transaction ids and amounts included, whoever reads the file can see these coins and their history on the chain. Share it only with people you trust, or turn that option off. The file never contains your seed, hsm_secret, runes, passwords or VPN keys.',
    ),
    allowedStatuses: 'any',
    group: i18n('Recovery'),
    visibility: 'enabled',
  }),

  InputSpec.of({
    detail: Value.toggle({
      name: i18n('Include Transaction IDs and Amounts'),
      description: i18n(
        'On: the file shows transaction ids, addresses, short channel ids and amounts, which is usually what it takes to find the cause. Off: they are replaced by placeholders, and the crash log lines are left out.',
      ),
      default: true,
    }),
  }),

  async ({ effects }) => ({}),

  async ({ effects, input }): Promise<T.ActionResult & { version: '1' }> =>
    withTools(effects, 'recovery-diagnostics', async (tools) => {
      const state = await readState(tools)
      const status = await statusResult(tools, state)
      const text = await diagnosticsText(tools, state, status, input.detail)
      await audit('recovery-diagnostics', { detail: input.detail })
      const stamp = new Date().toISOString().replace(/[:.]/g, '-')
      return {
        version: '1',
        title: i18n('Recovery: Export Diagnostics'),
        message: input.detail
          ? i18n(
              'Download the file and send it to the person helping you with the recovery. It includes transaction ids, addresses and amounts.',
            )
          : i18n(
              'Download the file and send it to the person helping you with the recovery. Transaction ids, addresses, short channel ids and amounts are replaced by placeholders.',
            ),
        result: {
          type: 'multiline',
          value: text,
          copyable: true,
          qr: false,
          masked: false,
          filename: `c-lightning-recovery-diagnostics-${stamp}.txt`,
        },
      }
    }),
)
