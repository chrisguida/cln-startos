import { FileHelper, z } from '@start9labs/start-sdk'
import { sdk } from '../sdk'

export const bitcoinBackends = ['bitcoind', 'knots-prerdts'] as const
export type BitcoinBackend = (typeof bitcoinBackends)[number]

const shape = z.looseObject({
  // The package id of the Bitcoin service lightningd follows.
  bitcoinBackend: z.enum(bitcoinBackends).catch('bitcoind'),
  // Regtest only: where the BLAKE2b test chain parts from this one. Stock
  // lightningd has no option for it; the Recovery actions read it.
  blake2bActivationHeight: z.number().optional().catch(undefined),
  // Persisted --offline: no peer connections until it is turned off again.
  offline: z.boolean().catch(false),
  rescan: z.number().optional().catch(undefined),
  watchtowerServer: z.boolean().catch(false),
  watchtowerClients: z.array(z.string()).catch([]),
  watchtowerLabels: z
    .array(z.looseObject({ id: z.string(), label: z.string() }))
    .catch([]),
  restore: z.boolean().optional().catch(undefined),
  customExternalHosts: z.array(z.string()).catch([]),
  // Verbatim: the companion's task compares it byte for byte.
  clearnetVpn: z
    .looseObject({
      config: z.string(),
      announce: z.string().nullable().catch(null),
    })
    .nullable()
    .catch(null),
})

export const storeJson = FileHelper.json(
  { base: sdk.volumes.main, subpath: '/store.json' },
  shape,
)
