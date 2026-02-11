# CIBYP-IoT-TRNG

ESP32 硬件真随机数发生器固件，为 **Could I Be Your Partner** 应用提供基于物理噪声的塔罗牌抽取服务。

## 支持芯片

- ESP32-S3
- ESP32-C3
- ESP32-C6

## 功能特性

- **硬件 TRNG**: 使用 ESP32 内置的真随机数发生器（基于热噪声/射频噪声）
- **WiFi AP 模式**: 默认 SSID `CIBYP-IoT-TRNG`，开放网络
- **美观 WebUI**: 支持多种牌阵抽牌，包含正逆位判定和简要分析
- **REST API**: 抽牌、牌阵、随机数、设备信息、配置
- **串口通信**: 支持通过串口发送命令抽牌
- **OTA 更新**: 通过 WebUI 上传固件在线更新

## 支持牌阵

| 牌阵 | 张数 | 说明 |
|------|------|------|
| 单牌 | 1 | 单一指引 |
| 是非牌 | 1 | 是/否问题 |
| 三张牌阵 | 3 | 过去/现在/未来 |
| 五芒星 | 5 | 全面分析 |
| 关系牌阵 | 5 | 双方关系 |
| 马蹄牌阵 | 7 | 深度分析 |
| 六芒星 | 7 | 多维度 |
| 凯尔特十字 | 10 | 经典全面 |
| 黄道十二宫 | 12 | 星座对应 |

## API 接口

### `GET /api/draw`

抽取单张塔罗牌。

**响应示例:**

```json
{
  "cardIndex": 0,
  "name": "愚者",
  "nameEn": "The Fool",
  "arcana": "major",
  "isReversed": false,
  "orientation": "upright",
  "meaningOfUpright": "新的开始、冒险、自由",
  "meaningOfReversed": "鲁莽、冲动、不计后果"
}
```

### `GET /api/spread?type=<type>`

按牌阵抽牌。支持: `single`, `three`, `celtic`, `horseshoe`, `star`, `hexagram`, `zodiac`, `yes_no`, `relationship`

### `GET /api/random`

获取原始 TRNG 随机数。

### `GET /api/info`

获取设备信息。

### `GET /api/config`

获取 AP 配置。

### `POST /api/config`

设置 AP 配置 (参数: `ssid`, `password`)。

### `POST /api/ota`

上传固件进行 OTA 更新 (multipart/form-data, field: `firmware`)。

## 串口协议

波特率: 115200，命令以换行符结尾。

| 命令 | 说明 |
|------|------|
| `DRAW` | 抽取单张牌，返回 JSON |
| `SPREAD:<type>` | 按牌阵抽牌 (three, celtic, etc.) |
| `RANDOM` | 获取原始随机数 |
| `INFO` | 获取设备信息 |
| `PING` | 连通性测试 |

## 在 Could I Be Your Partner 中使用

1. 将 ESP32 设备上电
2. 电脑连接到 `CIBYP-IoT-TRNG` WiFi（或通过 USB 串口连接）
3. 在 CIBYP 设置 > 熵源 中：
   - 选择 "TRNG" 熵源
   - 配置网络 API（IP: 192.168.4.1, 端口: 80）或串口
4. 点击测试连接确认
5. 所有抽牌操作将使用硬件真随机数

## License

MIT
