import {
  appendFile,
  chmod,
  copyFile,
  mkdir,
  readdir,
  readFile,
  rename,
  writeFile,
} from 'fs/promises'
import { rootDir } from '../utils'
import { ChainComparison } from './chain'
import { SplitHeights } from './heights'
import { fetchLists, listMethods, Lists } from './node'
import { Tools } from './tools'

/** The main volume as the action's own process sees it. */
const volume = '/media/startos/volumes/main'
export const recoveryPath = 'recovery'
/** The lists as of the last close, withdraw or snapshot: what the fork stage replays from. */
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

const writeLists = async (dir: string, lists: Lists) => {
  for (const method of listMethods) {
    await writePrivate(`${dir}/${method}.json`, JSON.stringify(lists[method]))
  }
}

export type ChainRecord = {
  takenAt: string
  network: string
  backend: string
  heights: SplitHeights | null
  node: { id: string; version: string; blockheight: number } | null
  chain: ChainComparison | null
}

/**
 * Refreshes recovery/final from the running node. Called after every close
 * and withdraw, because the fork stage needs the raw close and sweep
 * transactions as lightningd last knew them.
 */
export async function refreshFinal(
  tools: Tools,
  record: Omit<ChainRecord, 'takenAt'>,
): Promise<Lists> {
  const lists = await fetchLists(tools)
  await privateDir(recoveryPath)
  await privateDir(finalPath)
  await writeLists(finalPath, lists)
  await writePrivate(
    `${finalPath}/chain.json`,
    JSON.stringify({ ...record, takenAt: new Date().toISOString() }),
  )
  return lists
}

/** Saves a raw transaction next to the final lists. */
export async function saveRawTx(kind: string, txid: string, hex: string) {
  await privateDir(recoveryPath)
  await privateDir(finalPath)
  const path = `${finalPath}/${kind}-${txid}.hex`
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

/**
 * A timestamped copy of everything needed to start over: secrets, config, a
 * consistent copy of the database, and the lists when lightningd is running.
 * Never writes into an existing directory.
 */
export async function takeSnapshot(
  tools: Tools,
  record: Omit<ChainRecord, 'takenAt'>,
  lists: Lists | null,
) {
  const takenAt = new Date().toISOString()
  const dir = `${recoveryPath}/${takenAt.replace(/[:.]/g, '-')}`
  await privateDir(recoveryPath)
  // Not recursive: fails if the directory is already there.
  await mkdir(host(dir), { mode: 0o700 })

  const files: string[] = []
  const missing: string[] = []
  for (const [from, name] of [
    [`${tools.network}/hsm_secret`, 'hsm_secret'],
    [`${tools.network}/emergency.recover`, 'emergency.recover'],
    ['config', 'config'],
  ]) {
    try {
      await copyFile(host(from), host(`${dir}/${name}`))
      await chmod(host(`${dir}/${name}`), 0o600)
      files.push(name)
    } catch {
      missing.push(name)
    }
  }

  // SQLite's online backup API (`sqlite3 .backup`) rather than a file copy: it
  // gives a consistent database whether or not lightningd is running, where
  // copying the file under a running lightningd can catch a half-written page.
  await tools.sqliteBackup(`${rootDir}/${dir}/lightningd.sqlite3`)
  await chmod(host(`${dir}/lightningd.sqlite3`), 0o600)
  files.push('lightningd.sqlite3')

  if (lists) {
    await writeLists(dir, lists)
    files.push(...listMethods.map((m) => `${m}.json`))
  } else {
    missing.push(...listMethods.map((m) => `${m}.json`))
  }
  await writePrivate(
    `${dir}/chain.json`,
    JSON.stringify({ ...record, takenAt }),
  )
  files.push('chain.json')

  return { dir, files, missing }
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
