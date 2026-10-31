# 代码风格规范

> 所有题解里的 C++ 代码都按这份规范改写。改代码前先看这里；有疑问的条目在「待确认」里。

## 已确认

| # | 规则 | 例子 |
| --- | --- | --- |
| 1 | 只用 `#include<bits/stdc++.h>`，不拆头文件 | `#include<bits/stdc++.h>` |
| 2 | 大括号**不换行**（K&R） | `int main(){` / `if(x){ ... }` |
| 3 | 用 `#define ll long long`，不用 `typedef` | `#define ll long long` |
| 4 | 数组大小用 `const int N=...`，不写字面量 | `const int N=5e5+5; int a[N];` |
| 5 | 循环变量用 `i`、`j`、`k`；计数器用 `cnt` | `for(int i=1;i<=n;i++)` |
| 6 | 不写 `solve()`，逻辑直接放在 `main()` 里 | — |
| 7 | 不用命名空间别名以外的花活，`using namespace std;` 照常 | — |

## 推断（按现有代码归纳，需要你确认）

| # | 规则 | 说明 |
| --- | --- | --- |
| 8 | 缩进 4 空格，不用 Tab | 你两份代码里 Tab / 空格混用 |
| 9 | 全局数组开在 `main` 外 | `int n,a[N];` 放全局 |
| 10 | `const int N=xxx;` 里 `=` 两侧不空格 | 与你原文一致 |
| 11 | 二元运算符两侧**加**空格 | `i <= n`、`x + 1`、`cin >> n` |
| 12 | 大括号内只有一行时可以省略吗？ | 默认**不省略**，除非是 `if(!x)return;` 这种提前返回 |
| 13 | 输出用 `cout`，换行用 `'\n'` | 你两种都用过（`printf`/`cout`） |
| 14 | 快读函数保留 `read()` 形式 | `void read(int &x)`，不换成 `cin` |
| 15 | 函数命名小写，动词开头 | `dfs`、`check`、`read`；不用 `solve` |

## 待确认（我先按默认做，你说了再改）

1. **缩进**：4 空格还是 Tab？
2. **运算符空格**：`i<=n` 还是 `i <= n`？现在是后者，但你原文两种都有。
3. **输出**：统一 `cout << ans << '\n'`，还是保留 `printf`？
4. **快读**：保留手写 `read()`，还是统一 `ios::sync_with_stdio(0); cin.tie(0);`？
5. **注释**：中文 `//` 写在关键行上方，讲「为什么」，不逐行翻译代码——这个默认可以吗？
6. **`#define` 除了 `ll` 还允许别的吗**（如 `rep`、`maxn`）？默认只保留 `#define ll long long`。
7. **结构体/类名**：大驼峰（`Node`）还是小写？目前代码里没有，先默认大驼峰。

## 模板

```cpp
#include<bits/stdc++.h>
using namespace std;
#define ll long long
const int N=5e5+5;
int n,m;
int a[N];
ll ans;
int main(){
    ios::sync_with_stdio(0);
    cin.tie(0);
    cin>>n>>m;
    for(int i=1;i<=n;i++)cin>>a[i];
    // ...
    cout<<ans<<'\n';
    return 0;
}
```
