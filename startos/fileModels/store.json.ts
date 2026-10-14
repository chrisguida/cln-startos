import { FileHelper, z } from '@start9labs/start-sdk'
import { sdk } from '../sdk'

const shape = z.object({
  rescan: z.number().optional().catch(undefined),
  watchtowerServer: z.boolean().catch(false),
  watchtowerClients: z.array(z.string()).catch([]),
  restore: z.boolean().optional().catch(undefined),
  customExternalHosts: z.array(z.string()).catch([]),
  // Recovery mode: set when this build arrives on the data of the stock
  // build, cleared by Recovery: Finish. `offline` and `developer` are standing
  // lightningd flags while it lasts; `wipeGossip` is a one-shot for main.
  recovery: z.boolean().catch(false),
  offline: z.boolean().catch(false),
  developer: z.boolean().catch(false),
  wipeGossip: z.boolean().optional().catch(undefined),
})

export const storeJson = FileHelper.json(
  { base: sdk.volumes.main, subpath: '/store.json' },
  shape,
)
