# SDD 平台条件式等待契约（pi 适配）

## 要解决什么

`/Users/bachi/jaylli/superpowers` 是官方 superpowers 的 fork（HEAD == `origin/main` == `8ca22db`，v6.4.2，SDD 补丁尚未打）。

官方 SDD 的等待段落是为「平台无原生唤醒、必须轮询」写的：

> When you are genuinely idle, wait in bounded stretches (five to ten minutes, where your platform allows) ...

pi 有原生唤醒，同一句话被照读成「每 10 分钟轮询一次」，在 8.8 小时的会话里产生了 5.73 小时的 `bg_wait` 阻塞（其中 3.0 小时是调满 600s 窗口的空转）。

本次把已定稿的 SDD 修改落进 fork，把 skills 装到 `~/.agents/skills`，并补上文档说明。

## 现状（已核实，非推测）

| 项 | 状态 |
| --- | --- |
| `/Users/bachi/jaylli/superpowers` | fork，HEAD == `origin/main` == `8ca22db`，工作区干净，0 本地提交 |
| SDD 补丁 | **未打**。`skills/subagent-driven-development/SKILL.md:239-244` 仍是 upstream 原文 |
| `~/.codex/superpowers` | 已删除 |
| `~/.agents/skills/superpowers` | 符号链接**已不存在** → 全局当前 0 个 superpowers 技能 |
| `~/.agents/skills/` 残留 | `superpowers.new/`（旧 clone + 已提交补丁）、`.writetest/`、`.gitignore` |
| 沙箱 | `~/.agents` 属**永不删除档**，`rm` 无放行；创建/写不受限（`ln -s` 可做） |

原有的全局安装方式是 **clone + symlink**——`RELEASE-NOTES.md:730` 记录 Codex 走 `~/.agents/skills/superpowers/` symlink，本机历史链接也吻合。本次沿用同一方式，只把已废弃的 `~/.codex` 位置换成 `~/.agents/superpowers`。

## 改动清单

### 1. `skills/subagent-driven-development/SKILL.md`（核心，+17/−6）

只替换 239-244 这 6 行。235-238、frontmatter、两个 ` ```dot ` 图块一律不动。

删除：

```
When you are genuinely idle, wait in bounded stretches (five to ten
minutes, where your platform allows), and between stretches post one
line of status and reconcile your live children: list them, and chase
any that finished without reporting. A bounded stretch keeps nearly
all of a long wait's efficiency while guaranteeing a stuck or lost
child is noticed within minutes, not at the end of the session.
```

插入：

```

**Check your platform before you choose a wait.** On a platform where a
completed child *wakes the parent session natively* (pi, and any harness
with an async completion notifier), do not call a blocking wait tool for a
dispatched subagent at all: launch the child, then end the turn or do
other work, and let the completion wake you. The wait there buys nothing
and costs the whole wait in wall clock — it silently converts a parallel
workflow into a serial one. Reserve the blocking wait for provider or
detached work that has no wake path.

On a platform with no native wake (Claude Code, Codex), when you are
genuinely idle, wait in bounded stretches (five to ten minutes, where
your platform allows), and between stretches post one line of status and
reconcile your live children: list them, and chase any that finished
without reporting. A bounded stretch keeps nearly all of a long wait's
efficiency while guaranteeing a stuck or lost child is noticed within
minutes, not at the end of the session.
```

**为什么是条件句而不是直接删掉**：原段落对 Claude Code / Codex 是正确的（那边必须轮询），无条件下发才是 bug。保留原句给真正需要它的平台，pi 走新分支。这样既是修 bug，也是能站得住的 upstream 形态。

行数 568 → 579。

### 2. `README.md` — `### Pi` 一节（236-250 行）

在现有「pi install / pi -e」之后补三小节：

- **Global install from a fork** — clone + symlink（原有方式）：
  ```bash
  git clone git@github.com:jayli/superpowers.git ~/.agents/superpowers
  ln -sfn ~/.agents/superpowers/skills ~/.agents/skills/superpowers
  ```
  说明取舍：让所有项目都有这 15 个技能，**但不加载** `.pi/extensions/superpowers.ts`，所以没有 `using-superpowers` 的 bootstrap 注入；要 bootstrap 就用 `pi install`。
- **Pi wait contract (local patch)** — 说清 fork 里这处补丁是什么、为什么（pi 有原生唤醒，轮询把并行流程串行化），以及它是已提交的本地补丁而非重写。
- **Upgrade** — `git -C ~/.agents/superpowers pull`；若在 SDD 那一个 hunk 冲突，说明 upstream 动了同一段，重打 `**Check your platform before you choose a wait.**` 块、保留 upstream 其余改动。

### 3. `AGENTS.md` — 顶部新增 `## Local patch`

放在 `# Superpowers — Contributor Guidelines` 之后、`## If You Are an AI Agent` 之前。理由：下面整篇是 upstream 的 PR 规则，而本仓库是 fork 且带本地补丁——任何 AI agent 必须先知道这一点，否则会拿着 upstream 的规则去操作这个 fork。

内容：一句「This is a fork」的定位；一张表（改的文件 / 改了什么）；三条规则——不要把这个补丁提给 upstream（它编码的是单一 harness 的机制，而 upstream 只收跨 harness 通用的改动）、保持为「单段补丁」而不是重写（只在等待段落改，upstream 动别处时补丁仍可用）、每次升级后重新验证该段落仍是平台条件式的。

### 4. 提交 + push

一个提交，覆盖上述三个文件（SDD 改动 + 它的两份文档说明，是同一件事）：

```
local(pi): platform-conditional wait contract in SDD
```

推到 `git@github.com:jayli/superpowers.git` 的 `main`（用户已确认）。

### 5. 全局安装到 `~/.agents/skills`

**需要用户先在终端执行清残留**——`~/.agents` 在沙箱永不删除档：

```bash
rm -rf /Users/bachi/.agents/skills/superpowers.new
rm -rf /Users/bachi/.agents/skills/.writetest
rm -f  /Users/bachi/.agents/skills/.gitignore
```

用户执行后：

```bash
git clone git@github.com:jayli/superpowers.git /Users/bachi/.agents/superpowers
ln -sfn /Users/bachi/.agents/superpowers/skills /Users/bachi/.agents/skills/superpowers
```

`superpowers.new` 里那份已提交的 SDD 补丁（`fa5b26b`）与本次要写的逐字节相同，删除前再 `diff` 一次确认。

## 验证

| 检查 | 判据 |
| --- | --- |
| 补丁文本与已验证版本一致 | `git diff --stat` → 1 文件 17+/6−；SDD 行数 568→579 |
| 只动了一个 hunk | `git diff` 里只有一处 `@@`；frontmatter 与两个 ` ```dot ` 块未被触及 |
| 段落确实变成条件式 | `grep -c "Check your platform before you choose a wait"` = 1，且 "bounded stretches" 仍存在 |
| 技能真能被 pi 发现 | 用 pi 自己的 `loadSkillsFromDir` 实跑 `~/.agents/skills/` → 15 个 superpowers 技能、0 collision |
| 安装点与 fork 一致 | `diff -r ~/.agents/superpowers/skills /Users/bachi/jaylli/superpowers/skills` → 无差异 |
| 文档里的命令可执行 | 原样跑 README 里的 clone/symlink/pull（幂等），输出符合描述 |
| 仓库自带测试不被破坏 | `node --test tests/pi/test-pi-extension.mjs`；`tests/` 里没有断言 SDD 等待段落的用例 |
| push 结果 | `git log origin/main -1` 与本提交一致 |

## 不动的东西

- **不碰 `skills/using-superpowers/references/codex-tools.md` 里的 "bounded stretches"**——它在 Codex 专属参考里，且自己写明了前提「Completion mail cannot wake an idle controller」，那句是对的。真正错的是 SDD 里无条件下发这句。
- **不改 `~/.pi/agent/AGENTS.md`**——用户已撤销那次改动，本次范围是 fork + 全局 skills。
- **不动 pi 的扩展配置**（`~/.pi/agent/extensions/subagent/config.json`）——已由上条会话完成。

## 代价

1. **fork 从此与 upstream 分叉**。补丁已进 git 历史（可 diff、可回退、可随时 `git pull`），但 upstream 若重写同一段落，pull 会在这一个 hunk 冲突，需按 README 的说明重打。
2. **symlink 方式没有 bootstrap 注入**。`~/.agents/skills` 只提供技能发现；`using-superpowers` 的 `EXTREMELY_IMPORTANT` 上下文注入来自 `.pi/extensions/superpowers.ts`，那条路要 `pi install`。用户已把 skill 触发规则内化进全局 `AGENTS.md` 的 `## Skills` 一节，所以这个缺失大概率无影响——但它是真实存在的差异，README 里会写出来。
