# CIBYP-TRNG - 真随机数生成器固件

本固件基于ESP32实现真随机数生成器（TRNG），通过硬件噪声产生高质量随机数，可通过串口或网络HTTP接口提供随机数服务。

## 硬件需求

- ESP32开发板（支持ESP32、ESP32-S2、ESP32-S3、ESP32-C3等）
- USB数据线（用于烧录和串口通信）

## 烧录步骤

### 方法一：使用Arduino IDE 2.x（推荐）

1. **下载并安装Arduino IDE 2**
   - 访问 <https://www.arduino.cc/en/software>
   - 下载并安装Arduino IDE 2.x版本

2. **安装ESP32开发板支持**
   - 打开Arduino IDE
   - 进入 File -> Preferences -> Additional Boards Manager URLs
   - 添加：`https://espressif.github.io/arduino-esp32/package_esp32_index.json`
   - 进入 Tools -> Board -> Boards Manager
   - 搜索"ESP32"并安装"esp32 by Espressif Systems"

3. **配置开发板**
   - Tools -> Board -> esp32 -> 选择你的ESP32开发板型号（如ESP32 Dev Module）
   - Tools -> Port -> 选择对应的COM端口
   - Tools -> Upload Speed -> 建议选择115200或更高

4. **打开固件代码**
   - 在应用内点击"导出固件源码"按钮，选择一个目录导出固件
   - 在Arduino IDE中打开导出的`CIBYP-TRNG.ino`文件

5. **配置WiFi（可选，如果使用网络模式）**
   - 在代码中找到WiFi配置部分
   - 修改`ssid`和`password`为你的WiFi名称和密码

6. **编译并烧录**
   - 点击Arduino IDE顶部的"Upload"按钮（右箭头图标）
   - 等待编译和烧录完成
   - 烧录成功后，打开串口监视器查看运行状态

### 方法二：使用esptool.py

如果已经有编译好的固件bin文件：

```bash
pip install esptool

esptool.py --chip esp32 --port COM3 --baud 921600 write_flash -z 0x1000 bootloader.bin 0x8000 partitions.bin 0x10000 firmware.bin
```

## 使用说明

### 串口模式

- 波特率：115200（默认）或在应用设置中配置的波特率
- 数据格式：8N1
- 连接后自动开始发送随机数据流（每次32字节）

### 网络模式

- ESP32启动后会创建WiFi热点或连接已配置的WiFi
- 默认HTTP端口：80
- 访问 `http://<ESP32_IP>/random?bytes=64` 获取64字节随机数
- 返回格式：JSON `{"random":"<hex_string>"}`

## 配置选项

在Arduino IDE中，可以通过修改代码调整以下参数：

- WiFi SSID/密码
- HTTP服务器端口
- 串口波特率
- 随机数输出格式

## 故障排查

### 烧录失败

- 确认USB线支持数据传输（不是充电线）
- 确认已选择正确的COM端口
- 尝试按住BOOT按钮再点击Upload
- 降低Upload Speed到115200

### 无法连接WiFi

- 检查WiFi SSID和密码是否正确
- 确认WiFi是2.4GHz（ESP32不支持5GHz）
- 查看串口监视器的日志信息

### 串口无数据

- 确认波特率设置正确（115200）
- 检查USB驱动是否正确安装
- 尝试重新插拔USB线或重启ESP32

## 技术支持

如有问题，请检查：

1. Arduino IDE版本是否为2.x
2. ESP32开发板支持包是否正确安装
3. 串口监视器日志输出

---
