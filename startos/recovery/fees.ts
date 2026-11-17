import { T } from '@start9labs/start-sdk'
import { storeJson } from '../fileModels/store.json'
import { i18n } from '../i18n'
import { sdk } from '../sdk'
import { backendBlock, splitHeights } from './chain'
import { Tools } from './tools'

const { InputSpec, Value, Variants } = sdk

/**
 * Bitcoin Knots relays nothing below 1 sat/vB (1000 per kvB), per transaction.
 * A transaction that is to be replayed on the other chain must pay that on its
 * own, so the recovery actions refuse anything below this margin above it.
 */
export const minPerkb = 1100
export const relayFloorPerkb = 1000

export const perkb = (rate: number) => `${rate}perkb`

export function assertAboveFloor(rate: number) {
  if (rate < minPerkb) {
    throw new Error(
      i18n(
        'Refused: ${rate} sat per 1000 vbytes is below the minimum of ${min}. A transaction below 1 sat per vbyte is not relayed by Bitcoin Knots and could not be replayed on the other chain.',
        { rate: String(rate), min: String(minPerkb) },
      ),
    )
  }
}

/**
 * The confirmation targets of the node's own estimate, in blocks. They are
 * among the targets lightningd's bcli plugin asks the backend for (2, 6, 12,
 * 100), so each has an estimate of its own rather than an interpolation.
 */
export const feeTargets = { fast: 2, medium: 6, slow: 100 } as const
export type FeeTarget = keyof typeof feeTargets

export const targetName = (target: FeeTarget) =>
  target === 'fast'
    ? i18n('next block or two')
    : target === 'medium'
      ? i18n('within about an hour')
      : i18n('within about a day')

/**
 * The public explorers asked for a second opinion. Which chain each follows
 * is not assumed: its block at the activation height has to be the backend's.
 * They learn only that this address asked for fees.
 */
export const explorerHosts = ['https://mempool.space', 'https://mempool.guide']

/** The explorer's targets, as its /api/v1/fees/recommended names them. */
export const explorerTargets = {
  fastest: 'fastestFee',
  halfHour: 'halfHourFee',
  hour: 'hourFee',
  economy: 'economyFee',
} as const
export type ExplorerTarget = keyof typeof explorerTargets

export const explorerTargetName = (target: ExplorerTarget) =>
  target === 'fastest'
    ? i18n('next block')
    : target === 'halfHour'
      ? i18n('within about half an hour')
      : target === 'hour'
        ? i18n('within about an hour')
        : i18n('economy')

/** The Feerate field of Split and Withdraw: whose estimate, or an explicit rate. */
export const feerateInput = () =>
  Value.union({
    name: i18n('Feerate'),
    description: i18n(
      "Where the rate comes from, read at the moment the action runs. Your node's estimate is private, but needs a Bitcoin backend that has watched transactions confirm for a while. The public explorer's estimate sees the whole mempool, and the explorer learns that your address asked. Recovery: Status shows both so you can compare them. Custom takes an explicit rate.",
    ),
    default: 'explorer',
    variants: Variants.of({
      node: {
        name: i18n('Your node'),
        spec: InputSpec.of({
          target: Value.select({
            name: i18n('Confirm within'),
            default: 'fast',
            values: {
              fast: i18n('Next block or two'),
              medium: i18n('About an hour (6 blocks)'),
              slow: i18n('About a day (100 blocks)'),
            },
          }),
        }),
      },
      explorer: {
        name: i18n('Public explorer'),
        spec: InputSpec.of({
          target: Value.select({
            name: i18n('Confirm within'),
            default: 'fastest',
            values: {
              fastest: i18n('Next block'),
              halfHour: i18n('About half an hour'),
              hour: i18n('About an hour'),
              economy: i18n('Economy'),
            },
          }),
        }),
      },
      custom: {
        name: i18n('Custom'),
        spec: InputSpec.of({
          perkb: Value.number({
            name: i18n('Feerate'),
            description: i18n(
              'An explicit feerate; values below 1100 are refused. Bitcoin Knots relays nothing below 1 sat per vbyte.',
            ),
            required: true,
            default: 3000,
            min: 1,
            integer: true,
            units: 'sat per 1000 vbytes',
          }),
        }),
      },
    }),
  })

export type FeerateChoice =
  | { selection: 'node'; value: { target: FeeTarget } }
  | { selection: 'explorer'; value: { target: ExplorerTarget } }
  | { selection: 'custom'; value: { perkb: number } }

export type ExplorerEstimate = {
  host: string
  /** The explorer's chain tip, if it said. */
  tip: number | null
  /** In sat per vbyte, as the explorer gives them. */
  fees: Record<ExplorerTarget, number>
  minimum: number
}

export type FeeEstimates = {
  /** What the backend relays at all, per kvB. */
  floor: number
  /** Per target, what lightningd would pay to confirm within that many blocks. */
  estimates: { blocks: number; perkb: number }[]
  /** lightningd has no estimate at all ("bitcoind startup?"). */
  missing: boolean
  /** What the backend itself answered for the targets it could not estimate. */
  backendErrors: string[]
  /** Seconds the backend has been running, if it says. */
  uptime: number | null
  /** The public explorer that follows this chain, if one answered. */
  explorer: ExplorerEstimate | null
  /** What became of each explorer asked. */
  explorersTried: string[]
}

const hostName = (host: string) => host.replace(/^https?:\/\//, '')

async function fetchText(url: string): Promise<string> {
  const res = await fetch(url, { signal: AbortSignal.timeout(8000) })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return await res.text()
}

/**
 * The explorer that follows this backend's chain, with its estimate. Each
 * host's block at the activation height is compared with the backend's.
 */
async function explorerEstimate(
  tools: Tools,
): Promise<{ explorer: ExplorerEstimate | null; tried: string[] }> {
  const heights = await splitHeights(tools.network)
  const mine = heights ? await backendBlock(tools, heights.activation) : null
  if (!heights || !mine) {
    return {
      explorer: null,
      tried: [i18n('no activation block to compare with')],
    }
  }
  const results = await Promise.all(
    explorerHosts.map(async (host) => {
      try {
        const hash = (
          await fetchText(`${host}/api/block-height/${heights.activation}`)
        )
          .trim()
          .toLowerCase()
        if (hash !== mine.hash) {
          return {
            host,
            note: i18n('${host}: follows another chain', {
              host: hostName(host),
            }),
            explorer: null,
          }
        }
        const fees = JSON.parse(
          await fetchText(`${host}/api/v1/fees/recommended`),
        ) as Record<string, number>
        const tip = Number(
          await fetchText(`${host}/api/blocks/tip/height`).catch(() => ''),
        )
        const explorer: ExplorerEstimate = {
          host,
          tip: Number.isFinite(tip) && tip > 0 ? tip : null,
          fees: {
            fastest: fees.fastestFee,
            halfHour: fees.halfHourFee,
            hour: fees.hourFee,
            economy: fees.economyFee,
          },
          minimum: fees.minimumFee,
        }
        if (Object.values(explorer.fees).some((f) => !(f > 0))) {
          return {
            host,
            note: i18n('${host}: answered without fee estimates', {
              host: hostName(host),
            }),
            explorer: null,
          }
        }
        return {
          host,
          note: i18n('${host}: follows this chain', { host: hostName(host) }),
          explorer,
        }
      } catch (e) {
        return {
          host,
          note: `${hostName(host)}: ${e instanceof Error ? e.message : String(e)}`,
          explorer: null,
        }
      }
    }),
  )
  return {
    explorer: results.find((r) => r.explorer)?.explorer ?? null,
    tried: results.map((r) => r.note),
  }
}

/**
 * The fee estimates lightningd works from, with the backend's own word on the
 * ones it cannot make (a backend started recently has not watched enough
 * transactions confirm to estimate, and says so), and the public explorer's
 * estimate for comparison.
 */
export async function feeEstimates(tools: Tools): Promise<FeeEstimates | null> {
  const [rates, { explorer, tried }] = await Promise.all([
    tools
      .lightning<{
        perkb: {
          floor: number
          estimates: { blockcount: number; feerate: number }[]
        }
        warning_missing_feerates?: string
      }>('feerates', { style: 'perkb' })
      .catch(() => null),
    explorerEstimate(tools).catch((e) => ({
      explorer: null,
      tried: [e instanceof Error ? e.message : String(e)],
    })),
  ])
  if (!rates) return null
  const backendErrors: string[] = []
  for (const blocks of Object.values(feeTargets)) {
    const r = await tools
      .bitcoin<{
        feerate?: number
        errors?: string[]
      }>('estimatesmartfee', [
        blocks,
        blocks === 2 ? 'CONSERVATIVE' : 'ECONOMICAL',
      ])
      .catch(() => null)
    if (!r) backendErrors.push(`${blocks} blocks: no answer`)
    else if (r.errors?.length)
      backendErrors.push(`${blocks} blocks: ${r.errors.join('; ')}`)
  }
  const uptime = await tools.bitcoin<number>('uptime').catch(() => null)
  return {
    floor: rates.perkb.floor,
    estimates: rates.perkb.estimates.map((e) => ({
      blocks: e.blockcount,
      perkb: e.feerate,
    })),
    missing: !!rates.warning_missing_feerates,
    backendErrors,
    uptime,
    explorer,
    explorersTried: tried,
  }
}

/** lightningd's estimate for exactly this target, or null if it has none. */
export const estimateFor = (est: FeeEstimates | null, target: FeeTarget) =>
  est?.estimates.find((e) => e.blocks === feeTargets[target])?.perkb ?? null

export const satPerVb = (perkb: number) => (perkb / 1000).toFixed(3)

export const describeUptime = (seconds: number | null) =>
  seconds === null
    ? '?'
    : seconds < 3600
      ? `${Math.round(seconds / 60)} min`
      : seconds < 2 * 86400
        ? `${(seconds / 3600).toFixed(1)} h`
        : `${(seconds / 86400).toFixed(1)} d`

const explorerLine = (est: FeeEstimates) =>
  est.explorer
    ? i18n(
        '${host} (follows this chain, tip ${tip}) says: next block ${fastest}, within about half an hour ${halfHour}, within about an hour ${hour}, economy ${economy} sat per vbyte.',
        {
          host: hostName(est.explorer.host),
          tip: est.explorer.tip === null ? '?' : String(est.explorer.tip),
          fastest: String(est.explorer.fees.fastest),
          halfHour: String(est.explorer.fees.halfHour),
          hour: String(est.explorer.fees.hour),
          economy: String(est.explorer.fees.economy),
        },
      )
    : i18n('No public explorer that follows this chain answered (${tried}).', {
        tried: est.explorersTried.join('; '),
      })

/** Whether the node's and the explorer's next-block estimates are more than two to one apart. */
const farApart = (est: FeeEstimates) => {
  const node = estimateFor(est, 'fast')
  const explorer = est.explorer?.fees.fastest
  if (node === null || !explorer) return false
  const ratio = node / (explorer * 1000)
  return ratio > 2 || ratio < 0.5
}

/** The lines for Status: both estimates, or why there is none to trust. */
export function describeEstimates(
  backend: string,
  est: FeeEstimates | null,
): string {
  if (!est) {
    return i18n(
      'FEE ESTIMATES: none. Core Lightning did not answer the feerates call.',
    )
  }
  const have = (t: FeeTarget) => estimateFor(est, t)
  const lacking = (Object.keys(feeTargets) as FeeTarget[]).filter(
    (t) => have(t) === null,
  )
  const uptime = describeUptime(est.uptime)
  const node =
    est.missing || lacking.length
      ? i18n(
          "UNRELIABLE FEE ESTIMATES: ${backend} has no estimate for ${targets} (it says: ${errors}). It has been running for ${uptime} and may need more time to watch transactions confirm. Split and Withdraw refuse those targets of your node until it has one; the explorer's estimate and Custom still work.",
          {
            backend,
            targets: lacking
              .map((t) => `${targetName(t)} (${feeTargets[t]} blocks)`)
              .join(', '),
            errors: est.backendErrors.join(' / ') || '-',
            uptime,
          },
        )
      : i18n(
          'Fee estimates of your node, from ${backend} (sat per vbyte): next block or two ${fast}, within about an hour ${medium}, within about a day ${slow}; it relays nothing below ${floor}. It has been running for ${uptime}.',
          {
            backend,
            fast: satPerVb(have('fast')!),
            medium: satPerVb(have('medium')!),
            slow: satPerVb(have('slow')!),
            floor: satPerVb(est.floor),
            uptime,
          },
        )
  return [
    node,
    explorerLine(est),
    ...(farApart(est)
      ? [
          i18n(
            "NOTE: your node's next-block estimate and the explorer's are more than two to one apart. A backend started recently has seen few transactions confirm, and the explorer's mempool is not your node's. Choose the source you trust.",
          ),
        ]
      : []),
  ].join(' ')
}

/** The same for a result row: every estimate as given. */
export const summarizeEstimates = (est: FeeEstimates | null) =>
  !est
    ? '-'
    : `node: ${est.estimates
        .map((e) => `${e.blocks} blocks ${satPerVb(e.perkb)}`)
        .join(
          ', ',
        )} sat/vB, floor ${satPerVb(est.floor)}, backend up ${describeUptime(
        est.uptime,
      )}${
        est.backendErrors.length
          ? `, backend: ${est.backendErrors.join(' / ')}`
          : ''
      }${est.missing ? ', lightningd: some fee estimates unavailable' : ''}; explorer: ${
        est.explorer
          ? `${hostName(est.explorer.host)} fastest ${est.explorer.fees.fastest}, half hour ${
              est.explorer.fees.halfHour
            }, hour ${est.explorer.fees.hour}, economy ${est.explorer.fees.economy}, minimum ${
              est.explorer.minimum
            } sat/vB, tip ${est.explorer.tip ?? '?'}`
          : `none (${est.explorersTried.join('; ')})`
      }`

export type ResolvedFeerate = {
  /** What lightningd is told. */
  param: string
  /** In sat per kvB. */
  perkb: number
  /** For the result: where the rate came from, and what the other source said. */
  source: string
  /** Both sources' view at the time, for the audit line. */
  estimates: FeeEstimates | null
}

const otherSources = (
  est: FeeEstimates | null,
  used: FeerateChoice['selection'],
) => {
  if (!est) return ''
  const parts: string[] = []
  const node = estimateFor(est, 'fast')
  if (used !== 'node') {
    parts.push(
      node === null
        ? i18n('your node had no next-block estimate')
        : i18n(
            'your node said ${rate} sat per vbyte for the next block or two',
            {
              rate: satPerVb(node),
            },
          ),
    )
  }
  if (used !== 'explorer') {
    parts.push(
      est.explorer
        ? i18n('${host} said ${rate} sat per vbyte for the next block', {
            host: hostName(est.explorer.host),
            rate: String(est.explorer.fees.fastest),
          })
        : i18n('no public explorer answered'),
    )
  }
  return parts.length ? ` (${parts.join('; ')})` : ''
}

/**
 * The feerate a choice comes to right now. A source that has no estimate is
 * refused rather than guessed at: the operator can see both in Status and
 * give an explicit rate.
 */
export async function resolveFeerate(
  tools: Tools,
  choice: FeerateChoice,
): Promise<ResolvedFeerate> {
  const estimates = await feeEstimates(tools)
  if (choice.selection === 'custom') {
    const rate = choice.value.perkb ?? 0
    assertAboveFloor(rate)
    return {
      param: perkb(rate),
      perkb: rate,
      source:
        i18n('custom: ${rate} sat per vbyte', { rate: satPerVb(rate) }) +
        otherSources(estimates, 'custom'),
      estimates,
    }
  }
  if (choice.selection === 'explorer') {
    const target = choice.value.target
    if (!estimates?.explorer) {
      throw new Error(
        i18n(
          "Refused: no public explorer that follows this chain answered (${tried}). Use your node's estimate or Custom.",
          { tried: estimates?.explorersTried.join('; ') || '-' },
        ),
      )
    }
    const given = estimates.explorer.fees[target] * 1000
    const rate = Math.max(given, minPerkb)
    return {
      param: perkb(rate),
      perkb: rate,
      source:
        i18n(
          "${host}'s estimate for ${target}: ${rate} sat per vbyte${raised}",
          {
            host: hostName(estimates.explorer.host),
            target: explorerTargetName(target),
            rate: satPerVb(given),
            raised:
              rate !== given
                ? i18n(', raised to the minimum of ${min}', {
                    min: satPerVb(rate),
                  })
                : '',
          },
        ) + otherSources(estimates, 'explorer'),
      estimates,
    }
  }
  const target = choice.value.target
  const estimate = estimateFor(estimates, target)
  if (estimate === null) {
    throw new Error(
      i18n(
        'Refused: your node has no fee estimate for "${target}" (${blocks} blocks) yet. ${backend} says: ${errors}; it has been running for ${uptime}. Run Recovery: Status to see the estimates there are, wait for it to gather data, or use the explorer\'s estimate or Custom.',
        {
          target: targetName(target),
          blocks: String(feeTargets[target]),
          backend: tools.backend,
          errors: estimates?.backendErrors.join(' / ') || '-',
          uptime: describeUptime(estimates?.uptime ?? null),
        },
      ) + otherSources(estimates, 'node'),
    )
  }
  const rate = Math.max(estimate, minPerkb)
  return {
    param: perkb(rate),
    perkb: rate,
    source:
      i18n(
        "your node's estimate for ${target} (${blocks} blocks), from ${backend}: ${estimate} sat per vbyte${raised}",
        {
          target: targetName(target),
          blocks: String(feeTargets[target]),
          backend: tools.backend,
          estimate: satPerVb(estimate),
          raised:
            rate !== estimate
              ? i18n(', raised to the minimum of ${min}', {
                  min: satPerVb(rate),
                })
              : '',
        },
      ) + otherSources(estimates, 'node'),
    estimates,
  }
}

/** What a transaction in the backend's mempool actually pays, or null if it is not there. */
export async function mempoolFee(tools: Tools, txid: string) {
  const entry = await tools
    .bitcoin<{
      vsize: number
      fees: { base: number }
    }>('getmempoolentry', [txid])
    .catch(() => null)
  if (!entry) return null
  const fee = Math.round(entry.fees.base * 1e8)
  return {
    fee,
    vsize: entry.vsize,
    perkb: Math.floor((fee * 1000) / entry.vsize),
  }
}

export const describeFee = (f: Awaited<ReturnType<typeof mempoolFee>>) =>
  f
    ? `${f.fee} sat for ${f.vsize} vB (${(f.perkb / 1000).toFixed(3)} sat/vB)${
        f.perkb < relayFloorPerkb ? ' BELOW THE KNOTS RELAY FLOOR' : ''
      }`
    : '-'

/**
 * The estimates Recovery: Status last saved, for the dialog of Split or
 * Withdraw. An action's text is fixed between changes of the store, so this
 * is what the operator sees before choosing a source.
 */
export async function storedEstimates(
  effects: T.Effects,
  chain: 'sha256d' | 'blake2b',
): Promise<string> {
  const stored = await storeJson.read((s) => s.feeEstimates).const(effects)
  const text = stored?.[chain]
  if (!stored || !text) {
    return i18n(
      'Fee estimates: none saved yet. Run Recovery: Status first; it reads them from your node and the public explorer and shows them here.',
    )
  }
  return i18n(
    'Fee estimates ${chain} as of ${at} (run Recovery: Status to refresh): ${text}',
    {
      chain:
        chain === 'blake2b'
          ? i18n('on the BLAKE2b chain')
          : i18n('on the SHA256d chain'),
      at: stored.at.replace(/\.\d+Z$/, 'Z').replace('T', ' '),
      text: text.replace(/\$/g, '$$$$'),
    },
  )
}
