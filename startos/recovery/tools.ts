import { T } from '@start9labs/start-sdk'
import { lightningNetwork } from '../fileModels/config'
import { sdk } from '../sdk'
import {
  bitcoinBackend,
  bitcoinDataDir,
  bitcoindRpcBridge,
  mountsWithBitcoin,
  rootDir,
} from '../utils'

/**
 * An `exec` in an action is SIGKILLed after 30 s unless a timeout is given.
 * Everything here states one: short calls get `quick`, calls that scale with
 * the wallet or wait on a peer get their own.
 */
export const quick = 60_000

export class CliError extends Error {
  constructor(
    message: string,
    /** bitcoind's RPC error code, when it printed one. */
    readonly code: number | null,
    /** The client was killed at its timeout: the daemon may still be working. */
    readonly timedOut: boolean,
  ) {
    super(message)
  }
}

type Param = string | number | boolean | null | object

export type Tools = {
  /** `bitcoin` or `regtest`: also the subdirectory holding the wallet. */
  network: string
  /** Package id of the Bitcoin service the calls go to. */
  backend: string
  /** lightning-cli with keyword parameters. Throws CliError. */
  lightning: <R>(
    method: string,
    params?: Record<string, Param | undefined>,
    timeoutMs?: number,
  ) => Promise<R>
  /** Whether lightningd answers RPC. */
  lightningUp: () => Promise<boolean>
  /** bitcoin-cli against the backend, result parsed as JSON. Throws CliError. */
  bitcoin: <R>(
    method: string,
    params?: Param[],
    timeoutMs?: number,
  ) => Promise<R>
  /** bitcoin-cli for the calls that print a bare string (hashes, raw hex). */
  bitcoinText: (method: string, params?: Param[]) => Promise<string>
  /** A read-only query on lightningd's database; works with lightningd stopped. */
  sqlite: <R>(sql: string) => Promise<R[]>
  /** Copies lightningd's database with SQLite's online backup API. */
  sqliteBackup: (dest: string) => Promise<void>
}

const text = (out: string | Buffer) => String(out).trim()

const databasePath = (network: string) =>
  `${rootDir}/${network}/lightningd.sqlite3`

/**
 * Runs `fn` with lightning-cli, bitcoin-cli and sqlite3 in a temporary
 * subcontainer of the lightning image. It needs neither lightningd nor a
 * running service: only the calls that reach a daemon fail without it.
 */
export async function withTools<R>(
  effects: T.Effects,
  name: string,
  fn: (tools: Tools) => Promise<R>,
): Promise<R> {
  const network = await lightningNetwork()
  const backend = await bitcoinBackend()
  const bridge = await bitcoindRpcBridge(effects, false)

  return sdk.SubContainer.withTemp(
    effects,
    { imageId: 'lightning' },
    mountsWithBitcoin(backend),
    name,
    async (sub) => {
      const run = async (command: string[], timeoutMs: number) => {
        const res = await sub.exec(command, { timeout: timeoutMs })
        return {
          ok: res.exitCode === 0,
          timedOut: res.timedOutAfter !== null,
          stdout: text(res.stdout),
          stderr: text(res.stderr),
        }
      }

      const lightning = async <R>(
        method: string,
        params: Record<string, Param | undefined> = {},
        timeoutMs = quick,
      ): Promise<R> => {
        // Every value goes over as a JSON literal: lightning-cli would
        // otherwise read an all-digit string as a number.
        const args = Object.entries(params).flatMap(([k, v]) =>
          v === undefined ? [] : [`${k}=${JSON.stringify(v)}`],
        )
        const res = await run(
          [
            'lightning-cli',
            `--lightning-dir=${rootDir}`,
            '-k',
            method,
            ...args,
          ],
          timeoutMs,
        )
        // An RPC error is a JSON object on stdout with exit code 1, sometimes
        // after `# ...` progress lines.
        const start = res.stdout.indexOf('{')
        let parsed: unknown = null
        try {
          parsed = start < 0 ? null : JSON.parse(res.stdout.slice(start))
        } catch {
          parsed = null
        }
        if (res.ok && parsed !== null) return parsed as R
        const rpcError = parsed as { message?: unknown } | null
        throw new CliError(
          res.timedOut
            ? `lightning-cli ${method}: no answer after ${timeoutMs / 1000} s`
            : `lightning-cli ${method}: ${
                rpcError?.message
                  ? String(rpcError.message)
                  : res.stdout || res.stderr || 'failed'
              }`,
          null,
          res.timedOut,
        )
      }

      const bitcoinText = async (
        method: string,
        params: Param[] = [],
        timeoutMs = quick,
      ) => {
        if (!bridge) {
          throw new CliError(
            `The Bitcoin service (${backend}) is not reachable over the bridge`,
            null,
            false,
          )
        }
        const res = await run(
          [
            'bitcoin-cli',
            `-rpcconnect=${bridge.host}`,
            `-rpcport=${bridge.port}`,
            `-rpccookiefile=${bitcoinDataDir}/.cookie`,
            `-rpcclienttimeout=${Math.ceil(timeoutMs / 1000)}`,
            method,
            ...params.map((p) =>
              typeof p === 'string' ? p : JSON.stringify(p),
            ),
          ],
          timeoutMs + 5_000,
        )
        if (res.ok) return res.stdout
        // "error code: -26\nerror message:\nnon-BIP68-final"
        const code = res.stderr.match(/^error code: (-?\d+)/m)?.[1]
        const message = res.stderr.split(/^error message:\n/m)[1]
        throw new CliError(
          res.timedOut
            ? `bitcoin-cli ${method}: no answer after ${timeoutMs / 1000} s`
            : (message ?? res.stderr ?? 'failed').trim(),
          code === undefined ? null : Number(code),
          res.timedOut,
        )
      }

      return fn({
        network,
        backend,
        lightning,
        lightningUp: () =>
          lightning('getinfo', {}, 10_000).then(
            () => true,
            () => false,
          ),
        bitcoin: async <R>(
          method: string,
          params?: Param[],
          timeoutMs?: number,
        ) => JSON.parse(await bitcoinText(method, params, timeoutMs)) as R,
        bitcoinText,
        sqlite: async <R>(sql: string) => {
          const res = await run(
            [
              'sqlite3',
              '-readonly',
              '-json',
              '-cmd',
              '.timeout 10000',
              databasePath(network),
              sql,
            ],
            quick,
          )
          if (!res.ok) {
            throw new CliError(
              `sqlite3: ${res.stderr || 'failed'}`,
              null,
              res.timedOut,
            )
          }
          return (res.stdout ? JSON.parse(res.stdout) : []) as R[]
        },
        sqliteBackup: async (dest: string) => {
          // No timeout: the copy is as long as the database is large, and
          // killing it would leave a truncated file behind.
          const res = await sub.exec(
            [
              'sqlite3',
              '-readonly',
              '-cmd',
              '.timeout 60000',
              databasePath(network),
              `.backup '${dest}'`,
            ],
            { timeout: null },
          )
          if (res.exitCode !== 0 || text(res.stderr)) {
            throw new CliError(
              `sqlite3 .backup: ${text(res.stderr) || 'failed'}`,
              null,
              false,
            )
          }
        },
      })
    },
  )
}
