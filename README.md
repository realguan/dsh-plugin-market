# DSH 插件市场 · DSH Plugin Market

一个可以直接加进 **DeepSeek Harness (DSH)** 的第三方插件市场：**4,500+ 个插件**，带中英双语标题与描述、23 个分类、10 个能力标签，可按下载量 / 星标 / 收录时间排序。索引每天自动重建。

## 市场地址

```
https://cdn.jsdelivr.net/gh/realguan/dsh-plugin-market@dist/dsh-index.json     # 国内访问快
https://realguan.github.io/dsh-plugin-market/dsh-index.json                   # 更新最快
```

| 地址 | 生效速度 | 建议 |
|---|---|---|
| GitHub Pages | 约 **10 分钟** | 想要最新数据 |
| jsDelivr | 最长 **12 小时** | 国内访问，`s-maxage=43200` 是 jsDelivr 对分支引用的固有限制 |

**两个地址内容相同，只加一个。** 都加会在 DSH 里出现两个市场、同一批插件重复显示。

索引由 GitHub Actions **每天 03:17 UTC** 重建（也可以手动触发），在 DSH 的市场菜单里显示为 **DSH Plugin Market / DSH 插件市场**。

## 在 DSH 里添加

1. 打开 **Plugins** → **More**（在 Experimental plugins 旁）→ 打开 **Custom plugin markets**
2. 切到 **Discover** → **Add index source** → 粘贴上面任意一个地址
3. 之后即可搜索、按分类与能力标签过滤、按下载量或星标排序

每个插件卡片显示推荐版本（兼容当前 DSH、且非预发布的最新版），点 **Install** 会先弹出确认，显示该版本的来源：npm 包名与 registry，或 Git 仓库、commit 和子目录。确认后才开始安装，安装过程仍会走 DSH 自己的兼容性与 registry 检查。

## 市场里有什么

最近一次转换（2026-10-16）：

| 项目 | 数量 |
|---|---|
| 插件 | **4,562** |
| 安装来源 | npm 2,448 · Git 2,114 |
| 分类 | 23（AGI、UI、主题、模型、记忆、技能、工作流、安全……） |
| 能力标签 | 10（`network`、`llm`、`shell`、`fs-read`、`fs-write`、`env`、`credentials`、`subagent`、`dynamic-code`、`host-runtime`） |
| 排序键 | 下载量 · 星标 · 收录时间 |
| 带图标 | 209 |

每个版本都钉死在确切的 npm 版本或 Git commit 上，安装的构建与列表显示的完全一致；`engines.dsh` 来自插件自己的声明（或它的 `@deepseek-ai/dsh*` peer 依赖），DSH 会据此标注兼容性。

## 鸣谢 · 数据来源

**条目数据来自 [awesome-dsh-plugin](https://awesome-dsh-plugin.com/)** —— 分类体系、能力标注、stars 与下载量统计都由这个项目维护和审校。它的源码在 [github.com/awesome-dsh-plugin/awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin)，以 **CC0-1.0** 发布。没有它就没有这个市场。

**插件本身归各自作者所有。** 本仓库不托管、不修改任何插件代码，只发布一份描述它们从哪里安装的索引；每个插件的标题、描述、作者与来源都来自上游条目和插件自己的 manifest。

本仓库做的是把这些数据逐条回到源头（npm registry / Git commit）核实，转换成 DSH 的市场索引格式（[format 1](https://github.com/deepseek-ai/deepseek-harness/blob/master/.agents/notes/implemented/feature/2026-10-02-plugin-market-index-format.md)），然后托管成上面两个免费地址。

## 安全提示

市场内容是第三方声明。DSH 只校验索引的文件格式，不校验这些声明是否属实 —— 标题、作者、星标、下载量都来自市场方，`official` 之类的标签也不代表 DSH 官方认证。安装前请查看确认框里的来源（npm 包名或 Git 仓库 + commit），只添加你信任的市场来源。

## 维护

索引的生成、发布与验证方式见 [TOOLING.md](TOOLING.md)：转换器逐条回源核实、用 DSH 官方校验器自检、每天由 GitHub Actions 自动重建，同时支持本机 `./publish.sh` 手动发布。
