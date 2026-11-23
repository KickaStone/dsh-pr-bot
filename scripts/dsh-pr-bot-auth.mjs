// GitHub App authentication for scripts/dsh-pr-bot.mjs.
//
// A GitHub App gives the bot its own reviewer identity, so it can submit
// REQUEST_CHANGES / APPROVE on pull requests its owner authored. Tokens are
// minted per repository installation and cached until shortly before expiry.

import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

export function appCredentials(env) {
  if (!env.GITHUB_APP_ID) return null
  const inline = env.GITHUB_APP_PRIVATE_KEY
  const keyPath = env.GITHUB_APP_PRIVATE_KEY_PATH
  if (!inline && !keyPath) {
    throw new Error('set GITHUB_APP_PRIVATE_KEY or GITHUB_APP_PRIVATE_KEY_PATH with GITHUB_APP_ID')
  }
  return { appId: env.GITHUB_APP_ID, inline, keyPath }
}

async function privateKey(creds) {
  if (creds.inline) return creds.inline.replace(/\\n/g, '\n')
  const target = creds.keyPath.startsWith('~/')
    ? path.join(os.homedir(), creds.keyPath.slice(2))
    : creds.keyPath
  return fs.readFile(target, 'utf8')
}

export async function appJwt(creds) {
  const key = await privateKey(creds)
  const now = Math.floor(Date.now() / 1000)
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url')
  const unsigned = `${encode({ alg: 'RS256', typ: 'JWT' })}.${encode({
    iat: now - 60,
    exp: now + 540,
    iss: creds.appId,
  })}`
  const signature = crypto.createSign('RSA-SHA256').update(unsigned).sign(key, 'base64url')
  return `${unsigned}.${signature}`
}

async function appRequest(apiBase, jwt, method, route) {
  const response = await fetch(`${apiBase}${route}`, {
    method,
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${jwt}`,
      'user-agent': 'dsh-pr-bot',
      'x-github-api-version': '2022-11-28',
    },
  })
  const text = await response.text()
  if (!response.ok) {
    throw new Error(`GitHub app ${method} ${route} -> ${response.status}: ${text.slice(0, 300)}`)
  }
  return text === '' ? null : JSON.parse(text)
}

export async function appSlug(creds, apiBase) {
  const app = await appRequest(apiBase, await appJwt(creds), 'GET', '/app')
  if (typeof app.slug !== 'string' || app.slug === '') throw new Error('GitHub app has no slug')
  return app.slug
}

export function createTokenFor(creds, apiBase) {
  const installations = new Map()
  const tokens = new Map()
  return async (repo) => {
    const cached = tokens.get(repo)
    if (cached && cached.expiresAt - 120_000 > Date.now()) return cached.token
    let installationId = installations.get(repo)
    if (installationId === undefined) {
      const jwt = await appJwt(creds)
      installationId = (await appRequest(apiBase, jwt, 'GET', `/repos/${repo}/installation`)).id
      installations.set(repo, installationId)
    }
    const created = await appRequest(
      apiBase,
      await appJwt(creds),
      'POST',
      `/app/installations/${installationId}/access_tokens`,
    )
    tokens.set(repo, { token: created.token, expiresAt: Date.parse(created.expires_at) })
    return created.token
  }
}
