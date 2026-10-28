# 验证报告

日期：2026-10-15（Asia/Shanghai）。执行环境：<user>@<SERVER_IP> 的 /opt/voice-hub；未在本地运行项目或同步代码。

## 已通过

- TypeScript 与 Vite 生产构建；Docker 应用镜像构建。
- 后端依赖及前端依赖 npm 安装审计均报告 0 漏洞（仅为安装时结果）。
- 三用户接口测试：注册、错误/正确登录、会话、CSRF 来源、非法参数、社区默认频道、非成员隔离、加入邀请、普通成员管理权限拒绝、消息存储、语音/文字类型限制、LiveKit 房间 grant 和约 10 分钟 TTL、撤销邀请、退出。
- 浏览器双账号流程：UI 注册、社区创建、邀请生成与主动加入、文字消息送达。
- 通过真实 LiveKit 服务器建立两个 WebRTC 连接，订阅测试麦克风音频轨道。
- 麦克风静音、静音收听。
- 合成屏幕视频通过 SFU 发布并在观看者浏览器解码显示；本地预览及停止分享后双方轨道清理。
- 切换社区与语音频道会退出前一房间，旧音频元素清理。
- 390px 窄屏无横向溢出。
- 不安全 HTTP 上点击加入语音时显示限制，不请求媒体令牌。
- 数据库重启前后账号/社区/消息数量一致：19 / 9 / 7（测试数据清理前）。
- 本次创建的测试账号及其社区、邀请、消息已按明确随机用户名列表清理，保留其他数据。
- 网站 HTTP、API 数据库健康、LiveKit HTTP 健康检查；服务器从自己的公网 IP 请求网站返回 HTTP 200。

## 验证边界

测试麦克风使用 Chromium 假设备，屏幕捕获使用 canvas 合成流。尚未验证真人可听声音、浏览器原生屏幕选择器及系统声音。
两个浏览器都在项目服务器运行，尚未验证两台外部电脑或不同网络、TURN 强制中继、真实断网恢复。
公网普通 HTTP 不具备媒体捕获安全上下文；需按 README 使用 SSH 转发到 localhost 临时测试，或配置可信 HTTPS。
云安全组未修改，外部网站和媒体端口是否全部放行仍应从用户网络验证。
没有 TURN/TLS；严格企业网络的连通性不作保证。
生产构建存在单个 JS chunk 大于 500kB 的提示，不影响本次构建。

## 运行版本

Node 22.23.3 Alpine（镜像摘要 sha256:0a7108bf6c7bf5de370ffb1a3ed6be93d405b43ff159f681a8d18c0e2bc2e402）。
PostgreSQL 17 Alpine（拉取摘要 sha256:b0f9560a2de083e2cc7382e75f808c7381a32852a7ec49117deedb300e552b24）。
LiveKit 1.9.12（摘要 sha256:2c13cbf2edcbf13ea7b20d05c10b394d04d8fb3fe358269cff845a90b4de9576）。
Gateway 使用 Node Alpine 基础镜像中的 Alpine nginx 1.30.4-r1 软件包；未修改宿主机服务或 Docker 镜像源。

测试源：tests/backend.mjs，tests/browser/smoke.mjs。
浏览器通过报告：tests/reports/browser.json。
持久化数量：tests/reports/persistence-before.txt 与 persistence-after.txt。
测试数据清理记录：tests/reports/cleanup.txt。
执行提示词：PROMPT.md。
部署与维护：README.md。

启动：docker compose up -d --build --wait。
状态：docker compose ps。
日志：docker compose logs --tail=100 api gateway media。
停止：docker compose stop。
数据持久化卷：voice-hub_postgres_data，禁止使用 down -v 作为日常停止命令。

## 1Panel 自签 HTTPS 更新（2026-10-15）

原报告中的“HTTPS 尚未配置”状态已更新：1Panel 网站 voice-hub 现通过自签证书提供 https://<SERVER_IP>/。
证书包含正确 IP SAN。HTTP 自动跳转，默认站点已设置，HSTS 关闭。
页面、API 和语音 WebSocket 通过 1Panel 三条反代规则分别转发。
使用 1Panel 公开 CA 进行严格 TLS 校验的 Node 检查通过：注册、Secure/HttpOnly Cookie、HTTPS 来源检查、wss 房间地址、WebSocket 服务器响应、房间关闭与退出。
没有在本地设备安装 CA，没有通过浏览器忽略证书错误，也未新增跨网络真人音视频实测。
仅清理本轮创建的 tls-test-mv8prz0f / tls-test-mv8ps78a 两个测试账号及其社区。

## 全屏与质量档位更新（2026-10-15）

生产TypeScript/Vite与Docker网关构建通过并部署，1Panel HTTPS入口继续反代该网关。
服务器双浏览器媒体控制测试通过：初始麦克风档位，24/48/96kbps实际发送编码参数，修改档位不解除麦克风静音；
进入真实Fullscreen API状态和全视口布局，屏幕四档发送maxBitrate/maxFramerate，切档不重复捕获屏幕也不打断观看者全屏；
按钮退出、双击进入、Esc退出及停止分享退出全屏，刷新后保留档位。
本次仅清理quality-test-mv8qeobka/b两个临时账号及其社区。
合成媒体验证边界与原报告一致，移动Safari的原生视频全屏回退尚未实测。
