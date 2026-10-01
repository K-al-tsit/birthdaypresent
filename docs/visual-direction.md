# 蓝色手记：视觉改版

本次方向：用简洁的 SVG、墨蓝、纸白、书信式排版，表达用户指定的两支 MV 的大致氛围；不追求逐帧还原，不使用生成图片或复制 MV 素材。

## 调研参考

- ヨルシカ 官方 MV 索引：https://yorushika.com/news/9/?page=6
- 《だから僕は音楽を辞めた》官方页：https://yorushika.com/news/detail/11096
- n-buna / suis 访谈：https://music.fanplus.co.jp/special/20190413321e430f7
  - 创作者描述了收件人打开装有音乐与信件的木箱的概念。
  - “藍”与墨水、天空的联系来自访谈中对《藍二乗》的解释。
- MV 画面参考：https://spice.eplus.jp/articles/233555
- 《藍二乗》画面与访谈：https://natalie.mu/music/pp/yorushika03

设计转译：窗与海天表现蓝色光线；纸白背景和细线曲目表构成唱片内页；少量赭红作为邮戳与墨迹。手写 SVG 位于 assets/blue-room.svg。纸片仅做轻微动画，可手动关闭，并遵循设备减少动态效果设置。

## 使用与发布

纯静态网站，不需要构建步骤。index.html、assets/styles.css、assets/app.js 是今年的页面。21 首歌曲仍为原有占位数据，待添加实际歌名、寄语与音频地址。

在 assets/app.js 的 tracks 中设置每首歌曲的 no、title、subtitle、note、src。空 src 不会产生虚假的播放状态。进度条在音频元信息可用后启用。

沿用 birthday-21 分支发布，保留 memory/20/ 的去年页面及现有资源。不得因本次视觉改版自动合并 main。

## 已完成的检查

- 桌面和 390px 手机断点的浏览器视觉检查；390px 下页面宽度无溢出，所有插画均加载成功。
- 21 首曲目、选曲同步、上一首/下一首首尾环绕、空音频提示、循环开关。
- 原生回忆弹窗显示、Escape 关闭以及去年页面链接。
- 浏览器控制台无错误；JavaScript 语法、HTML 唯一 ID、本地引用路径与 SVG XML 检查通过。
- 歌曲未接入，因此未进行真实音频播放/拖动进度的端到端验收。
