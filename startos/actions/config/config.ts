import { sdk } from '../../sdk'
import { i18n } from '../../i18n'
import { fullConfigSpec, clnConfig } from '../../fileModels/config'
import { storeJson } from '../../fileModels/store.json'
import { teosToml } from '../../fileModels/teos.toml'

export const config = sdk.Action.withInput(
  // id
  'config',

  // metadata
  async ({ effects }) => ({
    name: i18n('General Settings'),
    description: i18n('Set general configuration options for Core Lightning'),
    warning: null,
    allowedStatuses: 'any',
    group: i18n('Configuration'),
    visibility: 'enabled',
  }),

  // form input specification
  fullConfigSpec.filter({
    network: true,
    'bitcoin-backend': true,
    alias: true,
    color: true,
    'tor-only': true,
    'clams-remote-websocket': true,
    'custom-external-host': true,
    'fee-base': true,
    'fee-rate': true,
    'min-capacity': true,
    'funding-confirms': true,
    'bitcoin-retry-timeout': true,
  }),

  // optionally pre-fill the input form
  async ({ effects }) => {
    const conf = await clnConfig.read().once()
    const store = await storeJson.read().once()
    return {
      ...conf,
      network:
        conf?.network?.selection === 'regtest'
          ? {
              selection: 'regtest' as const,
              value: {
                'blake2b-activation-height':
                  store?.blake2bActivationHeight ?? null,
              },
            }
          : conf?.network,
      'bitcoin-backend': store?.bitcoinBackend ?? 'bitcoind',
      'custom-external-host': store?.customExternalHosts[0] ?? null,
    }
  },

  // the execution function. The custom external host lives in store.json, not
  // the config file — watchHosts merges it into announce-addr on every start —
  // and formToFile drops the field, so the same input can feed both writes.
  // The Bitcoin backend and the regtest split height live there too.
  async ({ effects, input }) => {
    const host = input['custom-external-host']?.trim()
    await storeJson.merge(effects, {
      customExternalHosts: host ? [host] : [],
      bitcoinBackend: input['bitcoin-backend'],
      blake2bActivationHeight:
        (input.network.selection === 'regtest' &&
          input.network.value['blake2b-activation-height']) ||
        undefined,
    })
    await clnConfig.merge(effects, input)
    await teosToml.merge(effects, {
      btc_network:
        input.network.selection === 'regtest' ? 'regtest' : 'mainnet',
    })
  },
)
