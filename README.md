# 书源工作台（Legado Source Studio）

PC 端的「开源阅读 / Legado」书源管理与自动生成工具。

**核心功能：输入一个小说网站网址，自动分析网站结构、生成可用的 Legado 书源，并用内置规则引擎真机自测打分，导出 JSON 给手机上的「阅读」APP 导入。**

---

## 快速开始

### 方式一：独立桌面窗口（推荐）

```
双击  启动桌面客户端.bat
```

会打开一个独立窗口（1440×940，可缩放、带菜单和开发者工具）。
菜单里的「文件 → 打开数据目录」可以找到书源库数据文件。

若窗口启动失败（缺少图形环境等），脚本会**自动退回浏览器模式**，功能完全一样。

### 方式二：浏览器模式

```
双击  启动书源工作台.bat
```

会用默认浏览器打开 `http://127.0.0.1:8317/`。关闭那个黑窗口即退出。

首次启动会自动把工作区里的 `折黎No.0051.json`（504 个书源）导入书源库，打开就能看到、能校验、能导出。

### 方式三：命令行

```bash
node app/src/server/index.js            # 只起服务，默认端口 8317
PORT=9000 node app/src/server/index.js  # 换端口
cd app && npm start                     # 用 Electron 起桌面窗口
cd app && npm start -- --browser        # 用 Electron 起服务 + 打开系统浏览器
```

> 环境要求：Node.js 18+（用到了内置 `fetch` 与 `TextDecoder('gbk')`）。
> 浏览器模式**零第三方依赖**；只有桌面窗口模式需要 `app/` 下执行一次 `npm install` 装 Electron。

### 做成免安装绿色版

```bash
cd app && npm install          # 只需一次
node app/scripts/package-portable.js
```

产物在 `dist/书源工作台/`（约 384 MB），整个文件夹拷到任何 Windows 电脑双击 `启动书源工作台.bat` 即可运行，**目标电脑无需安装 Node.js**。


---

## 三大功能区

### ① 网址造源

1. 粘贴小说站网址，例如 `http://www.hunhun.cc`
2. 填一个测试关键字（默认「斗破苍穹」）
3. 点「开始生成」

程序会自动完成：

| 步骤 | 做了什么 |
| --- | --- |
| 抓首页 | 自动尝试 https/http、www 前缀、多 UA；内容像空壳/风控页时**自动改用隐藏浏览器窗口渲染**（桌面客户端模式下） |
| 找搜索入口 | 扫描页面表单（含 POST 与隐藏字段）、站内搜索链接，再按 29 种常见路径逐个实测；自动排除站外搜索（百度等）与返回首页的伪搜索 |
| 书籍列表 | 用「重复兄弟结构 + 链接覆盖率 + 书链接特征」打分，选出最稳的列表选择器 |
| 字段规则 | 对 name/author/kind/coverUrl/intro/lastChapter/wordCount/bookUrl 逐个候选规则**在真实条目上跑**，按覆盖率与合理性选最优，并抽样对比排除「作者取了书名」这类错误 |
| 详情页 | 优先 `meta[property="og:novel:*"]`，再回退到常见 DOM 结构 |
| 目录 | 扫描章节列表候选；详情页没有就去猜 `index.html` / `list.html` / `index_1.html` 等 |
| 正文 | 按文本密度、链接占比选容器，并识别「下一页」按钮 |
| 自测 | 用**内置 Legado 规则引擎**把搜索→详情→目录→正文真跑一遍，给出 0-100 分与每一环的详情 |

生成后可直接「保存到书源库」，或导出/复制 JSON。

### JS 渲染兜底（桌面客户端）

有些站点（部分 Cloudflare 防护站、自研 WAF、纯前端渲染站）用普通 HTTP 抓不到内容。
用 [启动桌面客户端.bat](启动桌面客户端.bat) 启动时，程序会用**隐藏的浏览器窗口**把页面渲染一遍再取 HTML：

- 自动判断是否需要渲染：检查 WAF 特征、SPA 空壳、可读文本量、链接数量
- 生成页上的「JS 渲染兜底」开关可随时关闭
- 「③ 规则调试」里有「对比 JS 渲染效果」，直接看普通抓取 vs 渲染后的差异
- 菜单「工具 → 测试 JS 渲染兜底」可以快速验证渲染是否可用
- `/api/capabilities` 会告诉前端当前模式有没有渲染能力（浏览器模式下会隐藏相关开关）


### ② 书源管理

- 导入 JSON（文件选择器，或一键「载入示例（折黎No.0051.json）」）
- 按名称/网址搜索、按分组筛选、分页浏览
- 编辑单个书源：基本字段 + 搜索/详情/目录/正文规则，全部可视化表单
- 「智能补全规则」：对当前网址重新嗅探并填充规则字段
- 「真机校验」：跑完整流程并给出报告；预览面板可单独看搜索/详情/目录/正文结果
- 导出全部 / 导出单个 / 删除

导出的 JSON 直接传到手机，在「阅读」APP → 书源管理 → 本地导入即可。

### ③ 规则调试

输入任意网址 + 若干条规则（每行一条），立刻看到每条规则取到的值，并可直接查看页面源码与 HTTP 状态、识别出的编码。

---

## 为什么能兼容别人的书源

内置的规则引擎（`app/src/core/`）实现了 Legado 书源规则的主要语法：

- **Default（jsoup 风格）**：`class.X.n`、`tag.X.n`、`id.X`、`text.X`、`children`、
  位置下标（含负数、`[1:2]` 区间、`!0` 排除）、`@text/@href/@src/@html/@all/@ownText`、
  `-` 倒置、`reverse`、属性名兜底
- **CSS**：`@css:` 前缀，或规则里直接写 CSS（`a[href].0@href`、`.box > li:nth-child(2)`）
- **XPath**：`@XPath:` 或 `//` 开头的子集（含谓词、`contains`、`text()`、`@attr`）
- **JSONPath**：`@json:` 或 `$.`，含通配、递归、切片、过滤器 `[?(@.x=='y')]`
- **正则**：`##正则##替换`（循环净化）、`###`（单次）、AllInOne 列表正则
- **连接符**：`&&`（合并）、`||`（取第一个有值的）、`%%`（交替取）
- **模板**：`{{key}}`、`{{page}}`、`{{java.base64Encode(key)}}` 等，含 `<,{{page}}>` 首页免页码写法
- **URL 选项**：`url,{"charset":"gbk","method":"POST","body":"...","headers":{...},"retry":2}`
- **JS 子集**：`@js:` 与 `<js></js>`，提供 `result / baseUrl / src / book / chapter / java.* / cookie / cache`，
  并在 `result` 上挂了 jsoup 风格的 `.select()/.text()/.attr()/.parent()/.children()` 等方法。
  支持书源里常见的写法：`href@js:...`（result 为属性值）、`h3@text##正则`、多块代码
  （`let x=...; try{...}catch{...}`、`if/else` 两分支都会取值）、`for` 循环后返回数组
- **编码**：自动识别 utf-8 / gbk / gb18030 / big5 / windows-1252，含 meta 嗅探与乱码修复
- **变量**：`@put` / `@get`、`java.put` / `java.get`

已用真实网络对 `折黎No.0051.json` 中的样本书源做回归：搜索 → 详情 → 目录 → 正文全通，得分 100/100。
另外对 504 个书源随机抽样 20 个批量回归（`scripts/test-sources.js`，每次抽取不同，实测全流程通过率 25%~35%，平均得分 28~40）。
未通过的主要原因是站点本身被墙/下线、需要 JS 渲染、或使用了更复杂的 `@js:` 互操作脚本。


---

## 目录结构

```
legado-rule-create/
├─ 启动桌面客户端.bat          独立窗口（失败自动退回浏览器模式）
├─ 启动书源工作台.bat          浏览器模式
├─ 折黎No.0051.json            别人做好的 504 个可用书源（作为参考与回归样本）
├─ README.md
└─ app/
   ├─ package.json
   ├─ public/                  前端界面（原生 HTML/CSS/JS，无构建）
   │  ├─ index.html
   │  ├─ css/app.css
   │  └─ js/app.js
   ├─ src/
   │  ├─ main/main.js          Electron 主进程（窗口/菜单/端口/隐藏窗口渲染）
   │  ├─ main/render-bridge.js 渲染器注入桥（含超时保护）
   │  ├─ core/                 规则引擎与抓取内核
   │  │  ├─ dom.js             零依赖 HTML 解析器（jsoup 风格节点树）
   │  │  ├─ selector.js        CSS 选择器子集
   │  │  ├─ xpath.js           XPath 子集
   │  │  ├─ jsonpath.js        JSONPath 子集
   │  │  ├─ rule.js            Legado 规则解析引擎（核心）
   │  │  ├─ jsexec.js          @js: 规则执行器（含 jsoup 兼容层与多块结构取值）
   │  │  ├─ http.js            抓取层（编码/重定向/cookie/压缩）
   │  │  ├─ render.js          是否需要 JS 渲染的判定逻辑
   │  │  ├─ session.js         书源执行会话：搜索/发现/详情/目录/正文 + 校验
   │  │  ├─ detect.js          网页结构嗅探（列表/目录/正文/表单/JSON 接口）
   │  │  ├─ generator.js       自动生成书源主流程
   │  │  └─ urlutil.js         URL 工具
   │  └─ server/
   │     ├─ index.js           本地 HTTP 服务 + API（含 /api/capabilities、/api/render-test）
   │     ├─ library.js         书源库（导入/导出/去重/分组）
   │     └─ open.js            打开系统浏览器
   ├─ data/                    书源库数据（自动生成；桌面窗口模式存到 %APPDATA%）
   └─ scripts/                 测试与调试脚本
      ├─ test-engine.js        用真实书源跑完整校验
      ├─ acceptance.js         端到端验收测试（25 项，模拟完整用户流程）
      ├─ test-sources.js       从 504 个书源抽样批量回归
      ├─ test-render.js        JS 渲染兜底链路测试（stub 渲染器，不需浏览器）
      ├─ test-electron-main.js 电子壳主进程空跑测试（两种模式）
      ├─ test-library.js       书源库导入去重测试
      ├─ gen.js                单站点自动生成调试
      ├─ gen-batch.js          多站点自动生成回归
      ├─ api-test.js           服务端 API 冒烟测试
      ├─ diag-site.js          站点可达性诊断
      ├─ diag-source.js        单个书源全链路诊断
      ├─ probe-search.js       搜索入口探测
      ├─ package-portable.js   制作免安装绿色版
      └─ unit-*.js             规则引擎 / JS 执行器单元测试
```

---

## 常用命令

```bash
# 只起本地服务（默认浏览器自动打开）
node app/src/server/index.js

# 用 Electron 起独立窗口 / 或浏览器兜底模式
cd app && npm start
cd app && npm start -- --browser

# 用真实书源跑一遍完整校验（搜索/详情/目录/正文）
node app/scripts/test-engine.js 混混 "斗破苍穹"

# 端到端验收测试（25 项，需先启动服务）
#   STUDIO_DATA_DIR=.tmp-accept PORT=8444 node app/src/server/index.js
BASE=http://127.0.0.1:8444 node app/scripts/acceptance.js

# 从 504 个书源里抽样批量回归（数量 并发 关键字）
node app/scripts/test-sources.js 20 4 "斗破苍穹"

# 单个书源全链路诊断（看每一步取到了什么）
node app/scripts/diag-source.js 键盘 "斗破苍穹"

# JS 渲染兜底测试（stub 渲染器，不需要浏览器）
node app/scripts/test-render.js

# 电子壳主进程链路测试（不需要图形环境）
node app/scripts/test-electron-main.js
node app/scripts/test-electron-main.js --browser

# 书源库导入去重测试
node app/scripts/test-library.js

# 对某个网址自动生成书源并自测（输出到 app/scripts/out-generated.json）
node app/scripts/gen.js "https://www.biquge365.net"

# 批量回归多个站点
node app/scripts/gen-batch.js

# 服务端 API 冒烟测试（需先启动服务；建议用独立数据目录）
#   STUDIO_DATA_DIR=.tmp-apitest PORT=8399 node app/src/server/index.js
BASE=http://127.0.0.1:8399 node app/scripts/api-test.js

# 制作免安装绿色版
node app/scripts/package-portable.js

# 规则引擎 / JS 执行器单元测试
node app/scripts/unit-rule3.js      # Default 规则与选择器
node app/scripts/unit-excl.js       # 位置与排除
node app/scripts/unit-or.js         # 连接符 && || %%
node app/scripts/unit-jsrule.js     # @js: 规则
node app/scripts/unit-jsexec.js     # JS 执行器多块结构
node app/scripts/ui-check.js        # 前端接线检查
```

---

## 已知限制

- **需要 JS 渲染的站点**：首页只有 JS 挑战/壳页的站点（部分 Cloudflare、自研 WAF）抓不到内容，
  工具会明确提示，可手动填写规则或在 APP 里用 webView。
- **字体加密 / 图片章节**：无法自动生成，需要人工写 `@js:` 或字体处理规则。
- **PC 端无 webView**：`{"webView":true}` 的参数会被忽略，纯 HTTP 抓取。
- **JS 规则是子集实现**：`result.select()` 这类 jsoup 调用已兼容，但复杂 Java 互操作脚本会失败并报错。
- **Electron 窗口需要图形环境**：在没有桌面会话的环境（如某些远程/无头会话）里窗口起不来，
  启动脚本会自动退回浏览器模式。

## 路线图

- [x] 书源规则引擎（Default/CSS/XPath/JSONPath/正则/JS 子集，含多块结构 `@js:`）
- [x] 输入网址自动生成书源 + 真机自测打分
- [x] 书源库管理（导入/导出/编辑/校验/预览）
- [x] Electron 独立窗口客户端 + 免安装绿色版打包
- [x] JS 渲染兜底（隐藏浏览器窗口，处理空壳/风控页）
- [ ] 可视化选择器拾取（点页面元素生成规则）
- [ ] 书源健康巡检（批量定时校验 + 失效提示）
- [ ] 导出时按分组拆分多个 JSON
- [ ] 字体加密 / 图片章节的处理辅助
