# 声屿 Voice Hub

中文语音社区，React + Express + PostgreSQL + LiveKit SFU。应用及数据均位于服务器，本地不运行项目代码。

## 访问

网站： https://<SERVER_IP> （HTTP 80 自动跳转 HTTPS）
服务目录： /opt/voice-hub

首次访问自行注册账号，创建社区，生成邀请链接，再用第二个账号加入。
没有默认账号、演示在线成员或录音服务。社区成员列表表示成员关系，实际语音成员以 LiveKit 房间状态为准。
社区所有者可在成员面板移出成员或删除社区；其他成员可退出社区。
屏幕声音是否可分享取决于浏览器、操作系统与用户选定的分享源。

## HTTPS 与反向代理

HTTPS 由服务器上 1Panel 面板的“网站”功能在 OpenResty 上提供，站点名 voice-hub，监听 80/443。
证书为 1Panel 自签 CA 签发的 IP 证书（CN/SAN 为 <SERVER_IP>）。浏览器首次访问会提示证书不受信任；
如需消除提示，可在客户端信任 tls/1panel-ca.crt（仅限信任该服务器的设备）。
1Panel 站点只有一条反代：/ → http://127.0.0.1:18080（gateway），并传递 Host、X-Forwarded-For/Host/Proto，支持 WebSocket 升级与 3600s 超时。
/api/ 与 /rtc/ 由 gateway 内部再转发到 API（127.0.0.1:3000）与 LiveKit（127.0.0.1:7880），不要在 1Panel 中绕过 gateway 直连。
gateway 仅监听 127.0.0.1:18080，并信任回环来源的 X-Forwarded-* 头；API 的 trust proxy 为 loopback。

SSH 转发仍可用于排障：ssh -L 18080:127.0.0.1:18080 <user>@<SERVER_IP> 后访问 http://localhost:18080 。

## Docker 运维

以下命令只在项目服务器执行：

    cd /opt/voice-hub
    docker compose up -d --build
    docker compose ps
    docker compose logs --tail=100 api gateway media
    docker compose restart
    docker compose stop

不要执行 docker compose down -v，该操作会删除持久化数据。
数据库仅在项目 Docker 网络及服务器回环地址 15432 可访问，API 仅绑定服务器回环地址 3000；LiveKit 信令回环地址 7880，通过 gateway 的 /rtc/ 对外。
gateway/media/api 使用 Linux host 网络。项目自身不占用 80/443（属于 1Panel OpenResty）及服务器上其他服务的端口。

## 端口与网络

网站 TCP 443（及跳转用 80），由 OpenResty 提供；18080 仅回环。
ICE/TCP 7881，ICE/UDP 50000–50100。
TURN/UDP 3478，TURN 中继 UDP 30000–30100。
对应端口需允许云安全组和服务器防火墙入站。未自动更改云安全组或防火墙。
LiveKit 将 <SERVER_IP> 作为公网候选地址。没有 TURN/TLS，严苛网络的兼容性仍需后续 HTTPS/TURN TLS 部署和实测。
端口变更需同步 nginx.conf、Compose gateway 健康检查与使用文档。

## 配置与数据

.env 和 livekit.yaml 为服务器生成的私有运行配置，权限 600，已加入 .gitignore 和 .dockerignore，不应分享或提交。
.env.example / livekit.example.yaml 是不含真实密钥的模板。更换 LiveKit 密钥时需同时修改上述两个私有配置。
数据库持久化卷：voice-hub_postgres_data。
数据库表在 API 启动时按幂等初始化脚本创建。将来修改 schema 应新增显式迁移，而非删卷重建。
社区邀请有有效期且可撤销。邀请码视为加入凭据，仅提供给希望加入的成员。

备份数据库：

    cd /opt/voice-hub
    mkdir -p backups
    chmod 700 backups
    umask 077
    docker compose exec -T database pg_dump -U voice_hub voice_hub > backups/voice-hub-$(date +%Y%m%d-%H%M%S).sql

恢复前停止 API 与 gateway，确认备份目标和数据覆盖范围后，在 database 容器用 psql 导入。该文档不会自动恢复或删除数据。

升级前先备份数据库和代码，再更新明确的镜像/依赖版本，构建与验收后部署。不要盲目升级系统或其他项目。
构建使用依赖锁文件；运行镜像与镜像摘要记录于部署验证报告。

## 验证

接口与权限测试（仅在项目服务器，创建带随机前缀的测试账号；测试数据在报告中说明）：

    docker run --rm --network host -v /opt/voice-hub/tests:/tests:ro node:22.23.3-alpine node /tests/backend.mjs
    docker run --rm --network host -v /opt/voice-hub/tests:/tests:ro node:22.23.3-alpine node /tests/members.mjs
    docker run --rm --network host -v /opt/voice-hub/tests:/tests:ro -e NODE_TLS_REJECT_UNAUTHORIZED=0 -e BASE_URL=https://<SERVER_IP> node:22.23.3-alpine node /tests/members.mjs

浏览器测试（voice-hub-browser-check 镜像，报告写入挂载的 /reports）：smoke、house-smoke、media-controls、house-media、listen-only、voice-processing、mic-test、appearance、appearance-edge。

测试脚本不包含在生产镜像内，使用独立临时 Node 容器执行。
完成标准：两位独立用户在安全上下文内双向听见声音、静音/退出正确、一方屏幕分享另一方实际看到、停止后消失、重连清理、权限隔离、容器重启后数据保留。
HTTP/健康检查成功不代表实际双人媒体已经验收。

## 1Panel 自签 HTTPS（2026-10-15）

已在 1Panel 网站功能中创建 voice-hub 反向代理网站：
- https://<SERVER_IP>/，TLS 443，HTTP 80 自动跳转。
- 设置为默认网站，以支持 IP 请求的 TLS。
- 自签证书由 1Panel-CA 签发，SAN 包含 IP Address:<SERVER_IP>，到期时间 2027-10-15。
- HSTS 关闭，TLS 1.2/1.3。
- 2026-10-28 起只保留一条反代：/ 转发至 127.0.0.1:18080（gateway），/api/ 与 /rtc/ 由 gateway 转发；
  原 /api/、/rtc/ 直连规则已移至 backups/openresty-removed/。
证书、站点默认项、HTTPS 和反向代理规则均由 1Panel 管理，后续请在面板对应站点修改。
自签证书不自动获得浏览器信任。需在使用设备上由用户自行信任证书；助手没有绕过浏览器证书警告或修改设备信任设置。
公开 CA 证书已从 1Panel 导出到 /opt/voice-hub/tls/1panel-ca.crt，仅含公钥证书。
2026-10-28 起 18080 仅监听回环，公网不可直接访问；SSH 转发至 localhost 的测试仍可用。

验证：HTTPS 页面 200、HTTP 到 HTTPS 301、指定 CA 下的 TLS/IP 校验、带 Secure/HttpOnly 的登录 Cookie、真实 WSS 握手和房间关闭均通过。
HTTPS 检查的两个临时测试账号及其社区已清理，不影响正式账号。

## 屏幕全屏和媒体档位（2026-10-15）

每个共享画面（含本地预览）都有“全屏”按钮，也可双击画面进入或退出全屏。Esc /“退出全屏”可恢复正常布局，停止分享或离开频道会清理画面并退出全屏。
画面保持原比例，不拉伸或裁切。

屏幕分享画质：省流（最高360p/15fps/400kbps）、标准（最高720p/30fps/1.5Mbps）、高清（最高1080p/30fps/3Mbps）、超清（最高1440p/30fps/6Mbps）。
麦克风音质：Opus单声道省流24kbps、标准48kbps、高音质96kbps；立体声高保真192kbps、极致320kbps。
立体声档位关闭浏览器回声消除、降噪和自动增益，适合唱歌、乐器或播放音乐，需佩戴耳机；单声道与立体声互相切换时会重新发布麦克风（静音状态下只在重新开麦时生效）。
LiveKit 应答允许 Opus 最高 510kbps，实际码率仍受网络与浏览器限制。

## 降噪、人声凸显与设备选择

语音页的“声音与设备”中可选择麦克风、扬声器、降噪方式和人声凸显，选择保存在当前浏览器。
所有处理都在成员自己的浏览器内完成（发送前处理），服务器不做音频运算：项目服务器为 2 vCPU、无 GPU，
逐路服务端解码、降噪、再编码既占满 CPU 又增加延迟；LiveKit Krisp 仅限 LiveKit Cloud。

- 降噪：关闭 / 标准（浏览器内置） / AI 降噪（RNNoise） / AI 强力降噪（GTCRN），由 @sapphi-red/web-noise-suppressor 的 AudioWorklet + WASM 实现，模型文件约 115 KB（gzip），仅在启用时下载。
- 人声凸显：80 Hz 高通、250 Hz 去浑浊、3.2 kHz 清晰度提升、高频空气感、压缩器与限幅器。
- 立体声高保真 / 极致档位不做降噪与人声凸显，以免损伤音乐。
- 扬声器选择依赖浏览器 setSinkId；不支持时界面提示在系统设置中切换。
- CSP 需包含 script-src 'wasm-unsafe-eval' 以编译降噪模型。
- 声音测试（回环）：“录音 5 秒并回放”按所选音质码率经 Opus 编码后从所选扬声器回放，接近对方听到的效果，外放也不会啸叫；“实时监听”需佩戴耳机。
  通话中且麦克风开启时测试的是正在发送的声音；否则按当前设备、降噪与人声凸显设置单独采集，不会发送到频道。

浏览器测试 voice-processing.mjs 覆盖以上切换；Chromium 假麦克风为持续蜂鸣音，会被 AI 降噪视为噪声消除，真实人声效果需实测。
可在分享或通话中调整；档位保存在设备浏览器偏好中，实际源分辨率、设备、浏览器与网络影响最终效果。
调整通过现有采集轨道约束和发送编码参数完成，不重新发布轨道，不弹新屏幕选择器；保持麦克风与收听静音。
音频协商上限96kbps，实际编码上限按所选档位应用，支持从低档切高档。重连后重新应用所选档位。
浏览器不允许动态调整采集分辨率时会提示：编码参数已调整，重新分享时应用采集分辨率。
仅屏幕共享画质与麦克风音质提供档位；共享系统声音能力仍由浏览器和分享源决定。

验证脚本：tests/browser/media-controls.mjs。通过报告：tests/reports/media-controls.json。
浏览器测试使用服务器上合成媒体，已检查实际RTCRtpSender编码参数、全屏布局、退出/移除及偏好持久化。
