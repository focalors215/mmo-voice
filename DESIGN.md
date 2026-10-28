# 喵喵零和小鱼的小屋 · 设计改造

本次对象是 React 网页语音社区：让朋友进入共同的小屋，找到频道并聊天、通话和分享屏幕。应用 Apple HIG 的可读性、适应性和材料原则；网页保留网页语义，不模仿原生窗口菜单。

## 改造前审查

总体：Critical issues。
- Critical：手机断点直接隐藏频道侧栏，频道无法切换。`layout.md › Adaptability`： “Design a layout that adapts gracefully to context changes while remaining recognizably consistent.” 改成保留入口的导航抽屉。
- High：消息时间等只有 10px，缺少可缩放层次。`accessibility.md › Vision`：“Support larger text sizes.” 改成 rem 排版，正文 16px，辅助 12–14px，验证 200% 文字。
- Medium：旧的薄荷黑色装饰和新名字没有联系，登录页与主界面需要一致的家园意象。此项为设计判断。

保留：真实社区、文字/语音频道分组、成员列表、邀请流程、语音状态、媒体质量档位和屏幕全屏。

## 设计规格

语义颜色（浅 / 深），以对应 surface 计算 WCAG 相对亮度比：

|角色|浅色|深色|对比度 浅/深|
|---|---|---|---|
|surface|#F7F8FC|#181B25|背景|
|正文|#202535|#F3F4FA|14.37 / 15.65|
|辅助正文|#596275|#B4BDCE|5.77 / 9.09|
|强调|#5856D6|#B8B2FF|5.65（白底） / 8.88|

颜色按角色命名，随系统浅深模式调整；高对比度强化边界。`color.md › Best practices`：“Make sure all your app’s colors work well in light, dark, and increased contrast contexts.”

系统 UI 字体（Apple 平台使用系统字体，中文 PingFang SC 等回退）；标题 22–28px，正文 16px，辅助 12–14px，操作至少 44px 触控区域。内容可滚动且不依赖固定文字高度。

桌面：社区轨道 | 频道侧栏 | 顶部频道与外观操作 / 内容 / 输入或通话控制 | 成员。
手机：频道按钮 / 当前频道 / 外观与成员；主内容；输入或通话控制。频道按钮展开包含社区选择的抽屉。

标识是猫与鱼共同的小屋线条；壁纸是窗边日景和夜景。品牌集中在入口与小屋标题，其余布局保持安静。无装饰数字、虚构在线状态或花哨自动动画。180ms 内轻微过渡可关闭，减少动态效果时禁用。

玻璃只用于侧栏、工具栏等功能层，内容保持实底。`materials.md › Liquid Glass`：“Don’t use Liquid Glass in the content layer.” 减少透明度时功能层改实色。

## 背景设置

内置日景、夜景、无背景；本地 PNG/JPEG/WebP 图片不上传服务器。IndexedDB 保存图片，localStorage 保存选项。透明度 0% 显示完整图片，100% 隐藏图片，默认 62%。文字、视频和按钮不受透明度影响。

外观面板独立于频道状态，改变设置不重挂 App 或 Voice。原生 dialog 提供 Esc、焦点限制、焦点归还；错误使用可见文字，图片错误可恢复默认。

## 方案自审

小屋窗景和猫鱼标识来自用户的名字；删去原来的无关几何装饰，避免通用营销模板。系统控件承载导航和输入，个性集中于一处标识和可自选背景。最终核验移动导航、文字放大、键盘焦点、减少动态/透明度、深浅模式和媒体不中断。

## 上线验证（2026-10-15）

TypeScript 与 Vite Docker 构建通过；仅重建 gateway，数据库/API/LiveKit 保持原服务，1Panel HTTPS 配置保留。通过受信任的本项目 CA 验证 HTTPS /api/health 与页面品牌、静态资源地址；四个服务健康。

服务器 Chromium 检查报告：
- tests/reports/appearance.json：预设切换；透明度 0/50/100；本地图片立即显示、刷新保持；非法文件不覆盖原图；移除/恢复默认；Esc 与焦点归还；320/390px 导航；系统深色；200% 文字。
- tests/reports/appearance-edge.json：非法存储数值、损坏图片安全恢复；320px+200%文字面板无横溢；减少透明度去除模糊。
- tests/reports/house-media.json：两个 LiveKit 客户端；换壁纸与透明度时语音 peer、采集请求和远端 video DOM 保持；真实全屏尺寸；全画质/音质档位；停止分享、Esc、双击与偏好保存。
- tests/reports/house-smoke.json：注册、创建社区、邀请加入、两账号消息传递、静音/收听、屏幕发布订阅、社区/频道切换清理、窄屏及 HTTP 限制。

媒体测试使用服务器上的模拟麦克风、canvas 画面；原生系统分享选择器、真人音质和跨网络连接不在此次自动检查范围。Vite 的媒体 SDK 合包大于 500KB 提示仍存在，无构建错误。

视觉复核：实看登录、聊天、320px 语音与外观窗口截图；移除外链字体、虚构成员在线状态，修正空舞台提示被挤到左边的问题。减少透明度使用实色导航；正文不透明。测试所创建的 4 个社区和 5 个用户已按报告对应身份清理，保留原有数据。
