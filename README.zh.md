# dsh-pr-bot

[English](README.md) | 中文

一个跑在本机的 GitHub PR 审查机器人，审查由
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）完成。

它轮询一个或多个仓库，对每个新的 PR head 在本机跑一次只读 DSH 审查，把结论作为 GitHub review 发出去（带行内评论）；有阻塞问题就继续 `REQUEST_CHANGES`，直到 PR 干净为止。

```
PR open / push ──► 轮询 ──► dsh headless 审查 ──► GitHub review
                              （只读）            REQUEST_CHANGES
                                                 或 APPROVE
```

## 特性

- **不需要 webhook、隧道或公网入口。** bot 在本机主动调 GitHub API，能在 NAT 后面工作，凭据也只留在本地。
- **只读审查。** agent 以 `--permission-mode read-only` 跑在一次性 DSH 会话里，不会改动 checkout。
- **真正的审查门禁。** 配好 GitHub App 身份后，有阻塞问题提交 `REQUEST_CHANGES`，干净了提交 `APPROVE`；下一次 push 自动重新审查。
- **行内评论。** 模型返回结构化的 `dsh-inline` 块，bot 只保留落在 diff 右侧行号上的评论，随 review 一起提交；review 被 GitHub 拒绝时自动退回只发正文。
- **能在 DSH 里查看。** 每次审查都是 `$DSH_HOME` 下普通的持久化会话，之后可以从 DSH Web 的会话列表打开。
- **merge 后检查**（可选）：在已合并的 PR 上补一条简短评论。

## 要求

- Node.js **>= 24.9**（DSH 包的要求）
- `PATH` 里有 `npx`
- `~/.dsh/.env` 里有 `DEEPSEEK_API_KEY=sk-...`
  （headless DSH 不使用 GUI 的账号登录）
- 一个 GitHub App（推荐）或 token
- 要审查的仓库在本地有 checkout

## 快速开始

```sh
git clone https://github.com/<you>/dsh-pr-bot.git
cd dsh-pr-bot

# 1. 生成 ~/.config/dsh-pr-bot/config.json 和 env（交互式）
node scripts/dsh-pr-bot-setup.mjs

# 2. 预览这一轮会做什么
node scripts/dsh-pr-bot.mjs --once --dry-run

# 3. 真跑一轮
node scripts/dsh-pr-bot.mjs --once

# 4. 前台常驻
node scripts/dsh-pr-bot.mjs --loop
```

setup 脚本会从 checkout 的 `origin` 自动识别 `owner/name`、校验 App 私钥，然后写两个文件。非交互写法：

```sh
node scripts/dsh-pr-bot-setup.mjs \
  --repo owner/name --dir /path/to/checkout \
  --app-id 123456 --app-key ~/.config/dsh-pr-bot/app.pem
```

`--print` 只预览并对密钥打码；`--force` 覆盖已有文件。

## GitHub 评审身份

GitHub 不允许对自己的 PR 提交 approve 或 request changes。如果 token 属于 PR 作者，bot 会退化成 `COMMENT` 审查、把判定写在正文里，**不会阻塞合并**。

用一个 GitHub App 让 bot 以 `<app-slug>[bot]` 身份评审：

1. GitHub → Settings → Developer settings → GitHub Apps → **New GitHub App**。
2. Homepage URL：填仓库地址即可（只是展示用）。
3. Webhook 不勾选；Callback URL 留空。
4. Repository permissions：
   - **Contents**：Read-only
   - **Pull requests**：Read and write
   - **Issues**：Read and write（用于 merge 后的 PR 评论；关掉 `onMerge` 可以不配）
   - **Metadata**：Read-only（必选）
5. 创建后记下 **App ID**（About 区域），生成 private key，并 **Install App** 到目标仓库。
6. 保存凭据：

```sh
mkdir -p ~/.config/dsh-pr-bot
mv ~/Downloads/<app>.<date>.private-key.pem ~/.config/dsh-pr-bot/app.pem
chmod 600 ~/.config/dsh-pr-bot/app.pem
```

`~/.config/dsh-pr-bot/env`：

```sh
GITHUB_APP_ID=123456
GITHUB_APP_PRIVATE_KEY_PATH=/home/you/.config/dsh-pr-bot/app.pem
```

路径可以用 `~`。除了路径，也可以把单行 PEM 放进 `GITHUB_APP_PRIVATE_KEY`（换行写成 `\n`）。

要让 `REQUEST_CHANGES` 真的阻止合并，需要在仓库的分支保护里开启 **Require approvals**；GitHub App 的 review 会计入 required reviews。

没有 App 时，bot 依次回退到 `GITHUB_BOT_TOKEN`（另一个账号的 token）和 `GITHUB_TOKEN`（你本人的 token，自己的 PR 只能评论）。token 需要 Contents: read、Pull requests: write、Metadata: read。

## 配置

`~/.config/dsh-pr-bot/config.json`：

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

| 字段 | 默认值 | 含义 |
|---|---|---|
| `repos[].repo` | 必填 | `owner/name` |
| `repos[].dir` | 必填 | 用作审查工作区的本地 checkout |
| `repos[].base` | `main` | 只轮询目标为该分支的 PR |
| `intervalSeconds` | `120` | `--loop` 模式下的轮询间隔 |
| `maxReviewsPerRun` | `2` | 每轮最多启动几次审查（控制成本） |
| `onMerge` | `comment` | `comment` 为 merge 后评论，`off` 关闭 |
| `model` | `deepseek-flash` | 模型 id |
| `reasoningEffort` | `high` | 推理强度 |
| `dshVersion` | `0.2.2-rc.5` | 通过 `npx` 使用的 `@deepseek-ai/dsh` 版本 |
| `dshCommand` | `npx` | 启动 DSH 的命令（高级） |
| `stateDir` | `~/.local/state/dsh-pr-bot` | 已审查 head 的状态与锁 |

环境变量（bot 也会读取 `~/.config/dsh-pr-bot/env`）：

| 变量 | 含义 |
|---|---|
| `GITHUB_APP_ID` | GitHub App id |
| `GITHUB_APP_PRIVATE_KEY_PATH` | App 私钥路径 |
| `GITHUB_APP_PRIVATE_KEY` | 内联 PEM（路径的替代） |
| `GITHUB_BOT_TOKEN` | 可选的独立评审身份 token |
| `GITHUB_TOKEN` | 回退 token |
| `DSH_PR_BOT_API_BASE` | 覆盖 GitHub API 地址（仅测试） |

## 什么会触发审查

| 事件 | 行为 |
|---|---|
| PR 新建或 push | 对新 head 审查一次 |
| 草稿 PR | 跳过；转为 ready 后再审 |
| 同一个 head 再次轮询到 | 跳过（本地状态 + 已有 review 双重检查） |
| 新 PR 数超过 `maxReviewsPerRun` | 剩下的下一轮继续 |
| PR 已 merge | 发一条 post-merge 评论（`onMerge: "off"` 时没有） |

每次审查都是一个全新的 headless DSH 会话：push 三次就会产生三个会话。

## systemd（用户 timer）

把 `examples/dsh-pr-bot.service` 和 `examples/dsh-pr-bot.timer` 复制到
`~/.config/systemd/user/`，按需调整路径，然后：

```sh
systemctl --user daemon-reload
systemctl --user enable --now dsh-pr-bot.timer
loginctl enable-linger "$USER"   # 注销后也继续跑
journalctl --user -u dsh-pr-bot.service -f
```

timer 每两分钟跑一次 `--once`；每次都是新进程，某次审查卡住不会拖住下一轮。也可以把 `--loop` 放进 `Type=simple` + `Restart=always` 的 service。

## 安全说明

- 审查以你的用户身份跑在**只读**沙箱里，但 agent 能读文件、能联网。被 prompt injection 的 PR 可能尝试外泄本机内容或凭据。只对信任的仓库开启，并给 bot 单独的低额度 DeepSeek key。
- `GITHUB_*` 环境变量会被 DSH 子进程继承，App 私钥对你的用户也可读。审查不可信仓库时，建议用独立的系统用户或容器运行 bot。
- 所有 GitHub 写操作都由 bot 完成，agent 不会拿到写 token。
- `~/.config/dsh-pr-bot/env` 保持 `0600`，不要提交进仓库，也不要提交私钥。

## 限制

- 轮询意味着 1–2 分钟延迟（或 `intervalSeconds`），机器关机期间不触发。
- 行内评论只支持 diff 右侧行、每次最多 12 条；删除行或 hunk 之外的行号会被丢弃。
- 每次新 head 都整体审查，不跟踪已解决的 review thread。
- headless 会话会持久化在 DSH 里，但不会挂到 Web 工作区，所以侧边栏里显示在 **未分组**。
- 不支持行内 suggestion 或自动改代码。

## 目录结构

```
scripts/
  dsh-pr-bot.mjs       CLI、配置、轮询循环
  dsh-pr-bot-core.mjs  GitHub 调用、git、DSH 执行、审查提交、状态
  dsh-pr-bot-auth.mjs  GitHub App JWT 与 installation token
  dsh-pr-bot-diff.mjs  diff 行索引与行内评论解析
  dsh-pr-bot-setup.mjs 交互式配置生成
examples/
  config.json  env.example  dsh-pr-bot.service  dsh-pr-bot.timer
```

## 许可证

[MIT](LICENSE)
