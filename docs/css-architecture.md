# CSS 架构

当前页面采用两层样式结构：

- `assets/styles.css`：基础视觉与历史组件样式。此文件视为 **legacy base**，除大规模重构外不再追加临时覆盖。
- `assets/stability.css`：最终稳定层，始终在 `styles.css` 之后加载。跨浏览器修复、safe-area、短视口/横屏适配、播放器对比度和最终布局约束统一放在这里。

## 修改原则

1. 不再通过在 `styles.css` 末尾追加同一选择器的新版本来修问题。
2. 新的兼容性或最终覆盖规则进入 `stability.css`，并尽量使用组件级选择器而不是 `!important`。
3. JavaScript 驱动的视觉状态通过 CSS 自定义变量传递；例如播放器亮度只修改 `--player-*` 变量，不直接写具体组件样式。
4. 响应式按三类处理：普通移动端、短视口/横屏、桌面。涉及播放器时必须同时验证三类。
5. 等当前生日版本稳定后，可以做一次“无视觉变化”的第二阶段压平：根据最终 computed styles 合并 `styles.css` 中的历史重复规则，再删除 legacy 覆盖。发布前不做一次性重写，以避免无必要的视觉回归。

## 当前重点保护场景

- iPhone 竖屏与横屏 safe-area
- 高度较小的桌面浏览器窗口
- 极浅/极深歌曲封面
- 歌词和 `.zh.lrc` 更新后的重新请求
- NFC / NFD 两种 Unicode 文件名
- 减少动态效果（prefers-reduced-motion）
