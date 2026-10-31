# 题解集 · CSP-J 2026

洛谷 CSP-J 2026（民间数据）题解，纯静态站点，没有构建依赖，克隆下来双击就能看。

在线地址（启用 GitHub Pages 后）：<https://ajsoabk.github.io/problem-solution-base/>

目前已收录 4 题：

| 题号 | 题目 | 知识点 |
| --- | --- | --- |
| P17827 | 旅游 / travel | 分支结构、字符串 |
| P17828 | 回文串 / string | 双指针、贪心 |
| P17829 | 按位与 / and | 贪心、位运算 |
| P17830 | 纸牌游戏 / card | 树、计数 |

## 页面

- `index.html`：题解列表，可按题号 / 题目 / 知识点搜索
- `problem.html?id=P17827`：单题题解，左侧目录可点击跳转

每篇题解包含：题意、知识点标签、关键观察、部分分写法、正解、代码、易错点。

## 结构

```
index.html              列表页
problem.html            详情页（?id=题号）
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
WORKFLOW.md             写作流程与字段说明
PITFALLS.md             踩坑记录
```

## 加一道题

```bash
copy problems\P17827.json problems\P12345.json   # 改内容
node tools/build.mjs                              # 校验 + 重新打包
node tools/verify-code.mjs P12345                 # 编译并跑该题的用例
```

字段写错时构建会直接指出位置，例如：

```
problems/P12345.json → pitfalls[0].severity：只能是 高 / 中 / 低
```

## 本地预览

直接双击 `index.html` 即可（全部资源都是相对路径，不依赖服务器）。
也可以 `python -m http.server` 后访问 `http://localhost:8000`。

## 说明

- 题面文字来自洛谷，版权归原出题人与洛谷所有，这里仅用于学习交流。
- 代码为提交版（标准输入输出），正式赛需要自行加上 `freopen`。
