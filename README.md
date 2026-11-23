# dsh-pr-bot

A local GitHub pull-request review bot powered by
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH).

It polls one or more repositories, reviews every new PR head in a read-only DSH
session on your own machine, posts the findings as a GitHub review with inline
comments, and keeps requesting changes until the PR is clean.

```
PR opened / pushed ──► poll ──► dsh headless review ──► GitHub review
                                   (read-only)          REQUEST_CHANGES
                                                        or APPROVE
```

## Features

- **No webhook, no tunnel, no public endpoint.** The bot polls the GitHub API
  from your machine, so it works behind NAT and keeps credentials local.
- **Read-only reviews.** The agent runs with `--permission-mode read-only` in a
  throwaway DSH session and never edits the checkout.
- **Real review gating.** With a GitHub App identity it submits
  `REQUEST_CHANGES` while blocking findings remain and `APPROVE` once the head
  is clean. The next push triggers a fresh review.
- **Inline comments.** The model returns a structured `dsh-inline` block; the
  bot keeps only comments that land on a right-side diff line and submits them
  with the review. A rejected review falls back to a body-only review.
- **Visible in DSH.** Each review is an ordinary persisted DSH session under
  `$DSH_HOME`; open it from the DSH Web session list afterwards.
- **Post-merge check** (optional): a short comment on the merged PR.

## Requirements

- Node.js **>= 24.9** (the DSH package requires it)
- `npx` on `PATH`
- A DeepSeek API key in `~/.dsh/.env` as `DEEPSEEK_API_KEY=sk-...`
  (headless DSH does not use the GUI account login)
- A GitHub App (recommended) or a token
- Local checkouts of the repositories you want reviewed

## Quick start

```sh
git clone https://github.com/<you>/dsh-pr-bot.git
cd dsh-pr-bot

# 1. Create ~/.config/dsh-pr-bot/config.json and env (interactive)
node scripts/dsh-pr-bot-setup.mjs

# 2. Preview what a poll would do
node scripts/dsh-pr-bot.mjs --once --dry-run

# 3. Run one real poll
node scripts/dsh-pr-bot.mjs --once

# 4. Run continuously in the foreground
node scripts/dsh-pr-bot.mjs --loop
```

The setup script detects `owner/name` from the checkout's `origin` remote,
validates the App private key, and writes both files. Non-interactive example:

```sh
node scripts/dsh-pr-bot-setup.mjs \
  --repo owner/name --dir /path/to/checkout \
  --app-id 123456 --app-key ~/.config/dsh-pr-bot/app.pem
```

`--print` previews with masked secrets; `--force` overwrites existing files.

## GitHub identity

GitHub does not allow approving or requesting changes on your own pull request.
If the token belongs to the PR author, the bot degrades to a `COMMENT` review
with the verdict in the body — it will not block merging.

Create a GitHub App so the bot reviews as `<app-slug>[bot]`:

1. GitHub → Settings → Developer settings → GitHub Apps → **New GitHub App**.
2. Homepage URL: your repository URL (informational only).
3. Webhook: leave inactive; Callback URL: leave empty.
4. Repository permissions:
   - **Contents**: Read-only
   - **Pull requests**: Read and write
   - **Issues**: Read and write (for the post-merge PR comment; skip if you
     disable `onMerge`)
   - **Metadata**: Read-only (mandatory)
5. Create the App, note the **App ID** (About section), generate a private key,
   and **Install App** on the target repository.
6. Store the credentials:

```sh
mkdir -p ~/.config/dsh-pr-bot
mv ~/Downloads/<app>.<date>.private-key.pem ~/.config/dsh-pr-bot/app.pem
chmod 600 ~/.config/dsh-pr-bot/app.pem
```

`~/.config/dsh-pr-bot/env`:

```sh
GITHUB_APP_ID=123456
GITHUB_APP_PRIVATE_KEY_PATH=/home/you/.config/dsh-pr-bot/app.pem
```

The path may use `~`. Instead of a path you can put a single-line PEM in
`GITHUB_APP_PRIVATE_KEY` with `\n` escapes.

To make `REQUEST_CHANGES` actually block merging, enable **Require approvals**
in the repository's branch protection; a GitHub App review counts as a required
review.

Without an App, the bot falls back to `GITHUB_BOT_TOKEN` (another account's
token) and then `GITHUB_TOKEN` (your own token, comment-only on your PRs).
The token needs Contents: read, Pull requests: write, Metadata: read.

## Configuration

`~/.config/dsh-pr-bot/config.json`:

```json
{
  "repos": [
    { "repo": "owner/name", "dir": "/path/to/checkout", "base": "main" }
  ],
  "intervalSeconds": 120,
  "maxReviewsPerRun": 2,
  "onMerge": "comment",
  "model": "deepseek-flash",
  "reasoningEffort": "high"
}
```

| Key | Default | Meaning |
|---|---|---|
| `repos[].repo` | required | `owner/name` |
| `repos[].dir` | required | local checkout used as the review workspace |
| `repos[].base` | `main` | only PRs targeting this branch are polled |
| `intervalSeconds` | `120` | delay between polls in `--loop` mode |
| `maxReviewsPerRun` | `2` | reviews started per poll (bounds cost) |
| `onMerge` | `comment` | `comment` for a post-merge comment, `off` to skip |
| `model` | `deepseek-flash` | model id |
| `reasoningEffort` | `high` | reasoning effort |
| `dshVersion` | `0.2.2-rc.5` | `@deepseek-ai/dsh` version used via `npx` |
| `dshCommand` | `npx` | command that launches DSH (advanced) |
| `stateDir` | `~/.local/state/dsh-pr-bot` | reviewed-head state and lock |

Environment (the bot also reads `~/.config/dsh-pr-bot/env`):

| Variable | Meaning |
|---|---|
| `GITHUB_APP_ID` | GitHub App id |
| `GITHUB_APP_PRIVATE_KEY_PATH` | App private key path |
| `GITHUB_APP_PRIVATE_KEY` | inline PEM (alternative to the path) |
| `GITHUB_BOT_TOKEN` | optional separate reviewer token |
| `GITHUB_TOKEN` | fallback token |
| `DSH_PR_BOT_API_BASE` | override the GitHub API base (tests only) |

## What triggers a review

| Event | Behavior |
|---|---|
| PR opened or pushed | review the new head once |
| Draft PR | skipped; reviewed after it becomes ready |
| Same head seen again | skipped (local state + existing review check) |
| More new PRs than `maxReviewsPerRun` | remaining ones are picked up next poll |
| PR merged | one post-merge comment (unless `onMerge: "off"`) |

Each review is a new headless DSH session. Pushing three times produces three
sessions.

## systemd (user timer)

Copy `examples/dsh-pr-bot.service` and `examples/dsh-pr-bot.timer` to
`~/.config/systemd/user/`, adjust the paths, then:

```sh
systemctl --user daemon-reload
systemctl --user enable --now dsh-pr-bot.timer
loginctl enable-linger "$USER"   # keep running when logged out
journalctl --user -u dsh-pr-bot.service -f
```

The timer runs `--once` every two minutes; each run is a fresh process, so a
stuck review cannot delay the next poll. Alternatively run `--loop` under a
`Type=simple` service with `Restart=always`.

## Security notes

- Reviews run as your user in a **read-only** sandbox, but the agent can read
  files and use the network. A prompt-injected PR could try to exfiltrate local
  content or credentials. Only enable the bot on repositories you trust, and
  give it a dedicated DeepSeek key with a small quota.
- `GITHUB_*` variables are inherited by the DSH child process and the App
  private key is readable by your user. For untrusted repositories, run the bot
  under a dedicated OS user or container.
- The bot itself performs every GitHub write; the agent is not given a write
  token by design.
- Keep `~/.config/dsh-pr-bot/env` at mode `0600`; never commit it or the
  private key.

## Limitations

- Polling means one to two minutes of latency (or `intervalSeconds`), and
  nothing happens while the machine is off.
- Inline comments are limited to right-side diff lines and 12 per review;
  comments on deleted lines or outside hunks are dropped.
- The bot reviews the whole PR at each new head; it does not track resolved
  threads.
- Headless sessions are persisted in DSH but not attached to a Web workspace,
  so the DSH sidebar lists them under **Ungrouped**.
- No inline suggestions or automatic code fixes.

## Layout

```
scripts/
  dsh-pr-bot.mjs       CLI, config, poll loop
  dsh-pr-bot-core.mjs  GitHub calls, git plumbing, DSH run, reviews, state
  dsh-pr-bot-auth.mjs  GitHub App JWT and installation tokens
  dsh-pr-bot-diff.mjs  diff line index and inline-comment parsing
  dsh-pr-bot-setup.mjs interactive config generator
examples/
  config.json  env.example  dsh-pr-bot.service  dsh-pr-bot.timer
```
