# 生成与维护

本仓库把 [awesome-dsh-plugin](https://awesome-dsh-plugin.com/) 的数据转换成 DSH 的市场索引（format 1），发布在 `dist` 分支并托管到 GitHub Pages 与 jsDelivr。市场地址与数据来源见 [README](README.md)。

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
| `--index-url <url>` | jsDelivr 地址 | 索引最终发布的 URL，用于校验时解析相对图标 |
| `--report <file>` | `<output>.report.json` | 跳过条目及其原因的报告 |
| `--cache <dir>` | `.cache` | 解析缓存；重跑只补新增条目 |
| `--title` / `--title-zh` / `--description` | 沿用上游名称 | 市场标题与描述 |
| `--registry <url>` | `https://registry.npmjs.org/` | npm 源；非官方 registry 会写进每个 npm 版本 |
| `--source <all\|npm\|git>` | `all` | 只转换其中一类 |
| `--limit <n>` | 不限 | 试跑条数 |
| `--concurrency <n>` | `8` | 并发 |
| `--timeout-ms <n>` / `--retries <n>` | `30000` / `3` | 网络超时与重试 |
| `--github-token <tok>` | `$GITHUB_TOKEN` | 用 GitHub API 取精确 commit 时间 |
| `--refresh` | — | 忽略缓存，全部重新解析 |
| `--retry-skipped` | — | 只重试缓存中「已跳过」的条目（网络抖动导致的失败） |

退出码：`0` 成功；`1` 源文档读不到或校验失败；`2` 参数错误。

写文件前会用 DSH 官方校验器 `@deepseek-ai/dsh-plugin-market-index` 校验整份索引，不合格直接退出、不落盘。

## 转换规则

每条记录都会回到源头核实，而不是照抄上游字段：

| 索引字段 | 来源 |
|---|---|
| `name` | npm 条目的包名；Git 条目取该 commit 下 `package.json` 的 `name`（常与仓库名不同，例如 `dsh-restart-button` → `@pangxitong/dsh-restart-button`） |
| `versions[0].version` | npm 条目用上游 `npm` 字段，并确认该版本确实存在；Git 条目取 manifest 的 `version`（必须是精确 SemVer） |
| `versions[0].publishTimestamp` | npm：registry `time[<version>]`；Git：带 token 时取 commit committer 时间，否则退回上游 `added` 日期（UTC 零点） |
| `versions[0].source` | npm → `{ "type": "npm" }`；Git → `{ "type": "git", "url", "commit", "path?" }`，commit 由 `git ls-remote` 解析并钉死 |
| `versions[0].engines.dsh` | manifest 的 `engines.dsh`；没有时取 `@deepseek-ai/dsh*` peerDependencies 的合取（推不出时省略，表示不限定版本） |
| `title` / `description` / `author` | 上游的 `name` / 双语 `description` / `owner` |
| `homepage` / `repository` | manifest 的 `homepage`、上游 `url`（`.../tree/<branch>/<dir>` 会解析成 `repository.url` + `repository.directory`） |
| `icon` | manifest 声明了 `icon` 时，npm 指向 `cdn.jsdelivr.net/npm/<name>@<version>/…`，Git 指向该 commit 的 `raw.githubusercontent.com` 路径 |
| `metadata.category` | 上游 `category`，并在根 `metadata.categories` 中声明 |
| `metadata.labels` | 上游 `capabilities`，在 `metadata.labels` 中声明（Discover 的 Labels 菜单据此过滤） |
| `metadata.keywords` | manifest 的 `keywords` |
| `metadata.sortKeys` | `downloads`、`stars`、`added`（Unix 秒），对应 Discover 的 Sort 菜单 |

**只收录能装的条目**：manifest 必须声明 `dsh.bundle`，`version` 必须是精确 SemVer。其余条目写进报告而不写进索引，因为 DSH 安装时会拒收没有 bundle patch 的包。

## 发布

```sh
./publish.sh          # 重新生成 → 强推 dist 分支 → 清 jsDelivr 缓存 → 检查是否生效
```

平时交给 GitHub Actions：[`.github/workflows/rebuild.yml`](.github/workflows/rebuild.yml) 每天 03:17 UTC 重新生成并发布，也可以手动触发。Actions 里 `.cache` 由 `actions/cache` 保留，所以一次 run 只为上游变化的部分付费。

两个地址的生效速度不同：

- **GitHub Pages**：Pages 直接从 `dist` 分支发布，`cache-control: max-age=600`，约 10 分钟生效。
- **jsDelivr**：分支引用最长滞后 12 小时，见下。

### 为什么用 dist 分支

`dsh-index.json` 有 6 MB 且每天变。如果每天往 `main` 提交一份，仓库历史一年会涨到 GB 级；`dist` 分支每次强推一个单提交，历史永远只有一份快照，`main` 只放工具源码。Pages 也正好把这个分支当发布源（`.nojekyll` 避免 Jekyll 处理）。

### ⚠️ jsDelivr 的分支引用最长会滞后 12 小时

实测（2026-10-16）：连着发布三版后，`@dist` 一直返回前两版；而同一时刻

| URL | 返回 |
|---|---|
| `...@dist/dsh-index.json` | 旧版（03:22） |
| `...@<commit-sha>/dsh-index.json` | **最新（03:55）** |
| `raw.githubusercontent.com/.../dist/dsh-index.json` | **最新（03:55）** |

文件内容没问题，是 jsDelivr 的「分支 → commit」解析被缓存了，purge 清不掉它（连发 8 次 purge 仍在两版之间摆动）。这是 jsDelivr 对分支引用的既定行为，TTL 就是 `s-maxage=43200`。

含义：**jsDelivr 每次发布后最长 12 小时才会全网生效**。要最新就用 GitHub Pages 地址。`publish.sh` 和 workflow 会在 purge 后轮询并如实报告 jsDelivr 有没有跟上，不会假装成功。

### 为什么不需要 CORS

DSH 是在 Host 进程里 `fetch` 这个索引的，不是浏览器发请求，所以不需要给 CDN 配 CORS 头。

## 验证

`verify-dsh-market.mts` 不用 schema 副本，而是把文件通过 HTTP 提供出去（也可以直接传线上 URL），走 DSH 的解析路径（严格 UTF-8 + JSON + 校验），再用读取器自己的搜索引擎做检索和排序，并生成安装 spec：

```sh
npm run verify
# 等价于（DSH_CHECKOUT 指向已 pnpm install 的 DSH 检出）：
TSX_TSCONFIG_PATH=${DSH_CHECKOUT:-~/git/deepseek-harness}/tsconfig.json \
  node --import tsx/esm verify-dsh-market.mts out/dsh-index.json

# 直接验证线上地址
TSX_TSCONFIG_PATH=${DSH_CHECKOUT:-~/git/deepseek-harness}/tsconfig.json \
  node --import tsx/esm verify-dsh-market.mts https://realguan.github.io/dsh-plugin-market/dsh-index.json
```

## 已知限制

- **Git 条目的 `publishTimestamp`**：没有 GitHub token 时用上游 `added` 日期，因为 `git ls-remote` 不返回 commit 时间。
- **只解析 GitHub**：上游 2,347 条非 npm 条目全部指向 github.com；其他主机会被跳过并写进报告。
- **仅收录上游列出的那个版本**，不展开历史版本；registry 上已不存在的版本会被跳过。
- **Git 条目按默认分支 HEAD 钉住**，上游更新后需要重跑。
- **缓存按条目身份命中**：`.cache` 以 `npm@version` / 仓库 URL 为键复用解析结果。改动「解析规则」后要 `--refresh`；只改「展示规则」（标题、仓库链接、图标等）每次生成都会重算，不需要重新联网。
- **同名包冲突**：最新一次转换里有 153 组互相独立、却声明了同一个包名的插件（例如两个作者的 `dsh-model-picker`）。索引里一个包名只能有一条，转换器按「npm 已发布 > 下载量 > stars > 更早收录」保留其一，其余写进报告的 `duplicates`。

## 目录

```
convert.mjs              转换器（写文件前用 DSH 官方校验器自检）
verify-dsh-market.mts    用 DSH 读取器做端到端验证
publish.sh               生成 → 推 dist 分支 → 清 jsDelivr 缓存 → 检查生效
.github/workflows/rebuild.yml   每天自动重建并发布
out/dsh-index.json       生成的索引
out/dsh-index.json.report.json  逐条跳过原因
.cache/                  解析缓存（不入库）
```
