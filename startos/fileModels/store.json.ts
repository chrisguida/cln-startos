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
  // A recovery is in progress: the primary instance runs the SHA256d build on
  // the node's database, both Bitcoin services are required, and the Recovery
  // actions move the node to the BLAKE2b chain. Set by the migration that
  // installs this build, cleared by Recovery: Finish.
  recovery: z.boolean().catch(false),
  // The BLAKE2b instance exists: a copy of the database taken once every
  // channel close was broadcast, run offline by the fork under
  // recovery/blake2b/. Set by Recovery: Close All Channels; main creates the
  // copy. Cleared by Finish, which moves that data into place.
  blake2b: z.boolean().catch(false),
  // One-shot --rescan for the BLAKE2b instance's first start, from below the
  // split. Cleared only once that instance answers RPC, like `rescan`.
  blake2bRescan: z.number().optional().catch(undefined),
  // What Recovery: Status last read, per chain, already worded: the Split and
  // Withdraw dialogs show it, since their text only changes with the store.
  feeEstimates: z
    .looseObject({
      at: z.string(),
      sha256d: z.string().nullable(),
      blake2b: z.string().nullable(),
    })
    .optional()
    .catch(undefined),
  // One-shot from Recovery: Finish: main deletes the gossip store gathered on
  // the SHA256d chain at its next start.
  wipeGossip: z.boolean().optional().catch(undefined),
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
