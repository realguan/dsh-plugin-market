#!/usr/bin/env node
/**
 * Verify a generated index through DSH's own reader, not a schema copy of it:
 * serve the file over HTTP, fetch it, run the parse the market parse Worker runs,
 * then search and sort it with the reader's search engine and build install specs.
 *
 * Run from a DSH checkout so `tsx` and the workspace packages resolve:
 *   DSH_CHECKOUT=~/git/deepseek-harness node --import tsx/esm verify-dsh-market.mts <index.json> [index-url]
 *
 * @module awesome-dsh-plugin-dsh-index/verify-dsh-market
 */

import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import process from 'node:process'

const dsh = process.env.DSH_CHECKOUT ?? '/Users/guan/git/deepseek-harness'
const { parseIndexBody } = await import(join(dsh, 'packages/boot/plugin-market/src/parse.ts'))
const { MarketSearch } = await import(join(dsh, 'packages/boot/plugin-market/src/search.ts'))
const { marketInstallTarget } = await import(join(dsh, 'packages/util/plugin-market-index/src/index.ts'))

const file = process.argv[2] ?? 'out/dsh-index.json'
const body = await readFile(file)

// Serve and fetch the document, so the bytes verified are the bytes a market host returns.
const server = createServer((_request, response) => {
  response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
  response.end(body)
})
await new Promise(resolve => { server.listen(0, '127.0.0.1', resolve) })
const address = server.address()
if (address === null || typeof address === 'string') throw new Error('no server address')
const url = process.argv[3] ?? `http://127.0.0.1:${String(address.port)}/dsh-index.json`
const response = await fetch(url)
const bytes = new Uint8Array(await response.arrayBuffer())
server.close()

const parsed = parseIndexBody(bytes, url)
if (!parsed.ok) {
  process.stderr.write(`REJECTED at ${parsed.path}: ${parsed.reason}\n`)
  process.exit(1)
}
const { index } = parsed
process.stdout.write(`fetched ${String(bytes.byteLength)} bytes from ${url}\n`)
process.stdout.write(`ACCEPTED: ${String(index.plugins.length)} plugins, ${String(Object.keys(index.metadata.categories).length)} categories, ${String(Object.keys(index.metadata.labels).length)} labels\n`)

const search = new MarketSearch(index)
const failures = []
const queries = [
  ['text "memory"', { text: 'memory', sort: { kind: 'index' }, offset: 0, limit: 5 }],
  ['text "theme" (typo-tolerant)', { text: 'theme', sort: { kind: 'relevance' }, offset: 0, limit: 5 }],
  ['category "ui"', { category: 'ui', sort: { kind: 'published', direction: 'desc' }, offset: 0, limit: 5 }],
  ['label "network"', { labels: ['network'], sort: { kind: 'index' }, offset: 0, limit: 5 }],
  ['sort by declared key "downloads"', { sort: { kind: 'key', id: 'downloads', direction: 'desc' }, offset: 0, limit: 5 }],
]
for (const [label, selection] of queries) {
  try {
    const results = await search.select(selection)
    const first = results[0]
    process.stdout.write(`  ${label}: ${String(results.length)} hit(s)${first === undefined ? '' : `, first ${first.name}`}\n`)
    if (results.length === 0) failures.push(`${label} matched nothing`)
  } catch (error) {
    failures.push(`${label}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

const npmPlugin = index.plugins.find(plugin => plugin.versions[0]?.source.type === 'npm')
const gitPlugin = index.plugins.find(plugin => plugin.versions[0]?.source.type === 'git')
if (npmPlugin !== undefined) process.stdout.write(`  npm install spec: ${marketInstallTarget(npmPlugin.name, npmPlugin.versions[0]).spec}\n`)
if (gitPlugin !== undefined) process.stdout.write(`  git install spec: ${marketInstallTarget(gitPlugin.name, gitPlugin.versions[0]).spec}\n`)
if (npmPlugin === undefined) failures.push('no npm-sourced plugin')
if (gitPlugin === undefined) failures.push('no git-sourced plugin')

const withIcon = index.plugins.filter(plugin => plugin.icon !== undefined).length
const withEngines = index.plugins.filter(plugin => plugin.versions[0]?.engines.dsh !== undefined).length
process.stdout.write(`  icons: ${String(withIcon)}, engines.dsh: ${String(withEngines)}\n`)

if (failures.length > 0) {
  process.stderr.write(`FAILED:\n${failures.map(failure => `  - ${failure}`).join('\n')}\n`)
  process.exit(1)
}
process.stdout.write('PASS\n')
