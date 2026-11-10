# 题解集 · CSP-J 2026

洛谷 CSP-J 2026（民间数据）题解，纯静态站点，没有构建依赖，克隆下来双击就能看。

在线地址（启用 GitHub Pages 后）：<https://ajsoabk.github.io/problem-solution-base/>

目前已收录 8 题：

| 题号 | 题目 | 知识点 |
| --- | --- | --- |
| P17827 | 旅游 / travel | 分支结构、字符串 |
| P17828 | 回文串 / string | 双指针、贪心 |
| P17829 | 按位与 / and | 贪心、位运算 |
| P17830 | 纸牌游戏 / card | 树、计数 |
| P17831 | 能量水晶 / crystal | 排序、双指针 |
| P17832 | 地铁 / subway | 图论、最短路 |
| P17833 | 迁徙 / migrate | 贪心、动态规划 |
| P17834 | 研发基地 / hub | 二分、树 |

## 页面

- `index.html`：题解列表，可按题号 / 题目 / 知识点搜索
- `problem.html?id=P17827`：单题题解，左侧目录可点击跳转

每篇题解包含：题意、知识点标签、关键观察、部分分写法、正解、代码、易错点。

## 结构

```
index.html              列表页
problem.html            详情页（?id=题号）
admin/                  本地后台页面（蓝色简约风）
assets/
  style.css             全站样式
  common.js             公共工具
  list.js               列表渲染
  problem.js            详情渲染（通用，不含任何题目逻辑）
  data.js               构建产物，勿手改
problems/
  P17827.json           一道题一个文件，唯一的写作入口
tools/
  build.mjs             校验 + 打包
  verify-code.mjs       编译代码 + 跑用例
  admin-server.mjs      本地后台服务（只监听 127.0.0.1）
  lib/                  后台复用模块：schema / 网关 / AI
WORKFLOW.md             写作流程与字段说明
PITFALLS.md             踩坑记录
```

## 本地后台（编辑 + AI 生成）

前台仍是纯静态的；后台需要一个只在本机运行的小服务：

```powershell
node tools/admin-server.mjs
# 打开 http://127.0.0.1:8790/admin/
```

端口被占用时：

```powershell
$env:ADMIN_PORT=8791; node tools/admin-server.mjs
```

后台能做四件事：

- **题目管理**：搜索、编辑、新建、删除、校验、预览；保存前先做字段校验，写入后自动调用 `build.mjs` 重新打包。构建失败会回滚到上一版；删除的题目移到 `tools/.tmp/trash/`。
- **AI 生成**：把题面 + 一份 AC 代码交给本机 LLM 网关，产出完整的 `problems/<id>.json` 解析卡；结果先进入编辑器，人工检查后再保存。
- **写作规范**：`admin/ai-rules.default.md` 是默认规范，后台「写作规范」里可以修改，保存后写入 `admin/ai-rules.md`，下次生成立即生效。规范里包含字段、篇幅、代码风格、部分分、易错点和输出 JSON 的硬性要求。
- **设置**：网关地址、`pool`、`agent_id`、`model`、`max_tokens`、temperature、超时和重试次数。

### 网关约定

后台只调用本机网关 `http://127.0.0.1:8765`，不直连任何模型厂商，也不读取厂商 API Key：

- `GET /v1/status`：发请求前先看 `available` 与 `queue.estimated_wait_ms`；
- `POST /v1/complete`：取返回的 `content` 字段（不是 OpenAI 兼容格式）；
- 失败按 `busy` / `wait_timeout` / `rate_limited` / `timeout` / `reasoning_exhausted` / `no_agent` 分类处理，免费池串行排队，不做并发轰炸。

如果网关配了 token，在启动后台前设置（或写入 `admin/gateway-token.txt`，该文件已加入 `.gitignore`）：

```powershell
$env:LLM_GATEWAY_TOKEN="你的网关token"
node tools/admin-server.mjs
```

后台只监听 `127.0.0.1`，会拒绝非回环 Host；`admin/settings.json`、token 文件和写作规范不通过静态服务暴露。把仓库部署到 GitHub Pages 时，`admin/` 只是一个静态页面，打开会提示「后台只在本机运行」，不会连接任何接口。

## 加一道题

```bash
copy problems\P17827.json problems\P12345.json   # 改内容
node tools/build.mjs                              # 校验 + 重新打包
node tools/verify-code.mjs P12345                 # 编译并跑该题的用例
```

也可以在后台里点「新建题目」或「AI 生成」，保存后会自动完成上面的打包步骤。

字段写错时构建会直接指出位置，例如：

```
problems/P12345.json → pitfalls[0].severity：只能是 高 / 中 / 低
```

## 本地预览

直接双击 `index.html` 即可（全部资源都是相对路径，不依赖服务器）。
也可以 `python -m http.server` 后访问 `http://localhost:8000`。
后台请用 `node tools/admin-server.mjs`，不要用静态服务器打开。

## 说明

- 题面文字来自洛谷，版权归原出题人与洛谷所有，这里仅用于学习交流。
- 代码为提交版（标准输入输出），正式赛需要自行加上 `freopen`。
- 后台是本地工具，不是给公网访问的；不要把 `127.0.0.1:8790` 映射到公网。
