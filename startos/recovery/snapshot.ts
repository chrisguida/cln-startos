import {
  appendFile,
  chmod,
  mkdir,
  readdir,
  readFile,
  rename,
  writeFile,
} from 'fs/promises'
import { ChainComparison } from './chain'
import { SplitHeights } from './heights'
import { listMethods, Lists } from './node'

/** The main volume as the action's own process sees it. */
const volume = '/media/startos/volumes/main'
export const recoveryPath = 'recovery'
/** The lists the stock build saved after its last close, withdraw or snapshot: what Replay works from. */
export const finalPath = `${recoveryPath}/final`

const host = (path: string) => `${volume}/${path}`

async function privateDir(path: string) {
  await mkdir(host(path), { recursive: true, mode: 0o700 })
  await chmod(host(path), 0o700)
}

/** Writes a file with mode 600, replacing any earlier one in a single rename. */
export async function writePrivate(path: string, content: string) {
  const tmp = `${host(path)}.tmp`
  await writeFile(tmp, content, { mode: 0o600 })
  await rename(tmp, host(path))
}

export type ChainRecord = {
  takenAt: string
  network: string
  backend: string
  heights: SplitHeights | null
  node: { id: string; version: string; blockheight: number } | null
  chain: ChainComparison | null
}

/** Where this build keeps the transactions it made itself. */
export const blake2bPath = `${recoveryPath}/blake2b`

/** Saves a raw transaction this build made on the BLAKE2b chain. */
export async function saveRawTx(kind: string, txid: string, hex: string) {
  await privateDir(recoveryPath)
  await privateDir(blake2bPath)
  const path = `${blake2bPath}/${kind}-${txid}.hex`
  await writePrivate(path, `${hex}\n`)
  return path
}

/** One line per recovery action, so the sequence can be reconstructed later. */
export async function audit(action: string, detail: unknown) {
  await privateDir(recoveryPath)
  const path = host(`${recoveryPath}/actions.log`)
  await appendFile(
    path,
    `${JSON.stringify({ at: new Date().toISOString(), action, detail })}\n`,
    { mode: 0o600 },
  )
}

const readJson = async <R>(path: string): Promise<R | null> =>
  readFile(host(path), 'utf-8').then(
    (s) => JSON.parse(s) as R,
    () => null,
  )

/** The lists saved in one directory, or null if any of them is missing. */
export async function readLists(dir: string): Promise<Lists | null> {
  const lists: Record<string, unknown> = {}
  for (const method of listMethods) {
    const list = await readJson(`${dir}/${method}.json`)
    if (list === null) return null
    lists[method] = list
  }
  return lists as Lists
}

export const readChainRecord = (dir: string) =>
  readJson<ChainRecord>(`${dir}/chain.json`)

/** Timestamped snapshot directories, oldest first. */
export async function snapshotDirs() {
  const names = await readdir(host(recoveryPath)).catch(() => [])
  return names
    .filter((n) => /^\d{4}-\d\d-\d\dT/.test(n))
    .sort()
    .map((n) => `${recoveryPath}/${n}`)
}
