#!/usr/bin/env node
// Create the configuration for scripts/dsh-pr-bot.mjs.
//
// Writes ~/.config/dsh-pr-bot/config.json and (when credentials are given)
// ~/.config/dsh-pr-bot/env. Auto-detects the repository from the checkout's
// origin remote, validates inputs, and refuses to overwrite existing files
// unless --force is passed.
//
// Usage:
//   node scripts/dsh-pr-bot-setup.mjs                     interactive
//   node scripts/dsh-pr-bot-setup.mjs --print             show, write nothing
//   node scripts/dsh-pr-bot-setup.mjs --repo owner/name --dir . \
//     --app-id 123456 --app-key ~/.config/dsh-pr-bot/app.pem
//   node scripts/dsh-pr-bot-setup.mjs --token ghp_...      user token fallback

import fs from 'node:fs/promises'
import { existsSync, readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import readline from 'node:readline/promises'

const CONFIG_DIR = path.join(process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), '.config'), 'dsh-pr-bot')
const DEFAULTS = { intervalSeconds: 120, maxReviewsPerRun: 2, onMerge: 'comment', model: 'deepseek-flash', base: 'main' }

function parseArgs(argv) {
  const options = {}
  const withValue = new Set(['--repo', '--dir', '--base', '--interval', '--model', '--on-merge',
    '--app-id', '--app-key', '--token', '--bot-token', '--config', '--credentials-file', '--max-reviews'])
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (withValue.has(arg)) options[arg.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = argv[++i]
    else if (arg === '--print') options.print = true
    else if (arg === '--force') options.force = true
    else if (arg === '--non-interactive') options.nonInteractive = true
    else if (arg === '--help') options.help = true
    else throw new Error(`unknown argument: ${arg}`)
  }
  return options
}

function usage() {
  console.log(`Usage: node scripts/dsh-pr-bot-setup.mjs [options]

  --repo <owner/name>   repository (default: detected from --dir's origin)
  --dir <path>          local checkout (default: cwd)
  --base <branch>       base branch (default: ${DEFAULTS.base})
  --interval <sec>      poll interval (default: ${DEFAULTS.intervalSeconds})
  --max-reviews <n>     reviews per poll (default: ${DEFAULTS.maxReviewsPerRun})
  --model <id>          model (default: ${DEFAULTS.model})
  --on-merge <mode>     comment | off (default: ${DEFAULTS.onMerge})
  --app-id <id>         GitHub App id, with --app-key for a real reviewer identity
  --app-key <path>      GitHub App private key (.pem)
  --token <token>       GITHUB_TOKEN fallback (only comments on your own PRs)
  --bot-token <token>   GITHUB_BOT_TOKEN (separate account reviewer)
  --config <path>       config file (default: ${path.join(CONFIG_DIR, 'config.json')})
  --credentials-file <path>  credentials file (default: ${path.join(CONFIG_DIR, 'env')})
  --print               print the files without writing
  --force               overwrite existing files
  --non-interactive     never prompt; fail when a required value is missing`)
}

function fail(message) {
  console.error(`error: ${message}`)
  process.exit(1)
}

async function ask(question, fallback) {
  if (!process.stdin.isTTY) return fallback
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  try {
    const answer = (await rl.question(`${question}${fallback === undefined ? '' : ` [${fallback}]`}: `)).trim()
    return answer === '' ? fallback : answer
  } finally {
    rl.close()
  }
}

async function askHidden(question) {
  if (!process.stdin.isTTY) return ''
  process.stdout.write(`${question}: `)
  const stdin = process.stdin
  stdin.setRawMode(true)
  stdin.resume()
  stdin.setEncoding('utf8')
  let value = ''
  return new Promise((resolve) => {
    const finish = () => {
      stdin.setRawMode(false)
      stdin.pause()
      stdin.removeListener('data', onData)
      process.stdout.write('\n')
      resolve(value)
    }
    const onData = (chunk) => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') return finish()
        if (ch === '\u0003') {
          stdin.setRawMode(false)
          process.stdout.write('\n')
          process.exit(130)
        }
        if (ch === '\u007f') {
          if (value !== '') {
            value = value.slice(0, -1)
            process.stdout.write('\b \b')
          }
        } else if (ch >= ' ') {
          value += ch
          process.stdout.write('*')
        }
      }
    }
    stdin.on('data', onData)
  })
}

function parseGitHubRemote(url) {
  const match = /github\.com[:/]+([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?\s*$/i.exec(url.trim())
  return match === null ? null : `${match[1]}/${match[2]}`
}

async function detectRepo(dir) {
  const { execFile } = await import('node:child_process')
  const url = await new Promise((resolve) => {
    execFile('git', ['-C', dir, 'config', '--get', 'remote.origin.url'], (error, stdout) => {
      resolve(error === null ? stdout.trim() : '')
    })
  })
  return url === '' ? null : parseGitHubRemote(url)
}

function validateRepo(repo) {
  if (typeof repo !== 'string' || !/^[^\s/]+\/[^\s/]+$/.test(repo)) fail(`invalid repository: ${repo}`)
  return repo
}

async function validateDir(dir) {
  const target = path.resolve(dir)
  if (!existsSync(target)) fail(`checkout does not exist: ${target}`)
  const { execFile } = await import('node:child_process')
  const ok = await new Promise((resolve) => {
    execFile('git', ['-C', target, 'rev-parse', '--is-inside-work-tree'], (error) => resolve(error === null))
  })
  if (!ok) fail(`not a git checkout: ${target}`)
  return target
}

async function validateAppKey(file) {
  const target = path.resolve(file.startsWith('~/') ? path.join(os.homedir(), file.slice(2)) : file)
  if (!existsSync(target)) fail(`app private key not found: ${target}`)
  const body = await fs.readFile(target, 'utf8')
  if (!/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(body)) fail(`not a PEM private key: ${target}`)
  return target
}

function positiveInteger(value, name, fallback) {
  if (value === undefined) return fallback
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < 1) fail(`${name} must be a positive integer`)
  return parsed
}

async function collect(options) {
  const dir = await validateDir(options.dir ?? process.cwd())
  const detected = await detectRepo(dir)
  let repo = options.repo ?? detected
  if (options.repo !== undefined) validateRepo(options.repo)
  if (repo !== null && detected !== null && repo !== detected) {
    console.warn(`warning: --repo ${repo} differs from origin ${detected}`)
  }
  if (repo === null) {
    if (options.nonInteractive) fail('cannot detect a GitHub repository; pass --repo owner/name')
    repo = await ask('GitHub repository (owner/name)')
  }
  validateRepo(repo)

  const base = (options.base ?? (await ask('Base branch', DEFAULTS.base))).trim()
  if (base === '') fail('base branch must not be empty')
  const interval = positiveInteger(options.interval, 'interval', DEFAULTS.intervalSeconds)
  const maxReviews = positiveInteger(options.maxReviews, 'max reviews', DEFAULTS.maxReviewsPerRun)
  const model = options.model ?? (await ask('Model', DEFAULTS.model))
  const onMerge = options.onMerge ?? DEFAULTS.onMerge
  if (onMerge !== 'comment' && onMerge !== 'off') fail('on-merge must be comment or off')

  const appId = options.appId ?? null
  const appKey = options.appKey === undefined ? null : await validateAppKey(options.appKey)
  if ((appId === null) !== (appKey === null)) fail('--app-id and --app-key must be given together')
  if (appId !== null && !/^\d+$/.test(appId)) fail('--app-id must be numeric')

  const token = options.token ?? process.env.GITHUB_TOKEN ?? null
  const botToken = options.botToken ?? process.env.GITHUB_BOT_TOKEN ?? null
  if (appId === null && token === null && botToken === null && options.print === true) {
    return finish({ repo, dir, base, interval, maxReviews, model, onMerge, appId, appKey, token, botToken, options })
  }
  if (appId === null && token === null && botToken === null) {
    if (options.nonInteractive || !process.stdin.isTTY) {
      fail('no credentials: pass --app-id/--app-key, --bot-token or --token')
    }
    console.log('\n没有检测到凭据。选择评审身份:')
    console.log('  1) GitHub App(推荐,可以对任何 PR 提交 request-changes/approve)')
    console.log('  2) 另一个账号的 PAT(GITHUB_BOT_TOKEN)')
    console.log('  3) 你本人的 PAT(GITHUB_TOKEN,自己的 PR 只能评论)')
    const choice = await ask('选择 1/2/3', '1')
    if (choice === '1') {
      const id = await ask('GitHub App id')
      const key = await ask('GitHub App private key path')
      return finish({ repo, dir, base, interval, maxReviews, model, onMerge, appId: id, appKey: await validateAppKey(key), token: null, botToken: null, options })
    }
    if (choice === '2') {
      const secret = await askHidden('GITHUB_BOT_TOKEN')
      if (secret === '') fail('empty token')
      return finish({ repo, dir, base, interval, maxReviews, model, onMerge, appId: null, appKey: null, token: null, botToken: secret, options })
    }
    const secret = await askHidden('GITHUB_TOKEN')
    if (secret === '') fail('empty token')
    return finish({ repo, dir, base, interval, maxReviews, model, onMerge, appId: null, appKey: null, token: secret, botToken: null, options })
  }
  return finish({ repo, dir, base, interval, maxReviews, model, onMerge, appId, appKey, token, botToken, options })
}

function finish(values) {
  return values
}

function buildConfig(values) {
  return `${JSON.stringify({
    repos: [{ repo: values.repo, dir: values.dir, base: values.base }],
    intervalSeconds: values.interval,
    maxReviewsPerRun: values.maxReviews,
    onMerge: values.onMerge,
    model: values.model,
  }, null, 2)}\n`
}

function buildEnv(values) {
  const lines = []
  if (values.appId !== null) {
    lines.push(`GITHUB_APP_ID=${values.appId}`, `GITHUB_APP_PRIVATE_KEY_PATH=${values.appKey}`)
  }
  if (values.botToken !== null) lines.push(`GITHUB_BOT_TOKEN=${values.botToken}`)
  if (values.token !== null) lines.push(`GITHUB_TOKEN=${values.token}`)
  return lines.length === 0 ? '' : `${lines.join('\n')}\n`
}

function mask(secret) {
  if (secret.length <= 8) return '********'
  return `${secret.slice(0, 4)}...${secret.slice(-4)}`
}

function maskedEnv(values) {
  return buildEnv(values).split('\n').map((line) => {
    const match = /^(GITHUB_BOT_TOKEN|GITHUB_TOKEN)=(.*)$/.exec(line)
    return match === null ? line : `${match[1]}=${mask(match[2])}`
  }).join('\n')
}

function deepseekWarning() {
  const envPath = path.join(process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh'), '.env')
  if (!existsSync(envPath)) return `缺少 ${envPath},请写入 DEEPSEEK_API_KEY=sk-...`
  try {
    return readFileSync(envPath, 'utf8').includes('DEEPSEEK_API_KEY=') ? null : `${envPath} 里没有 DEEPSEEK_API_KEY`
  } catch {
    return `无法读取 ${envPath},请确认里面有 DEEPSEEK_API_KEY=sk-...`
  }
}

async function writeFiles(values) {
  const configPath = path.resolve(values.options.config ?? path.join(CONFIG_DIR, 'config.json'))
  const envPath = path.resolve(values.options.credentialsFile ?? path.join(CONFIG_DIR, 'env'))
  await fs.mkdir(path.dirname(configPath), { recursive: true, mode: 0o700 })
  await fs.mkdir(path.dirname(envPath), { recursive: true, mode: 0o700 })
  await fs.writeFile(configPath, buildConfig(values), { mode: 0o644 })
  const env = buildEnv(values)
  if (env !== '') {
    await fs.writeFile(envPath, env, { mode: 0o600 })
    await fs.chmod(envPath, 0o600)
  }
  console.log(`wrote ${configPath}`)
  if (env !== '') console.log(`wrote ${envPath} (0600)`)
  console.log('\n下一步:')
  console.log(`  node scripts/dsh-pr-bot.mjs --once --dry-run`)
  console.log(`  node scripts/dsh-pr-bot.mjs --once`)
  console.log('  定时运行见 WORKFLOW.md 的 systemd timer 示例。')
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options.help) return usage()
  const values = await collect(options)
  if (options.print) {
    console.log('--- config.json ---')
    process.stdout.write(buildConfig(values))
    if (buildEnv(values) !== '') {
      console.log('\n--- env ---')
      process.stdout.write(maskedEnv(values))
    }
    return
  }
  if (values.options.force !== true) {
    const configPath = path.resolve(options.config ?? path.join(CONFIG_DIR, 'config.json'))
    const envPath = path.resolve(options.credentialsFile ?? path.join(CONFIG_DIR, 'env'))
    if (existsSync(configPath) || existsSync(envPath)) {
      if (options.nonInteractive || !process.stdin.isTTY) {
        fail('configuration already exists; pass --force to overwrite')
      }
      const answer = await ask('配置文件已存在,覆盖? (y/N)', 'N')
      if (answer.toLowerCase() !== 'y') fail('aborted')
    }
  }
  await writeFiles(values)
  const warning = deepseekWarning()
  if (warning !== null) console.warn(`\nwarning: ${warning}`)
  console.log('\n注意: DEEPSEEK_API_KEY 由 dsh headless 读取,不写进 bot 的 env 文件。')
}

main().catch((error) => fail(error.message))
