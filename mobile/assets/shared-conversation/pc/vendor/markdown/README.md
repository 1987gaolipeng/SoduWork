# 对话预览用的 markdown 三件套（vendored）

和 `vendor/xterm/` 一个路子：**直接把打好的文件放进仓库**，不走 npm 依赖。
渲染层没有构建步骤（Electron 直接加载源文件），内网装包也不方便。

| 文件 | 来源 | 许可 |
|---|---|---|
| `marked.umd.js` | marked 18.0.9 的 `lib/marked.umd.js`，原样拷贝 | MIT（见 LICENSE.marked） |
| `highlight.min.js` | highlight.js 11.11.1 的 `es/common.js`（常用语言那一档）用 esbuild 打成 IIFE，挂 `window.hljs` | BSD-3-Clause（见 LICENSE.highlight） |
| `diff.min.js` | jsdiff 9.0.0 的 `dist/diff.min.js`，原样拷贝（工具卡里画改动用） | BSD-3（见 LICENSE.diff） |
| `diff2html.min.js` + `d2h-theme.js` | diff2html 3.4.56 的浏览器包与样式（样式转成 JS 字符串注入） | MIT（LICENSE.diff2html） |
| `purify.min.js` | DOMPurify 3.4.13 的 `dist/purify.min.js`，原样拷贝 | MPL-2.0/Apache-2.0（LICENSE.dompurify） |
| `hljs-theme.js` | 同版本 `styles/github.min.css` 转成 JS 字符串 `window.__HLJS_CSS` | BSD-3-Clause |

## 怎么更新

```bash
npm pack marked highlight.js            # 拿到两个 tgz
# marked：lib/marked.umd.js 原样拷过来
# hljs：写一个 entry（import hljs from 'highlight.js/es/common.js'; window.hljs = hljs）
esbuild entry.js --bundle --minify --format=iife --outfile=highlight.min.js
# 主题：styles/github.min.css → JSON.stringify 成 hljs-theme.js
```

★为什么主题要转成 JS 字符串：markdown 预览是塞进 iframe 的 `srcdoc`（沙箱、禁脚本），
里面引不到本地 css 文件，样式只能随内容一起写进去。

## 口径（用户 2026-08-07 定）

**凡是有成熟开源实现的，直接用，不自己写。** 这个目录就是落点：
markdown 用 marked、消毒用 DOMPurify、代码上色用 highlight.js、diff 用 jsdiff 算 + diff2html 画、
终端用 xterm（在 `vendor/xterm/`）。自研只留在**没有现成件**的地方（业务流程本身）。
