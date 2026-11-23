#!/usr/bin/env node
// Poll GitHub pull requests for the configured repositories, review each new
// head locally with DeepSeek Harness, and submit a GitHub review:
// REQUEST_CHANGES while blocking findings remain, APPROVE once clean.
//
// Sessions run through `dsh headless` with the caller's DSH_HOME, so every
// review also shows up in the local DSH Web session list.
//
// Usage:
//   node scripts/dsh-pr-bot.mjs --once            one poll, then exit
//   node scripts/dsh-pr-bot.mjs --loop            poll forever
//   node scripts/dsh-pr-bot.mjs --repo owner/name --dir /path/to/checkout --once
//
// Configuration: ~/.config/dsh-pr-bot/config.json (see WORKFLOW.md).
// Credentials:   GITHUB_TOKEN (required), DEEPSEEK_API_KEY (via ~/.dsh/.env),
//                optional GITHUB_BOT_TOKEN for a separate reviewer identity.

import fs from 'node:fs/promises'
import { existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  API_BASE,
  acquireLock,
  api,
  expandHome,
  fail,
  loadEnvFile,
  log,
  pollRepo,
  readState,
  writeState,
} from './dsh-pr-bot-core.mjs'
import { appCredentials, appSlug, createTokenFor } from './dsh-pr-bot-auth.mjs'

const DEFAULT_CONFIG = path.join(
  process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), '.config'),
  'dsh-pr-bot',
  'config.json',
)

function requireRepoArg(options, flag, value) {
  if (options.repos.length === 0) throw new Error(`${flag} must follow --repo owner/name`)
  return value
}

function parseArgs(argv) {
  const options = { once: false, loop: false, dryRun: false, noModel: false, repos: [] }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--once') options.once = true
    else if (arg === '--loop') options.loop = true
    else if (arg === '--dry-run') options.dryRun = true
    else if (arg === '--no-model') options.noModel = true
    else if (arg === '--help') options.help = true
    else if (arg === '--config') options.config = argv[++i]
    else if (arg === '--interval') options.interval = Number(argv[++i])
    else if (arg === '--repo') options.repos.push({ repo: argv[++i], dir: null, base: null })
    else if (arg === '--dir') options.repos.at(-1).dir = requireRepoArg(options, arg, argv[++i])
    else if (arg === '--base') options.repos.at(-1).base = requireRepoArg(options, arg, argv[++i])
    else throw new Error(`unknown argument: ${arg}`)
  }
  return options
}

function usage() {
  console.log(`Usage: node scripts/dsh-pr-bot.mjs [--once|--loop] [options]

  --once             poll once and exit (default)
  --loop             poll forever
  --interval <sec>   seconds between polls (default from config: 120)
  --config <path>    config file (default: ${DEFAULT_CONFIG})
  --repo <owner/name>  repository to watch, repeatable (overrides config)
  --dir <path>       checkout for the preceding --repo (default: cwd)
  --base <branch>    base branch for the preceding --repo (default: main)
  --no-model         skip the model call, use a placeholder review (smoke test)
  --dry-run          show what would happen without calling GitHub writes

Environment:
  GITHUB_APP_ID / GITHUB_APP_PRIVATE_KEY_PATH   GitHub App reviewer identity;
      makes APPROVE / REQUEST_CHANGES work on your own pull requests
  GITHUB_TOKEN        fallback token; repo scope or pull-requests: write
  GITHUB_BOT_TOKEN    optional fallback reviewer identity (another account)
  DEEPSEEK_API_KEY    read by dsh headless from ~/.dsh/.env or the environment
  DSH_PR_BOT_API_BASE override the GitHub API base (tests only)`)
}

async function loadConfig(options) {
  let config = { repos: [], intervalSeconds: 120, maxReviewsPerRun: 2, onMerge: 'comment' }
  if (existsSync(options.config ?? DEFAULT_CONFIG)) {
    const raw = JSON.parse(await fs.readFile(options.config ?? DEFAULT_CONFIG, 'utf8'))
    config = { ...config, ...raw }
  }
  if (options.repos.length > 0) {
    config.repos = options.repos.map((entry) => ({
      repo: entry.repo,
      dir: path.resolve(entry.dir ?? process.cwd()),
      base: entry.base ?? undefined,
    }))
  }
  if (options.interval !== undefined) config.intervalSeconds = options.interval
  if (config.repos.length === 0) {
    throw new Error(`no repositories configured; create ${DEFAULT_CONFIG} or pass --repo owner/name`)
  }
  config.repos = config.repos.map((entry) => ({
    repo: entry.repo,
    dir: path.resolve(expandHome(entry.dir ?? '.')),
    base: entry.base ?? 'main',
  }))
  for (const entry of config.repos) {
    if (!/^[^/\s]+\/[^/\s]+$/.test(entry.repo ?? '')) throw new Error(`invalid repo: ${entry.repo}`)
  }
  if (config.stateDir) config.stateDir = expandHome(config.stateDir)
  return config
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options.help) {
    usage()
    return
  }
  if (options.noModel && !options.dryRun && !process.env.DSH_PR_BOT_API_BASE) {
    throw new Error('--no-model is a smoke test; combine it with --dry-run or DSH_PR_BOT_API_BASE')
  }
  const config = await loadConfig(options)
  await loadEnvFile()
  const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN
  const app = appCredentials(process.env)
  let identity
  let tokenFor
  if (app !== null) {
    identity = { login: `${await appSlug(app, API_BASE)}[bot]` }
    tokenFor = createTokenFor(app, API_BASE)
  } else {
    if (!token) throw new Error('GITHUB_TOKEN is required (or configure a GitHub App)')
    const reviewerToken = process.env.GITHUB_BOT_TOKEN ?? token
    identity = await api(reviewerToken, 'GET', '/user')
    tokenFor = async () => reviewerToken
  }
  const stateDir = config.stateDir ?? path.join(os.homedir(), '.local', 'state', 'dsh-pr-bot')
  await fs.mkdir(stateDir, { recursive: true })
  let lock
  try {
    lock = await acquireLock(stateDir)
  } catch (error) {
    if (/another run is active/.test(error.message)) {
      log('another run is active; skipping this poll')
      return
    }
    throw error
  }
  try {
    const state = await readState(stateDir)
    const context = {
      tokenFor,
      identity,
      config,
      stateDir,
      state,
      dryRun: options.dryRun,
      noModel: options.noModel,
    }
    log(`reviewing as ${identity.login} (${config.repos.length} repo(s))`)
    do {
      let count = 0
      for (const entry of config.repos) {
        try {
          count += await pollRepo(context, entry)
        } catch (error) {
          fail(`${entry.repo}: ${error.message}`)
        }
      }
      await writeState(stateDir, state)
      if (!options.loop) break
      log(`sleeping ${config.intervalSeconds}s (${count} review(s) this poll)`)
      await new Promise((resolve) => setTimeout(resolve, config.intervalSeconds * 1000))
    } while (true)
  } finally {
    await lock.release()
  }
}

main().catch((error) => {
  fail(error.stack ?? error.message)
})
