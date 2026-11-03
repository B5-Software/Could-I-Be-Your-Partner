# CIBYP TRNG 2 — Rust + ESP-IDF 6.1

本目录已移除 Arduino。协议、输入解析、抽牌和认证使用无堆分配的 Rust `no_std` 核心；ESP-IDF 的 C 边界负责启动、硬件 RNG、串口、GPIO、NVS 与 Wi-Fi/HTTP/WebSocket 传输。IDF/FreeRTOS 和少量 FFI 仍属于信任边界，不能宣称整个固件都由内存安全语言构成。

## 直接安装

应用设置 → TRNG 固件 → 选择 USB 设备 → 识别并校验 → 安装固件。使用 Espressif `esptool-js` 和应用已有的原生串口模块，无需 Arduino、Python、浏览器 Web Serial 或外部烧录程序。WebUI 操作的是后台所在电脑的 USB 设备。

预编译镜像位于应用 `assets/trng-firmware`，清单绑定芯片、控制台接口、分段地址、文件大小、SHA-256、IDF 提交和 Rust 源码摘要。检测只读取 ROM 身份和安全信息；写入前再次核对设备 MAC/安全状态。安装不整片擦除，不提供 force 或 eFuse 写入接口。读回 MD5 用于检测传输错误；来源信任来自随应用交付的 SHA-256 清单和可信应用安装包。

原生 USB Serial/JTAG 与 USB-UART 桥使用不同控制台镜像。至少需要 4 MB Flash。新分区布局与旧固件不同，升级前备份设备配置。若自动复位失败：按住 BOOT，按下并松开 RESET，再松开 BOOT，然后重新识别。安全启动、Flash 加密或安全下载模式已开启的设备会被拒绝覆盖，必须走所有者签名的更新流程。

目标：ESP32-C3、ESP32-C6、ESP32-S31。S31 在 IDF 6.1 中是预览目标，其物理确认 GPIO 默认禁用；须按实际开发板原理图配置，不能猜测。普通 ESP32/S3 尚未完成新 Rust 工具链和镜像验收，安装器会拒绝而不是刷入其他芯片镜像。

## 默认固件的安全范围

- 首次启动为空密码配置热点 `CIBYP-Tarot-<设备后缀>`，最多连接一个客户端。打开 `http://192.168.4.1`，必须先设定热点名称与 8–63 位 ASCII 密码。保存后自动重启，新热点使用 WPA2。未配置时 HTTP/WebSocket 均拒绝抽牌和随机数；仅保存而尚未切换到加密热点也不会解锁。
- 保留抽牌 REST 接口，新增 `/ws` WebSocket。前端支持九种牌阵、正逆位、深浅主题、简中/英/德、连接状态、自动重连、最近 50 次本地记录与导出。不自动重试结果未知的抽牌。
- 后续热点设置使用当前热点密码或独立管理码认证。USB `NETWORK` 命令或应用内「读取热点与管理码」可查看凭据；网络接口不返回密码或管理码。后续配置修改手动重启生效。
- Wi-Fi 初始化前关闭 SAR 熵源；AP 启动事件后使用 RF 熵源，Wi-Fi 关闭省电。AP 停止后熵请求失败关闭。不会让 SAR 与 RF 争用硬件。
- 384 字节输入、8192 字节输出、固定数组、有限拒绝采样；检测恒定及重复随机块。这里只是失效检测，不是 NIST SP 800-90B 熵源认证。
- 普通随附镜像不会开启安全启动、Flash 加密、防回滚或烧写 eFuse，也不会生成 eFuse HMAC 密钥。
- 开发版仅提供塔罗/随机数，**拒绝 `PAIR2` 和钱包补充熵请求**。不能把未加固开发板显示为安全硬件钱包。

## 串口协议

### 问题参与抽牌

填写「此刻，你在想什么？」时，浏览器将 NFC 规范化的文字与每次新生成的 32 字节系统随机盐做 SHA-256，仅发送摘要。问题原文只保存在浏览器的本地历史与用户主动导出的记录中；设备不收到原文，也不保存摘要。随机盐不发送、不持久化，避免对常见短问题直接查字典。

`DRAW2 <32-byte-lowercase-hex-digest>` 与 `SPREAD2 <牌阵类型> <digest>` 每次必须读取新的 64 字节硬件随机块，通过健康检查后，以问题摘要为 salt 做 RFC 5869 HKDF-SHA-256 Extract，再以协议域、牌阵与计数器为 info 做 Expand，进行有限拒绝采样。响应的 `questionMixed: true` 表示本次使用了此流程。空问题继续使用原有 `DRAW` / `SPREAD`。

文字只是混合参数，不计入熵预算。混合结果由 TRNG 驱动，属于密码学调理后的随机结果，不能称为未经处理的原始 TRNG；它不证明物理熵源通过认证。硬件熵源失败时直接拒绝抽牌，绝不回退为文字种子伪随机。钱包熵协议不受这个功能影响。

WebSocket 接收相同 ASCII 命令；REST 使用 `POST /api/spread`，`Content-Type: text/plain`，body 为 `SPREAD2 <type> <digest>`，不把问题放进 URL。WebUI 自带经过锁定和校验的 SHA-256 实现，在设备离线 HTTP 热点页面上也可工作，无需 CDN 或安全上下文的 `crypto.subtle`。

算法依据：[RFC 5869](https://www.rfc-editor.org/rfc/rfc5869.html)。

115200 baud，ASCII 命令加换行，JSON 单行响应。兼容 `PING`、`INFO`、`DRAW`、`RANDOM` 和 `SPREAD:single|three|celtic|horseshoe|star|hexagram|zodiac|yes_no|relationship`。抽牌返回 `cardIndex`、牌名、释义与正逆位。牌库由主程序 `src/data/tarot.js` 生成，离线页面不依赖 CDN。`NETWORK` 仅允许 USB；SSID 和密码以十六进制字段返回，管理码为独立 32 位十六进制值。

`INFO` 返回协议 2、固件版本、设备 ID 和安全标志。标志位依次为 Secure Boot、Release Flash encryption、PAD/USB JTAG 均硬关闭、加密 NVS、编译启用防回滚。钱包熵协议要求全部五项（31）。这是通过已配对设备报告的状态，不是厂商远程证明，也不证明设备抵抗所有物理攻击。

所有者加固后的设备才接受：

- `PAIR2 <32-byte-lowercase-hex-key>`：必须持续按下已配置的物理按键两秒；PSK 仅保存到加密 NVS，不回显。
- `ENTROPY2 <32-byte-nonce-hex> <32-byte-request-HMAC-hex>`：校验请求 HMAC，再返回设备 ID、原 nonce、64 字节熵、安全标志和响应 HMAC。重复最近挑战、未配对、未加固、认证失败及 RNG 失效都拒绝。

HMAC-SHA-256 域分隔为 `CIBYP-TRNG/2/request\n` / `CIBYP-TRNG/2/response\n`；设备 ID、nonce、熵使用小写十六进制，字段以换行分隔；响应末尾的安全标志使用四字节大端整数。该协议是预共享密钥认证，不是 ML-KEM，也不提供 USB 链路的加密或通用硬件签名。不能向设备发送钱包私钥、助记词或钱包解锁密码。

当前主机钱包尚未启用此硬件配对/熵混合入口；固件协议和安装器的实现不能被描述为钱包已具备硬件第二因素。

## 构建和验证

78 张插画原图与逐张生成提示词分别保存在仓库 `artwork/tarot/originals`、`artwork/tarot/prompts.json`。先执行 `node scripts/build-trng-webcrypto.cjs` 与 `node scripts/build-tarot-art.cjs`，再执行 `node scripts/check-tarot-art.cjs`。缺少任意牌面或哈希不符均拒绝打包。桌面端图片为 512×768 WebP；设备端为 224×336 WebP，放在独立 1.875 MiB 数据分区，HTTP 按 1 KiB 分块发送，不一次载入整套图片。签名应用中的摘要绑定整个资源分区。4 MiB 布局保留两个 1 MiB OTA 应用槽；每个目标构建必须检查应用是否适合槽位。

应用导出的源码 ZIP 同时包含 `resources/tarot-art.bin`，可独立构建；不需要再次生成插画。

项目仓库根目录：

1. 安装官方 ESP-IDF **v6.1** 及其锁定的 RISC-V 工具；保持 SDK 子模块与该标签一致。
2. Rust **1.99.1**，安装 `riscv32imac-unknown-none-elf`（C3/C6）和 `riscv32imafc-unknown-none-elf`（S31）。
3. 创建隔离 Python 环境，按 IDF `requirements.core.txt` 和官方 `espidf.constraints.v6.1.txt` 安装依赖。设置 `CIBYP_ESP_IDF`、`CIBYP_IDF_PYTHON`，必要时设置 `CIBYP_CARGO`。
4. `node scripts/build-trng-firmware.cjs esp32c6 uart`；`usb` 选择原生 USB Serial/JTAG。芯片还可选择 `esp32c3`、`esp32s31`。构建器拒绝安全 eFuse 配置，生成真实分段 `.bin` 和清单。
5. `cargo +1.99.1 test --manifest-path IoT-Firmware/CIBYP-TRNG/rust/Cargo.toml --package cibyp-trng-core --locked`。

导出的独立源码也可先 `cargo build --manifest-path rust/Cargo.toml --package cibyp-trng-ffi --target <target> --release --locked`，再在已激活的 IDF 6.1 环境调用 `idf.py -D IDF_TARGET=esp32c6 -D CIBYP_RUST_LIBRARY=<绝对路径>/rust/target/<target>/release/libcibyp_trng_ffi.a build`。不要把项目目录作为钱包密钥或签名私钥的存放位置。

## 生产加固必须另行验收

`sdkconfig.production` 是所有者专用的加固配置草案，不是随附开发固件，也没有在实物上完成验收。安全配置构建还要求显式 `CIBYP_PROVISIONING_ACK=OWNER_REVIEWED_IRREVERSIBLE_EFUSES`；普通构建器不会使用它。

生产需逐块核对芯片修订、安全公告、eFuse 状态与可用位、独立签名密钥、每设备独立 Flash 密钥、NVS 加密、防回滚版本、PAD/USB JTAG、ROM 下载策略及故障恢复。首次启动和后续安全版本更新可能永久改变 eFuse。应先在可报废板上验证，再对实际设备逐项确认。所有者签名更新、加固向导和真实物理攻击测试尚未完成；不要仅凭此配置文件宣称已防破解。

官方依据：[RNG](https://docs.espressif.com/projects/esp-idf/en/v6.1/esp32c6/api-reference/system/random.html)、[安全概览](https://docs.espressif.com/projects/esp-idf/en/v6.1/esp32c6/security/security.html)、[IDF 6.1](https://github.com/espressif/esp-idf/releases/tag/v6.1)、[esptool-js](https://github.com/espressif/esptool-js)。

## HTTP / WebSocket

- 保留 `GET /api/draw`、`GET /api/spread?type=three`、`GET /api/random`、`GET /api/info`。旧牌阵名保留，未知牌阵返回错误。
- `/ws` 接收单帧文本 `INFO`、`PING`、`DRAW`、`RANDOM`、`SPREAD:<类型>`；一条命令对应一条 JSON 响应，按顺序发送。载荷最多 384 字节，拒绝分片、二进制和超大帧。
- 网络共享每秒 12 条命令限流，最多四个 HTTP/WS 连接。只接受 AP IP 对应的 Host/Origin，不放行 CORS 或跨站嵌入。
- 首次设置：`POST /api/config`，请求头 `X-CIBYP-Setup: 1`，纯文本 body `NETCFG <SSID小写hex> <密码小写hex>`。仅未配置时开放，首次成功保存后等待重启，不接受覆盖。空密码热点的首次配网不能抵御附近主动攻击者，应在可信环境完成。
- 后续设置使用相同接口及 `Authorization: Bearer <当前热点密码或USB管理码>`。Rust 按 UTF-8 字节数、ASCII 密码范围验证输入。密码不存入浏览器或查询字符串。HTTP 受 WPA2 无线链路保护，不声称提供端到端 TLS。
- `PAIR2`、`ENTROPY2`、`NETWORK` 在网络 Rust 入口一律拒绝，即使管理认证成功。
- 不提供未经认证的无线 OTA；使用应用内 USB 烧录。安全加固设备使用所有者签名的更新流程。

## 本地页面验证

构建 host-only Rust example：`cargo +1.99.1 build --manifest-path IoT-Firmware/CIBYP-TRNG/rust/Cargo.toml -p cibyp-trng-core --example preview --locked`，然后运行 `electron tests/integration/trng-webui.cjs`。

测试驱动真实 Rust 协议核心与实际离线页面，覆盖历史持久化、首次设置、断线不重抽、配置认证、深浅色和窄屏，并生成 `.cache/previews/trng-webui-*.png`。HTTP/无线部分为测试夹具，不能替代 ESP32 实机射频、USB 与烧录验证。
