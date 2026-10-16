# awesome-dsh-plugin → DSH 插件市场索引

把 [`awesome-dsh-plugin.com/plugins.json`](https://awesome-dsh-plugin.com/plugins.json) 转换成 DSH 插件市场索引（format 1），也就是 DSH 的 **Discover** 标签页和 `plugin_market` 工具实际读取的那份 JSON。

`plugins.json` 本身是 awesome-list 结构（`name` / `owner` / `url` / `category` / `npm` / `version` / `stars` / `downloads` / `install`），DSH 会以 `$.format must be 1` 直接拒绝。本工具把它转换成 DSH 能读的格式，同时保留原站的分类、能力标签、stars、下载量和收录时间。

## 用法

```sh
npm install

# 全量转换（默认读线上 plugins.json，写 out/dsh-index.json）
node convert.mjs

# 试跑 40 条，先看看结果
node convert.mjs --limit 40 --output out/sample.json

# 本地文件、自定义标题
node convert.mjs --input ./plugins.json --title "Awesome DSH Plugin" --title-zh "插件精选"
```

| 选项 | 默认 | 说明 |
|---|---|---|
| `--input <file\|url>` | `https://awesome-dsh-plugin.com/plugins.json` | 源文档 |
| `--output <file>` | `out/dsh-index.json` | 输出的索引 |
| `--report <file>` | `<output>.report.json` | 跳过条目及其原因的报告 |
| `--cache <dir>` | `.cache` | 解析缓存；重跑只补新增条目 |
| `--title` / `--title-zh` / `--description` | — | 市场标题与描述 |
| `--registry <url>` | `https://registry.npmjs.org/` | npm 源；非官方 registry 会写进每个 npm 版本 |
| `--source <all\|npm\|git>` | `all` | 只转换其中一类 |
| `--limit <n>` | 不限 | 试跑条数 |
| `--concurrency <n>` | `8` | 并发 |
| `--timeout-ms <n>` / `--retries <n>` | `30000` / `3` | 网络超时与重试 |
| `--github-token <tok>` | `$GITHUB_TOKEN` | 用 GitHub API 取精确 commit 时间 |
| `--refresh` | — | 忽略缓存，全部重新解析 |
| `--retry-skipped` | — | 只重试缓存中“已跳过”的条目（网络抖动导致的失败） |

退出码：`0` 成功；`1` 源文档读不到或校验失败；`2` 参数错误。

## 转换规则

每条记录都会回到源头核实，而不是照抄原站字段：

| 索引字段 | 来源 |
|---|---|
| `name` | npm 条目的包名；Git 条目取该 commit 下 `package.json` 的 `name`（常与原站仓库名不同，例如 `dsh-restart-button` → `@pangxitong/dsh-restart-button`） |
| `versions[0].version` | npm 条目用 `npm` 字段，并确认该版本确实存在；Git 条目取 manifest 的 `version`（必须是精确 SemVer） |
| `versions[0].publishTimestamp` | npm：registry `time[<version>]`；Git：加了 `--github-token` 时取 commit committer 时间，否则退回 `added` 日期（UTC 零点） |
| `versions[0].source` | npm → `{ "type": "npm" }`；Git → `{ "type": "git", "url", "commit", "path?" }`，commit 由 `git ls-remote` 解析并钉死 |
| `versions[0].engines.dsh` | manifest 的 `engines.dsh`；没有时取 `@deepseek-ai/dsh*` peerDependencies 的合取（只声明 `dsh` 时省略表示“任意版本”） |
| `title` / `description` / `author` | 原站的 `name` / `description`（双语）/ `owner` |
| `homepage` / `repository` | manifest 的 `homepage`、原站 `url`（含 monorepo 子目录解析为 `repository.directory`） |
| `icon` | manifest 声明了 `icon` 时，npm 指向 `cdn.jsdelivr.net/npm/<name>@<version>/…`，Git 指向该 commit 的 `raw.githubusercontent.com` 路径 |
| `metadata.category` | 原站 `category`，并在根 `metadata.categories` 中声明 |
| `metadata.labels` | 原站 `capabilities`，在 `metadata.labels` 中声明（Discover 的 Labels 菜单即可按能力过滤） |
| `metadata.keywords` | manifest 的 `keywords` |
| `metadata.sortKeys` | `downloads`、`stars`、`added`（Unix 秒），可在 Discover 的 Sort 菜单里排序 |
| `repository.directory` / 子目录 | 原站 `url` 形如 `.../tree/<branch>/<dir>` 时解析为包目录 |

**只收录真正可安装的条目**：manifest 必须声明 `dsh.bundle`，且 `version` 必须是精确 SemVer。其余条目写进报告而不写进索引——因为 DSH 安装时会拒收没有 bundle patch 的包。

## 发布：jsDelivr（免费 CDN）

索引发布在本仓库的 `dist` 分支，由 jsDelivr 直接做 CDN：

```
https://cdn.jsdelivr.net/gh/realguan/dsh-plugin-market@dist/dsh-index.json
```

接入方式：DSH → **Plugins** → **More**（Experimental plugins 旁）→ 打开 **Custom plugin markets** → **Discover** → **Add index source** → 填入上面这个 URL。

jsDelivr 的实测响应头是 `cache-control: public, max-age=604800, s-maxage=43200`，即**浏览器 7 天、边缘 12 小时**。更新后要立刻生效就调 purge：

```sh
curl https://purge.jsdelivr.net/gh/realguan/dsh-plugin-market@dist/dsh-index.json
```

`publish.sh` 已经带了这一步。

### 更新索引

```sh
./publish.sh          # 重新生成 → 强推 dist 分支 → 清 jsDelivr 缓存
```

或者交给 GitHub Actions：[`.github/workflows/rebuild.yml`](.github/workflows/rebuild.yml) 每天 03:17 UTC 重新生成并发布，也可以手动触发。Actions 里 `.cache` 会用 `actions/cache` 保留，所以一次 run 只为上游变化的部分付费。

### 为什么用 dist 分支

`dsh-index.json` 有 6 MB 且每天变。如果每天往 `main` 提交一份，仓库历史一年会涨到 GB 级；`dist` 分支每次强推一个单提交，历史永远只有一份快照，`main` 只放工具源码。

### 为什么不需要 CORS

DSH 是在 Host 进程里 `fetch` 这个索引的，不是浏览器发请求，所以不用给 jsDelivr 配任何 CORS 头（它本来就返回 `access-control-allow-origin: *`）。

索引由 DSH 校验，任何一条规则不满足都会整份拒绝，错误会显示在 **Manage index sources…** 里（带 JSON 路径）。`convert.mjs` 在写出文件前会用 DSH 官方校验器 `@deepseek-ai/dsh-plugin-market-index` 自检一次，不合格直接退出。

## 用 DSH 自己的读取器验证

`verify-dsh-market.mts` 不用 schema 副本，而是把文件通过 HTTP 提供出去，走 DSH 的解析路径（严格 UTF-8 + JSON + 校验），再用读取器自己的搜索引擎做检索和排序，并生成安装 spec：

```sh
npm run verify
# 等价于（DSH_CHECKOUT 指向已 pnpm install 的 DSH 检出）：
TSX_TSCONFIG_PATH=${DSH_CHECKOUT:-~/git/deepseek-harness}/tsconfig.json \
  node --import tsx/esm verify-dsh-market.mts out/dsh-index.json
```

`DSH_CHECKOUT` 默认 `/Users/guan/git/deepseek-harness`；用它的 `tsconfig.json` 是为了让 tsx 把 `@deepseek-ai/dsh-*` 解析到源码而不是未构建的 `lib/`。

## 已知限制

- **Git 条目的 `publishTimestamp`**：不加 `--github-token` 时用原站 `added` 日期，因为 `git ls-remote` 不返回 commit 时间。
- **只解析 GitHub**：原站 2347 条非 npm 条目全部指向 github.com；其他主机会被跳过并写进报告。
- **仅收录原站列出的那个版本**，不展开历史版本；不存在于 registry 的版本会被跳过。
- **Git 条目按默认分支 HEAD 钉住**，原站更新后需要重跑转换。
- 索引未签名：标题、作者、stars、下载量都是市场声明，DSH 只校验格式。
- **缓存按条目身份命中**：`.cache` 以 `npm@version` / 仓库 URL 为键复用解析结果；改动「解析规则」后用 `--refresh` 重新解析，只改「展示规则」（标题、仓库链接、图标等）则每次生成都会重算，不需要重新联网。
- **同名包冲突**：153 组互相独立、却声明了同一个包名的插件（例如两个作者的 `dsh-model-picker`）。索引里一个包名只能有一条，转换器按「npm 已发布 > 下载量 > stars > 更早收录」保留其一，其余写进报告的 `duplicates`。

## 目录

```
convert.mjs              转换器（写文件前用 DSH 官方校验器自检）
verify-dsh-market.mts    用 DSH 读取器做端到端验证
publish.sh               生成 → 推 dist 分支 → 清 jsDelivr 缓存
.github/workflows/rebuild.yml   每天自动重建并发布
out/dsh-index.json       生成的索引
out/dsh-index.json.report.json  逐条跳过原因
.cache/                  解析缓存（不入库）
```
