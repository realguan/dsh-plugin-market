#!/usr/bin/env node
/**
 * Convert an awesome-dsh-plugin `plugins.json` document into a DSH plugin market index (format 1),
 * the single JSON file `dsh-plugin-market` reads and the Discover tab renders.
 *
 * Every listed version is resolved from the source of truth before it is written:
 * an npm entry is read from the registry (publish time, engines, bundle patch), and a Git entry is
 * pinned to the commit `git ls-remote` reports, with its manifest read from that exact commit.
 * An entry that cannot be resolved or does not declare `dsh.bundle` is skipped and reported.
 *
 * @module awesome-dsh-plugin-dsh-index/convert
 */

import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import process from 'node:process'
import { promisify } from 'node:util'
import { MarketIndexError, parseMarketIndex } from '@deepseek-ai/dsh-plugin-market-index'
import semver from 'semver'

const execFileAsync = promisify(execFile)

/** DSH's package-name rule for the index `name` field. */
const PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/u
const PACKAGE_NAME_MAX_LENGTH = 214
/** DSH's exact-SemVer rule; unlike `semver.valid`, it keeps Git build metadata. */
const EXACT_SEMVER = new RegExp(
  '^(?:0|[1-9]\\d*)\\.(?:0|[1-9]\\d*)\\.(?:0|[1-9]\\d*)'
  + '(?:-(?:(?:0|[1-9]\\d*)|\\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\\.(?:(?:0|[1-9]\\d*)|\\d*[a-zA-Z-][0-9a-zA-Z-]*))*)?'
  + '(?:\\+[0-9a-zA-Z-]+(?:\\.[0-9a-zA-Z-]+)*)?$',
  'u',
)
const LANGUAGE_ID = /^[a-z]{2,8}(?:-[a-z0-9]{1,8})*$/u
const MAX_PUBLISH_TIMESTAMP = 1e11
const SHA = /^[0-9a-f]{40}$/u
/** Consecutive GitHub API refusals after which commit-date lookups stop for the rest of the run. */
let apiRefusals = 0
/** Revision of Git resolution; bump to re-resolve Git entries after changing how a commit is read. */
const GIT_RESOLUTION_REVISION = 2

/** Display titles for the capability ids the market records; an unknown id titles itself. */
const CAPABILITY_TITLES = {
  'fs-read': { en: 'Reads files', zh: '读取文件' },
  'fs-write': { en: 'Writes files', zh: '写入文件' },
  shell: { en: 'Runs shell commands', zh: '执行 Shell 命令' },
  network: { en: 'Network access', zh: '网络访问' },
  llm: { en: 'Calls models', zh: '调用模型' },
  credentials: { en: 'Reads credentials', zh: '读取凭据' },
  env: { en: 'Reads environment', zh: '读取环境变量' },
  subagent: { en: 'Delegates to subagents', zh: '派发子智能体' },
  'dynamic-code': { en: 'Runs dynamic code', zh: '运行动态代码' },
  'host-runtime': { en: 'Host runtime', zh: '宿主运行时' },
}

/** Market sort keys derived from the source document's per-plugin numbers. */
const SORT_KEYS = {
  downloads: { title: { en: 'Downloads', zh: '下载量' }, order: 'desc' },
  stars: { title: { en: 'Stars', zh: '星标' }, order: 'desc' },
  added: { title: { en: 'Recently added', zh: '最近收录' }, order: 'desc' },
}

const USAGE = `Convert awesome-dsh-plugin plugins.json into a DSH plugin market index (format 1).

Usage: node convert.mjs [options]

  --input <file|url>    Source document (default https://awesome-dsh-plugin.com/plugins.json)
  --output <file>       Index to write (default out/dsh-index.json)
  --index-url <url>     URL the index will be served from, used to validate it (default the jsDelivr URL below)
  --report <file>       Skip report to write (default <output>.report.json)
  --cache <dir>         Resolution cache (default .cache)
  --title <text>        Market title in English (default "Awesome DSH Plugin")
  --title-zh <text>     Market title in Chinese
  --description <text>  Market description in English
  --registry <url>      npm registry (default https://registry.npmjs.org/)
  --source <kind>       all | npm | git (default all)
  --limit <n>           Resolve at most n entries, for a trial run
  --concurrency <n>     Entries resolved in parallel (default 8)
  --timeout-ms <n>      Deadline for one request or git command (default 30000)
  --retries <n>         Attempts per network operation (default 3)
  --github-token <tok>  Use the GitHub API for exact commit times (or GitHub token env)
  --refresh             Ignore cached resolutions
  --retry-skipped       Resolve entries again whose cached outcome was a skip
  -h, --help            Print this help

Exit status: 0 all resolved entries written, 1 the source could not be read, 2 invalid arguments.
`

/**
 * Read the command line into options, applying defaults.
 * @param {string[]} argv - process arguments after the script name.
 * @returns {Record<string, unknown>} the parsed options.
 */
function parseArgs(argv) {
  const options = {
    input: 'https://awesome-dsh-plugin.com/plugins.json',
    output: 'out/dsh-index.json',
    indexUrl: 'https://cdn.jsdelivr.net/gh/realguan/dsh-plugin-market@dist/dsh-index.json',
    cache: '.cache',
    title: 'Awesome DSH Plugin',
    titleZh: 'Awesome DSH 插件精选',
    description: undefined,
    registry: 'https://registry.npmjs.org/',
    source: 'all',
    limit: Infinity,
    concurrency: 8,
    timeoutMs: 30_000,
    retries: 3,
    githubToken: process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN,
    refresh: false,
  }
  const stringFlags = {
    '--input': 'input', '--output': 'output', '--report': 'report', '--cache': 'cache',
    '--title': 'title', '--title-zh': 'titleZh', '--description': 'description',
    '--registry': 'registry', '--source': 'source', '--github-token': 'githubToken',
    '--index-url': 'indexUrl',
  }
  const numberFlags = {
    '--limit': 'limit', '--concurrency': 'concurrency', '--timeout-ms': 'timeoutMs', '--retries': 'retries',
  }
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]
    if (flag === '-h' || flag === '--help') {
      process.stdout.write(USAGE)
      process.exit(0)
    }
    if (flag === '--refresh') {
      options.refresh = true
      continue
    }
    if (flag === '--retry-skipped') {
      options.retrySkipped = true
      continue
    }
    const value = argv[index + 1]
    if (value === undefined) fail(`missing value for ${flag}`)
    index += 1
    if (stringFlags[flag] !== undefined) options[stringFlags[flag]] = value
    else if (numberFlags[flag] !== undefined) options[numberFlags[flag]] = Number(value)
    else fail(`unknown option ${flag}`)
  }
  if (!['all', 'npm', 'git'].includes(String(options.source))) fail('--source must be all, npm, or git')
  if (!Number.isFinite(Number(options.concurrency)) || Number(options.concurrency) < 1) fail('--concurrency must be a positive integer')
  options.report ??= `${options.output}.report.json`
  return options
}

/**
 * Report an invalid invocation and exit.
 * @param {string} message - the violated argument rule.
 * @returns {never} never returns.
 */
function fail(message) {
  process.stderr.write(`error: ${message}\n\n${USAGE}`)
  process.exit(2)
}

/**
 * Fetch a document over https with a deadline and retries.
 * @param {string} url - absolute URL to read.
 * @param {Record<string, unknown>} options - parsed CLI options.
 * @param {Record<string, string>} [headers] - additional request headers.
 * @returns {Promise<Response>} the successful response.
 */
async function fetchWithRetry(url, options, headers = {}) {
  let lastError
  for (let attempt = 1; attempt <= Number(options.retries); attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: { 'user-agent': 'awesome-dsh-plugin-dsh-index/0.1.0', ...headers },
        signal: AbortSignal.timeout(Number(options.timeoutMs)),
        redirect: 'follow',
      })
      if (response.status === 404) return response
      if (!response.ok) throw new Error(`HTTP ${String(response.status)}`)
      return response
    } catch (error) {
      lastError = error
      if (attempt < Number(options.retries)) await delay(300 * attempt * attempt)
    }
  }
  throw new Error(`${url}: ${lastError instanceof Error ? lastError.message : String(lastError)}`)
}

/**
 * Fetch and parse a JSON document, treating 404 as absent.
 * @param {string} url - absolute URL to read.
 * @param {Record<string, unknown>} options - parsed CLI options.
 * @returns {Promise<unknown>} the parsed JSON, or `undefined` for a 404.
 */
async function fetchJson(url, options) {
  const response = await fetchWithRetry(url, options)
  if (response.status === 404) return undefined
  return await response.json()
}

/**
 * Fetch a text document, returning `undefined` for a 404.
 * @param {string} url - absolute URL to read.
 * @param {Record<string, unknown>} options - parsed CLI options.
 * @returns {Promise<string | undefined>} the body, or `undefined` when absent.
 */
async function fetchText(url, options) {
  const response = await fetchWithRetry(url, options)
  if (response.status === 404) return undefined
  return await response.text()
}

/**
 * Wait for a number of milliseconds.
 * @param {number} ms - the delay.
 * @returns {Promise<void>} resolves after the delay.
 */
function delay(ms) {
  return new Promise(resolve => { setTimeout(resolve, ms) })
}

/**
 * Read the source document from a URL or a local path.
 * @param {string} input - the `--input` value.
 * @param {Record<string, unknown>} options - parsed CLI options.
 * @returns {Promise<Record<string, unknown>>} the parsed source document.
 */
async function readSource(input, options) {
  if (/^https?:/u.test(input)) return /** @type {Record<string, unknown>} */ (await fetchJson(input, options))
  return JSON.parse(await readFile(input, 'utf8'))
}

/**
 * Run one git command with a deadline.
 * @param {string[]} args - arguments after `git`.
 * @param {Record<string, unknown>} options - parsed CLI options.
 * @returns {Promise<string>} trimmed stdout.
 */
async function git(args, options) {
  const { stdout } = await execFileAsync('git', args, {
    timeout: Number(options.timeoutMs),
    maxBuffer: 4 * 1024 * 1024,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: 'echo' },
  })
  return stdout.trim()
}

/**
 * Parse a GitHub repository URL, including a `/tree/<branch>/<dir>` reference.
 * @param {string} url - the source entry's `url`.
 * @returns {{ owner: string, repo: string, repoUrl: string, branch?: string, directory?: string } | undefined} the parts, or `undefined` for a non-GitHub URL.
 */
function parseGitHubUrl(url) {
  let parsed
  try {
    parsed = new URL(url)
  } catch {
    return undefined
  }
  if (parsed.hostname !== 'github.com') return undefined
  const segments = parsed.pathname.split('/').filter(segment => segment !== '')
  if (segments.length < 2) return undefined
  const [owner, rawRepo] = segments
  const repo = rawRepo.replace(/\.git$/u, '')
  if (owner === '' || repo === '') return undefined
  const repoUrl = `https://github.com/${owner}/${repo}`
  if (segments[2] !== 'tree' || segments.length < 5) return { owner, repo, repoUrl }
  return {
    owner, repo, repoUrl,
    branch: segments[3],
    directory: segments.slice(4).map(segment => decodeURIComponent(segment)).join('/'),
  }
}

/**
 * Resolve the commit a Git entry installs from.
 * @param {{ repoUrl: string, branch?: string }} target - the parsed repository.
 * @param {Record<string, unknown>} options - parsed CLI options.
 * @returns {Promise<string>} the 40-hex commit SHA.
 */
async function resolveCommit(target, options) {
  const attempts = [target.branch === undefined ? 'HEAD' : `refs/heads/${target.branch}`, 'HEAD']
  let lastError
  for (const ref of [...new Set(attempts)]) {
    for (let attempt = 1; attempt <= Number(options.retries); attempt += 1) {
      try {
        const output = await git(['ls-remote', '--exit-code', target.repoUrl, ref], options)
        const sha = output.split('\n')[0]?.split('\t')[0]?.trim() ?? ''
        if (SHA.test(sha)) return sha
        lastError = new Error(`no ${ref}`)
        break
      } catch (error) {
        lastError = error
        if (attempt < Number(options.retries)) await delay(400 * attempt)
      }
    }
  }
  throw new Error(`cannot resolve ${target.repoUrl}: ${lastError instanceof Error ? lastError.message.split('\n')[0] : 'no ref'}`)
}

/**
 * Read a package manifest from a GitHub repository at an exact commit.
 * @param {{ owner: string, repo: string }} target - the parsed repository.
 * @param {string} commit - the commit SHA.
 * @param {string | undefined} directory - package directory inside the repository.
 * @param {Record<string, unknown>} options - parsed CLI options.
 * @returns {Promise<Record<string, unknown> | undefined>} the manifest, or `undefined` when absent.
 */
async function readGitManifest(target, commit, directory, options) {
  const prefix = directory === undefined ? '' : `${directory}/`
  const url = `https://raw.githubusercontent.com/${target.owner}/${target.repo}/${commit}/${prefix}package.json`
  const body = await fetchText(url, options)
  if (body === undefined) return undefined
  try {
    return JSON.parse(body)
  } catch {
    throw new Error(`malformed package.json at ${url}`)
  }
}

/**
 * Read one npm package's packument, without caching the whole document.
 * @param {string} name - the package name.
 * @param {Record<string, unknown>} options - parsed CLI options.
 * @returns {Promise<Record<string, unknown> | undefined>} the packument, or `undefined` when unpublished.
 */
async function readPackument(name, options) {
  const registry = String(options.registry).replace(/\/$/u, '')
  return /** @type {Record<string, unknown>} */ (await fetchJson(`${registry}/${encodeURIComponent(name)}`, options))
}

/**
 * Derive the `engines.dsh` range a manifest declares, or the conjunction of its DSH peer ranges.
 * @param {Record<string, unknown>} manifest - the package manifest.
 * @returns {string | undefined} the declared range, absent when none can be stated.
 */
function dshRange(manifest) {
  const engines = isRecord(manifest.engines) ? manifest.engines : {}
  const declared = engines.dsh
  if (typeof declared === 'string' && semver.validRange(declared) !== null && !declared.startsWith('workspace:')) return declared
  const peers = isRecord(manifest.peerDependencies) ? manifest.peerDependencies : {}
  const ranges = Object.entries(peers)
    .filter(([peer]) => peer === '@deepseek-ai/dsh' || peer.startsWith('@deepseek-ai/dsh-'))
    .map(([, range]) => range)
    .filter(range => typeof range === 'string' && !range.startsWith('workspace:') && semver.validRange(range) !== null)
  const distinct = [...new Set(ranges)]
  if (distinct.length === 0) return undefined
  if (!distinct.every(range => !range.includes('||'))) return distinct.length === 1 ? distinct[0] : undefined
  const joined = distinct.join(' ')
  return semver.validRange(joined) === null ? undefined : joined
}

/**
 * Report whether a manifest declares an installable bundle patch.
 * @param {Record<string, unknown>} manifest - the package manifest.
 * @returns {boolean} true when `dsh.bundle.patch` names at least one file.
 */
function declaresBundle(manifest) {
  const dsh = isRecord(manifest.dsh) ? manifest.dsh : {}
  const bundle = isRecord(dsh.bundle) ? dsh.bundle : {}
  if (typeof bundle.patch === 'string') return bundle.patch.trim() !== ''
  if (Array.isArray(bundle.patch)) return bundle.patch.some(entry => typeof entry === 'string' && entry.trim() !== '')
  return false
}

/**
 * Test whether a value is a non-array object.
 * @param {unknown} value - the value to test.
 * @returns {boolean} true for a plain record.
 */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Build a `LocalizedText` from the market's bilingual description, falling back to English text.
 * @param {unknown} description - the source entry's description.
 * @param {string | undefined} fallback - an English fallback.
 * @returns {Record<string, string> | undefined} the localized text.
 */
function localizedDescription(description, fallback) {
  const text = {}
  if (typeof description === 'string' && description.trim() !== '') text.en = description
  else if (isRecord(description)) {
    for (const [language, value] of Object.entries(description)) {
      if (LANGUAGE_ID.test(language) && typeof value === 'string' && value.trim() !== '') text[language] = value
    }
  }
  if (text.en === undefined && typeof fallback === 'string' && fallback.trim() !== '') text.en = fallback
  return Object.keys(text).length === 0 ? undefined : text
}

/**
 * Read the web URL of a manifest's repository declaration.
 * @param {Record<string, unknown>} manifest - the package manifest.
 * @returns {string | undefined} an absolute http(s) URL, or `undefined`.
 */
function manifestRepositoryUrl(manifest) {
  const repository = manifest.repository
  const raw = typeof repository === 'string' ? repository : isRecord(repository) ? repository.url : undefined
  if (typeof raw !== 'string') return undefined
  return normalizeWebUrl(raw)
}

/**
 * Read the package directory a manifest's repository declaration names.
 * @param {Record<string, unknown>} manifest - the package manifest.
 * @returns {string | undefined} the validated POSIX directory.
 */
function manifestRepositoryDirectory(manifest) {
  const repository = manifest.repository
  if (!isRecord(repository) || typeof repository.directory !== 'string') return undefined
  return packageDirectory(repository.directory)
}

/**
 * Normalize a repository reference to its web page.
 * @param {string} url - a repository URL, possibly `git+`, with a `.git` suffix or a `#` committish.
 * @returns {string | undefined} the normalized https URL, or `undefined`.
 */
function normalizeWebUrl(url) {
  let text = url.trim().replace(/^git\+/u, '').replace(/#.*$/u, '')
  if (text.startsWith('git@github.com:')) text = `https://github.com/${text.slice('git@github.com:'.length)}`
  if (/^github:/u.test(text)) text = `https://github.com/${text.slice('github:'.length)}`
  text = text.replace(/\.git$/u, '')
  if (!URL.canParse(text)) return undefined
  const parsed = new URL(text)
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return undefined
  parsed.username = ''
  parsed.password = ''
  parsed.search = ''
  parsed.hash = ''
  return parsed.href.replace(/\/$/u, '')
}

/**
 * Validate a repository directory for the index `path` field.
 * @param {string} value - the candidate directory.
 * @returns {string | undefined} the directory when it satisfies the rule.
 */
function packageDirectory(value) {
  const text = value.replace(/^\.\//u, '').replace(/\/$/u, '')
  if (text === '') return undefined
  const segments = text.split('/')
  if (segments.some(segment => segment === '' || segment === '.' || segment === '..' || !/^[A-Za-z0-9._@+-]+$/u.test(segment))) return undefined
  return text
}

/**
 * Resolve the icon URL a manifest declares.
 * @param {Record<string, unknown>} manifest - the package manifest.
 * @param {{ kind: 'npm', name: string, version: string } | { kind: 'git', owner: string, repo: string, commit: string, directory?: string }} target - where the manifest lives.
 * @returns {string | undefined} an absolute https icon URL, or `undefined`.
 */
function iconUrl(manifest, target) {
  const icon = manifest.icon
  if (typeof icon !== 'string' || icon.trim() === '') return undefined
  const text = icon.trim()
  if (text.startsWith('data:')) return undefined
  if (/^https:\/\//u.test(text)) return text
  const relative = text.replace(/^\.\//u, '')
  if (relative.includes('..') || relative.startsWith('/')) return undefined
  if (target.kind === 'npm') return `https://cdn.jsdelivr.net/npm/${target.name}@${target.version}/${relative}`
  const prefix = target.directory === undefined ? '' : `${target.directory}/`
  return `https://raw.githubusercontent.com/${target.owner}/${target.repo}/${target.commit}/${prefix}${relative}`
}

/**
 * Build the market metadata of one plugin from the source entry.
 * @param {Record<string, unknown>} entry - the source entry.
 * @param {Record<string, unknown>} manifest - the resolved package manifest.
 * @returns {Record<string, unknown>} the index `metadata` value.
 */
function pluginMetadata(entry, manifest) {
  /** @type {Record<string, number>} */
  const sortKeys = {}
  const added = Math.floor(Date.parse(`${String(entry.added)}T00:00:00Z`) / 1000)
  if (typeof entry.downloads === 'number' && Number.isFinite(entry.downloads)) sortKeys.downloads = entry.downloads
  if (typeof entry.stars === 'number' && Number.isFinite(entry.stars)) sortKeys.stars = entry.stars
  if (Number.isFinite(added)) sortKeys.added = added
  const keywords = Array.isArray(manifest.keywords)
    ? manifest.keywords.filter(keyword => typeof keyword === 'string')
    : []
  const labels = Array.isArray(entry.capabilities)
    ? [...new Set(entry.capabilities.filter(capability => typeof capability === 'string' && capability !== ''))]
    : []
  return {
    ...(typeof entry.category === 'string' && entry.category !== '' ? { category: entry.category } : {}),
    keywords,
    labels,
    sortKeys,
  }
}

/**
 * Build the index plugin for one source entry from a resolved manifest and version.
 * @param {Record<string, unknown>} entry - the source entry.
 * @param {Record<string, unknown>} manifest - the resolved package manifest.
 * @param {Record<string, unknown>} version - the index `versions[0]` value.
 * @param {{ kind: 'npm', name: string, version: string } | { kind: 'git', owner: string, repo: string, commit: string, directory?: string }} target - where the manifest lives.
 * @param {Record<string, unknown>} options - parsed CLI options.
 * @returns {Record<string, unknown>} the index plugin.
 */
function buildPlugin(entry, manifest, version, target, options) {
  const name = typeof manifest.name === 'string' ? manifest.name : String(entry.npm ?? entry.name)
  if (name.length > PACKAGE_NAME_MAX_LENGTH || !PACKAGE_NAME.test(name)) {
    throw new Error(`manifest name ${JSON.stringify(name)} is not a valid npm package name`)
  }
  const repositoryUrl = normalizeWebUrl(String(entry.url)) ?? manifestRepositoryUrl(manifest)
  const directory = manifestRepositoryDirectory(manifest) ?? (target.kind === 'git' ? target.directory : undefined)
  const homepage = normalizeWebUrl(typeof manifest.homepage === 'string' ? manifest.homepage : '') ?? normalizeWebUrl(String(entry.page ?? ''))
  const icon = iconUrl(manifest, target)
  const description = localizedDescription(entry.description, typeof manifest.description === 'string' ? manifest.description : undefined)
  const title = typeof entry.name === 'string' && entry.name.trim() !== '' ? entry.name.trim() : undefined
  const author = typeof entry.owner === 'string' && entry.owner.trim() !== '' ? entry.owner.trim() : (
    typeof manifest.author === 'string' ? manifest.author.replace(/<[^>]*>/gu, '').replace(/\([^)]*\)/gu, '').trim()
      : isRecord(manifest.author) && typeof manifest.author.name === 'string' ? manifest.author.name : undefined
  )
  return {
    name,
    ...(title === undefined ? {} : { title }),
    ...(description === undefined ? {} : { description }),
    ...(icon === undefined ? {} : { icon }),
    ...(author === undefined || author === '' ? {} : { author }),
    ...(homepage === undefined ? {} : { homepage }),
    ...(repositoryUrl === undefined ? {} : { repository: { url: repositoryUrl, ...(directory === undefined ? {} : { directory }) } }),
    metadata: pluginMetadata(entry, manifest),
    versions: [version],
  }
}

/**
 * Resolve one source entry into an index plugin.
 * @param {Record<string, unknown>} entry - the source entry.
 * @param {Record<string, unknown>} options - parsed CLI options.
 * @returns {Promise<{ plugin?: Record<string, unknown>, kind: 'npm' | 'git', skip?: string }>} the resolution outcome.
 */
async function resolveEntry(entry, options) {
  const npmName = typeof entry.npm === 'string' && entry.npm !== '' ? entry.npm : undefined
  const version = typeof entry.version === 'string' && entry.version !== '' ? entry.version : undefined
  if (npmName !== undefined && version !== undefined && options.source !== 'git') {
    const plugin = await resolveNpm(entry, npmName, version, options)
    return { plugin, kind: 'npm' }
  }
  if (options.source === 'npm') return { kind: 'git', skip: 'no npm package' }
  const github = parseGitHubUrl(String(entry.url))
  if (github === undefined) return { kind: 'git', skip: `unsupported source host: ${String(entry.url)}` }
  const plugin = await resolveGit(entry, github, options)
  return { plugin, kind: 'git' }
}

/**
 * Resolve an npm-sourced entry against the registry.
 * @param {Record<string, unknown>} entry - the source entry.
 * @param {string} name - the npm package name.
 * @param {string} version - the listed version.
 * @param {Record<string, unknown>} options - parsed CLI options.
 * @returns {Promise<Record<string, unknown>>} the index plugin.
 */
async function resolveNpm(entry, name, version, options) {
  if (!PACKAGE_NAME.test(name)) throw new Error(`${name} is not a valid npm package name`)
  const packument = await readPackument(name, options)
  if (packument === undefined) throw new Error(`${name} is not published on this registry`)
  const versions = isRecord(packument.versions) ? packument.versions : {}
  const manifest = versions[version]
  if (!isRecord(manifest)) {
    const latest = isRecord(packument['dist-tags']) ? packument['dist-tags'].latest : undefined
    throw new Error(`${name}@${version} is not published (latest ${String(latest)})`)
  }
  if (!declaresBundle(manifest)) throw new Error(`${name}@${version} does not declare dsh.bundle`)
  const time = isRecord(packument.time) ? packument.time[version] : undefined
  const published = typeof time === 'string' ? Math.floor(Date.parse(time) / 1000) : Number.NaN
  const publishTimestamp = Number.isFinite(published) ? published : fallbackTimestamp(entry)
  const range = dshRange(manifest)
  const registry = String(options.registry).replace(/\/$/u, '')
  const source = registry === 'https://registry.npmjs.org' ? { type: 'npm' } : { type: 'npm', registry }
  const indexVersion = {
    version,
    publishTimestamp,
    source,
    ...(range === undefined ? {} : { engines: { dsh: range } }),
  }
  return buildPlugin(entry, manifest, indexVersion, { kind: 'npm', name, version }, options)
}

/**
 * Resolve a Git-sourced entry to a pinned commit and its manifest.
 * @param {Record<string, unknown>} entry - the source entry.
 * @param {{ owner: string, repo: string, repoUrl: string, branch?: string, directory?: string }} github - the parsed repository.
 * @param {Record<string, unknown>} options - parsed CLI options.
 * @returns {Promise<Record<string, unknown>>} the index plugin.
 */
async function resolveGit(entry, github, options) {
  const commit = await resolveCommit(github, options)
  const directory = github.directory === undefined ? undefined : packageDirectory(github.directory)
  const manifest = await readGitManifest(github, commit, directory, options)
  if (manifest === undefined) throw new Error(`no package.json at ${github.repoUrl}@${commit.slice(0, 7)}${directory === undefined ? '' : `/${directory}`}`)
  if (!declaresBundle(manifest)) throw new Error(`manifest at ${github.repoUrl}@${commit.slice(0, 7)} does not declare dsh.bundle`)
  if (typeof manifest.version !== 'string' || !EXACT_SEMVER.test(manifest.version)) {
    throw new Error(`manifest version ${JSON.stringify(manifest.version)} is not an exact SemVer version`)
  }
  const publishTimestamp = await gitCommitTimestamp(github, commit, entry, options)
  const range = dshRange(manifest)
  const version = {
    version: manifest.version,
    publishTimestamp,
    source: { type: 'git', url: github.repoUrl, commit, ...(directory === undefined ? {} : { path: directory }) },
    ...(range === undefined ? {} : { engines: { dsh: range } }),
  }
  return buildPlugin(entry, manifest, version, {
    kind: 'git', owner: github.owner, repo: github.repo, commit, directory,
  }, options)
}

/**
 * Read a commit's committer time, using the GitHub API only when a token is available.
 * A rate-limited token is dropped after three refusals, because a market has thousands of Git entries
 * and the CI token allows only a fraction of them; every entry then keeps the market's own date.
 * @param {{ owner: string, repo: string }} github - the parsed repository.
 * @param {string} commit - the commit SHA.
 * @param {Record<string, unknown>} entry - the source entry, whose `added` date is the fallback.
 * @param {Record<string, unknown>} options - parsed CLI options.
 * @returns {Promise<number>} Unix seconds.
 */
async function gitCommitTimestamp(github, commit, entry, options) {
  if (apiRefusals < 3 && typeof options.githubToken === 'string' && options.githubToken !== '') {
    const url = `https://api.github.com/repos/${github.owner}/${github.repo}/commits/${commit}`
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      let response
      try {
        response = await fetch(url, {
          headers: { accept: 'application/vnd.github+json', authorization: `Bearer ${String(options.githubToken)}`, 'user-agent': 'dsh-plugin-market/0.1.0' },
          signal: AbortSignal.timeout(Number(options.timeoutMs)),
        })
      } catch {
        // Network failure or timeout; retry, then keep the market's own date.
        if (attempt < 3) { await delay(400 * attempt); continue }
        break
      }
      if (response.status === 403 || response.status === 429) {
        // Secondary limits are transient and answer with `retry-after`; the primary limit is not, and the
        // breaker below stops asking rather than spending the rest of the run on refusals.
        if (attempt < 3) { await delay(retryAfterMs(response, attempt * 1000)); continue }
        apiRefusals += 1
        if (apiRefusals === 3) process.stderr.write('github commit dates were refused; using the market dates for the remaining git entries\n')
        break
      }
      if (!response.ok) break
      const payload = await response.json()
      if (isRecord(payload) && isRecord(payload.commit) && isRecord(payload.commit.committer) && typeof payload.commit.committer.date === 'string') {
        const seconds = Math.floor(Date.parse(payload.commit.committer.date) / 1000)
        if (Number.isFinite(seconds)) return seconds
      }
      break
    }
  }
  return fallbackTimestamp(entry)
}

/**
 * Read how long a refused GitHub request asks the client to wait.
 * @param {Response} response - the refused response.
 * @param {number} fallbackMs - the delay to use without a usable header.
 * @returns {number} the delay in milliseconds, at most 10 seconds.
 */
function retryAfterMs(response, fallbackMs) {
  const header = response.headers.get('retry-after')
  const seconds = header === null ? Number.NaN : Number(header)
  return Number.isFinite(seconds) ? Math.min(seconds * 1000, 10_000) : fallbackMs
}

/**
 * Read the market's recorded date as a timestamp.
 * @param {Record<string, unknown>} entry - the source entry.
 * @returns {number} Unix seconds, or the current time when the entry records none.
 */
function fallbackTimestamp(entry) {
  const added = Date.parse(`${String(entry.added)}T00:00:00Z`)
  if (Number.isFinite(added)) return Math.floor(added / 1000)
  return Math.floor(Date.now() / 1000)
}

/**
 * Read or compute one entry's resolution, through the on-disk cache.
 * @param {Record<string, unknown>} entry - the source entry.
 * @param {Record<string, unknown>} options - parsed CLI options.
 * @returns {Promise<{ plugin?: Record<string, unknown>, kind: 'npm' | 'git', skip?: string, cached: boolean }>} the outcome.
 */
async function resolveCached(entry, options) {
  const npmName = typeof entry.npm === 'string' && entry.npm !== '' ? entry.npm : undefined
  const version = typeof entry.version === 'string' && entry.version !== '' ? entry.version : undefined
  const kind = npmName !== undefined && version !== undefined && options.source !== 'git' ? 'npm' : 'git'
  // The key carries a resolution revision, so improving how a kind is resolved invalidates only that kind.
  const revision = kind === 'git' ? GIT_RESOLUTION_REVISION : 1
  const key = createHash('sha256')
    .update(JSON.stringify([kind, revision, npmName ?? null, version ?? null, entry.url ?? null]))
    .digest('hex').slice(0, 32)
  const file = join(String(options.cache), `${key}.json`)
  if (!options.refresh) {
    try {
      const cached = JSON.parse(await readFile(file, 'utf8'))
      if (isRecord(cached) && !(options.retrySkipped === true && cached.skip !== undefined)) return { ...cached, cached: true }
    } catch {
      // No usable cache entry: resolve from the source again.
    }
  }
  let outcome
  try {
    outcome = await resolveEntry(entry, options)
    outcome = { plugin: outcome.plugin, kind: outcome.kind, ...(outcome.skip === undefined ? {} : { skip: outcome.skip }) }
  } catch (error) {
    outcome = { kind: typeof entry.npm === 'string' && entry.npm !== '' ? 'npm' : 'git', skip: error instanceof Error ? error.message : String(error) }
  }
  await writeAtomic(file, JSON.stringify(outcome))
  return { ...outcome, cached: false }
}

/**
 * Write a file through a temporary sibling, so a reader never sees a partial document.
 * @param {string} file - destination path.
 * @param {string} contents - the content to write.
 * @returns {Promise<void>} resolves after the rename.
 */
async function writeAtomic(file, contents) {
  await mkdir(dirname(file), { recursive: true })
  const temporary = `${file}.${String(process.pid)}.tmp`
  await writeFile(temporary, contents)
  await rename(temporary, file)
}

/**
 * Validate an index with DSH's own format-1 validator, the executable rule set the reader uses.
 * @param {Record<string, unknown>} index - the candidate index.
 * @param {string} indexUrl - the URL the index will be served from; relative icons resolve against it.
 * @returns {string | undefined} the violated rule with its JSON path, or `undefined` when the index is valid.
 */
function validateIndex(index, indexUrl) {
  try {
    parseMarketIndex(index, indexUrl)
    return undefined
  } catch (error) {
    if (error instanceof MarketIndexError) return `${error.path} ${error.reason}`
    throw error
  }
}

/**
 * Run a worker pool over the entries, preserving input order.
 * @param {Record<string, unknown>[]} entries - source entries.
 * @param {Record<string, unknown>} options - parsed CLI options.
 * @returns {Promise<Array<{ plugin?: Record<string, unknown>, kind: string, skip?: string, cached: boolean }>>} outcomes in input order.
 */
async function resolveAll(entries, options) {
  const outcomes = new Array(entries.length)
  let next = 0
  let done = 0
  const started = Date.now()
  const worker = async () => {
    for (;;) {
      const index = next
      next += 1
      if (index >= entries.length) return
      outcomes[index] = await resolveCached(entries[index], options)
      done += 1
      if (done % 100 === 0 || done === entries.length) {
        const seconds = ((Date.now() - started) / 1000).toFixed(0)
        const skipped = outcomes.slice(0, done).filter(outcome => outcome?.plugin === undefined).length
        process.stderr.write(`resolved ${String(done)}/${String(entries.length)} (${String(skipped)} skipped, ${seconds}s)\n`)
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(Number(options.concurrency), entries.length) }, worker))
  return outcomes
}

/**
 * Rank one candidate that claims a package name another entry claims too: a pinned npm version wins,
 * then downloads, then stars, then the earlier listing; equal ranks keep the entry that came first.
 * @param {Record<string, unknown>} plugin - the resolved plugin.
 * @param {Record<string, unknown>} entry - its source entry.
 * @returns {number[]} the comparable rank, most significant first.
 */
function rank(plugin, entry) {
  const downloads = typeof entry.downloads === 'number' && Number.isFinite(entry.downloads) ? entry.downloads : -1
  const stars = typeof entry.stars === 'number' && Number.isFinite(entry.stars) ? entry.stars : -1
  const added = Date.parse(`${String(entry.added)}T00:00:00Z`)
  return [
    /** @type {Record<string, unknown>} */ (plugin.versions[0]).source.type === 'npm' ? 1 : 0,
    downloads,
    stars,
    Number.isFinite(added) ? -added : 0,
  ]
}

/**
 * Compare two name collisions by rank.
 * @param {Record<string, unknown>} leftPlugin - the candidate.
 * @param {Record<string, unknown>} leftEntry - the candidate's source entry.
 * @param {Record<string, unknown>} rightPlugin - the incumbent.
 * @param {Record<string, unknown>} rightEntry - the incumbent's source entry.
 * @returns {number} positive when the candidate ranks higher.
 */
function compareRank(leftPlugin, leftEntry, rightPlugin, rightEntry) {
  const left = rank(leftPlugin, leftEntry)
  const right = rank(rightPlugin, rightEntry)
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return Number(left[index]) - Number(right[index])
  }
  return 0
}

/**
 * Build the format-1 index from the source document and the resolved plugins.
 * @param {Record<string, unknown>} source - the source document.
 * @param {Record<string, unknown>[]} entries - source entries.
 * @param {Array<{ plugin?: Record<string, unknown>, kind: string, skip?: string }>} outcomes - resolutions in input order.
 * @param {Record<string, unknown>} options - parsed CLI options.
 * @returns {{ index: Record<string, unknown>, duplicates: Record<string, unknown>[] }} the index and the collapsed duplicates.
 */
function buildIndex(source, entries, outcomes, options) {
  const categories = {}
  for (const [id, title] of Object.entries(isRecord(source.categories) ? source.categories : {})) {
    const localized = localizedDescription(title, undefined)
    if (localized !== undefined && localized.en !== undefined) categories[id] = { title: localized }
  }
  const labels = {}
  for (const entry of entries) {
    for (const capability of Array.isArray(entry.capabilities) ? entry.capabilities : []) {
      if (typeof capability !== 'string' || capability === '' || labels[capability] !== undefined) continue
      labels[capability] = { title: CAPABILITY_TITLES[capability] ?? capability }
    }
  }
  const plugins = []
  /** @type {Map<string, { plugin: Record<string, unknown>, entry: Record<string, unknown>, position: number }>} */
  const byName = new Map()
  const duplicates = []
  for (const [index, outcome] of outcomes.entries()) {
    const plugin = outcome.plugin
    if (plugin === undefined) continue
    if (plugin.metadata.category !== undefined && categories[plugin.metadata.category] === undefined) plugin.metadata.category = undefined
    plugin.metadata.labels = plugin.metadata.labels.filter(label => labels[label] !== undefined)
    // A source URL can name a package directory inside a repository (`.../tree/<branch>/<dir>`); the repository page is
    // the repository root, and the directory belongs in `repository.directory`. Derived here so a cached resolution follows it.
    const githubEntry = parseGitHubUrl(String(entries[index].url))
    if (githubEntry !== undefined && plugin.repository !== undefined) {
      plugin.repository.url = githubEntry.repoUrl
      if (plugin.repository.directory === undefined && githubEntry.directory !== undefined) {
        plugin.repository.directory = githubEntry.directory
      }
    }
    const kept = byName.get(plugin.name)
    if (kept === undefined) {
      byName.set(plugin.name, { plugin, entry: entries[index], position: plugins.length })
      plugins.push(plugin)
      continue
    }
    // The index allows one plugin per package name, and two unrelated plugins can claim the same one.
    const wins = compareRank(plugin, entries[index], kept.plugin, kept.entry) > 0
    const winner = wins ? { plugin, entry: entries[index] } : { plugin: kept.plugin, entry: kept.entry }
    if (wins) {
      plugins[kept.position] = plugin
      byName.set(plugin.name, { plugin, entry: entries[index], position: kept.position })
    }
    duplicates.push({
      name: plugin.name,
      keptUrl: winner.entry.url,
      keptSource: winner.plugin.versions[0].source.type,
      droppedUrl: wins ? kept.entry.url : entries[index].url,
      droppedSource: wins ? kept.plugin.versions[0].source.type : plugin.versions[0].source.type,
    })
  }
  const withIcons = plugins.filter(plugin => plugin.icon !== undefined).length
  const title = { en: String(options.title), zh: String(options.titleZh) }
  const index = {
    format: 1,
    title,
    ...(options.description === undefined
      ? { description: { en: `Community-curated market of ${String(plugins.length)} DSH plugin bundles.`, zh: `社区维护的 DSH 插件市场，收录 ${String(plugins.length)} 个插件。` } }
      : { description: { en: String(options.description) } }),
    metadata: { categories, labels, sortKeys: SORT_KEYS },
    plugins,
    'x-provenance': {
      source: String(options.input),
      sourceUpdated: source.updated,
      generatedAt: new Date().toISOString(),
      entries: entries.length,
      listed: plugins.length,
      withIcon: withIcons,
    },
  }
  return { index, duplicates }
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  process.stderr.write(`reading ${String(options.input)}\n`)
  const source = await readSource(String(options.input), options)
  const entries = (Array.isArray(source.plugins) ? source.plugins : []).filter(isRecord).slice(0, Number(options.limit))
  process.stderr.write(`entries: ${String(entries.length)}\n`)
  const outcomes = await resolveAll(entries, options)
  const { index, duplicates } = buildIndex(source, entries, outcomes, options)
  const problem = validateIndex(index, String(options.indexUrl))
  if (problem !== undefined) {
    process.stderr.write(`index failed DSH format validation: ${problem}\n`)
    process.exit(1)
  }
  await writeAtomic(String(options.output), `${JSON.stringify(index, undefined, 1)}\n`)
  const skipped = entries
    .map((entry, position) => ({ entry, outcome: outcomes[position] }))
    .filter(({ outcome }) => outcome.plugin === undefined)
    .map(({ entry, outcome }) => ({ name: entry.npm ?? entry.name, url: entry.url, kind: outcome.kind, reason: outcome.skip }))
  const listed = index.plugins
  const report = {
    source: String(options.input),
    sourceUpdated: source.updated,
    generatedAt: new Date().toISOString(),
    counts: {
      entries: entries.length,
      listed: listed.length,
      skipped: skipped.length,
      duplicates: duplicates.length,
      npm: listed.filter(plugin => plugin.versions[0].source.type === 'npm').length,
      git: listed.filter(plugin => plugin.versions[0].source.type === 'git').length,
      withIcon: listed.filter(plugin => plugin.icon !== undefined).length,
      withEnginesDsh: listed.filter(plugin => plugin.versions[0].engines?.dsh !== undefined).length,
      cached: outcomes.filter(outcome => outcome.cached === true).length,
    },
    skipped,
    duplicates,
  }
  await writeAtomic(String(options.report), `${JSON.stringify(report, undefined, 1)}\n`)
  process.stderr.write(
    `wrote ${String(options.output)}: ${String(listed.length)} plugins `
    + `(${String(report.counts.npm)} npm, ${String(report.counts.git)} git), `
    + `${String(skipped.length)} skipped, ${String(duplicates.length)} duplicate name(s) collapsed\n`
    + `report: ${String(options.report)}\n`,
  )
}

await main().catch(error => {
  process.stderr.write(`error: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exit(1)
})
