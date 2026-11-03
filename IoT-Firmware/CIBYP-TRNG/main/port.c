/* SPDX-License-Identifier: GPL-3.0-or-later */
/* Thin IDF 6.1 boundary. Protocol, parsers and authentication live in Rust. */
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "sdkconfig.h"
#include "esp_random.h"
#include "bootloader_random.h"
#include "esp_mac.h"
#include "esp_secure_boot.h"
#include "esp_flash_encrypt.h"
#include "esp_efuse.h"
#include "esp_efuse_table.h"
#include "nvs_flash.h"
#include "nvs.h"
#include "driver/gpio.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "network.h"

extern size_t cibyp_dispatch(const uint8_t *, size_t, uint8_t *, size_t);
static bool entropy_ready;
static bool sar_enabled;
static portMUX_TYPE rng_lock = portMUX_INITIALIZER_UNLOCKED;
static bool storage_ready;
static uint8_t input[384];
static uint8_t output[8192];
static void clear_secret(void *p, size_t n) { volatile uint8_t *b=p; while(n--) *b++=0; }

bool cibyp_rng(uint8_t *out, size_t length) {
    if(!out || length>64) return false;
    portENTER_CRITICAL(&rng_lock);
    bool ready=entropy_ready;
    if(ready) esp_fill_random(out,length);
    portEXIT_CRITICAL(&rng_lock);
    return ready;
}
void cibyp_entropy_rf(bool enabled) {
    /* The SAR source must be off BEFORE the Wi-Fi driver is started. If RF
       stops, fail closed; never silently claim physical entropy is available. */
    portENTER_CRITICAL(&rng_lock);
    entropy_ready=enabled;
    if(sar_enabled) {bootloader_random_disable();sar_enabled=false;}
    portEXIT_CRITICAL(&rng_lock);
}
void cibyp_id(uint8_t *out) { if(esp_efuse_mac_get_default(out)!=ESP_OK) memset(out,0,6); }
uint32_t cibyp_security(void) {
    uint32_t flags=0;
    if(esp_secure_boot_enabled()) flags|=1;
    if(esp_get_flash_encryption_mode()==ESP_FLASH_ENC_MODE_RELEASE) flags|=2;
#if CONFIG_IDF_TARGET_ESP32C3 || CONFIG_IDF_TARGET_ESP32C6 || CONFIG_IDF_TARGET_ESP32S3 || CONFIG_IDF_TARGET_ESP32S31
    if(esp_efuse_read_field_bit(ESP_EFUSE_DIS_PAD_JTAG) && esp_efuse_read_field_bit(ESP_EFUSE_DIS_USB_JTAG)) flags|=4;
#endif
#if CONFIG_NVS_ENCRYPTION
    if(storage_ready) flags|=8;
#endif
#if CONFIG_BOOTLOADER_APP_ANTI_ROLLBACK
    flags|=16;
#endif
    return flags;
}
bool cibyp_presence(void) {
#if CONFIG_CIBYP_CONFIRM_GPIO >= 0
    for(int i=0;i<100;i++) { if(gpio_get_level(CONFIG_CIBYP_CONFIRM_GPIO)!=0) return false; vTaskDelay(pdMS_TO_TICKS(20)); }
    return true;
#else
    return false;
#endif
}
bool cibyp_load_pair(uint8_t *out) {
    if(!storage_ready) return false;
    nvs_handle_t handle; size_t length=32;
    if(nvs_open("trng_secure",NVS_READONLY,&handle)!=ESP_OK) return false;
    esp_err_t result=nvs_get_blob(handle,"pair",out,&length); nvs_close(handle);
    return result==ESP_OK && length==32;
}
bool cibyp_store_pair(const uint8_t *key) {
    if(!storage_ready || cibyp_security()!=31) return false;
    nvs_handle_t handle;
    if(nvs_open("trng_secure",NVS_READWRITE,&handle)!=ESP_OK) return false;
    esp_err_t result=nvs_set_blob(handle,"pair",key,32);
    if(result==ESP_OK) result=nvs_commit(handle);
    nvs_close(handle); return result==ESP_OK;
}
void app_main(void) {
    /* Generate initial AP credentials with SAR entropy, then hand off to the
       running Wi-Fi RF source. network.c keeps power saving disabled. */
    bootloader_random_enable(); sar_enabled=true;entropy_ready=true;
    /* Do not erase NVS on an initialization error: preserve pairing material. */
    storage_ready=(nvs_flash_init()==ESP_OK);
#if CONFIG_CIBYP_CONFIRM_GPIO >= 0
    gpio_config_t button={.pin_bit_mask=1ULL<<CONFIG_CIBYP_CONFIRM_GPIO,.mode=GPIO_MODE_INPUT,.pull_up_en=GPIO_PULLUP_ENABLE};
    if(gpio_config(&button)!=ESP_OK) abort();
#endif
    setvbuf(stdin,NULL,_IONBF,0); setvbuf(stdout,NULL,_IONBF,0);
    bool network=cibyp_network_start(storage_ready);
    printf("{\"ready\":true,\"protocol\":2,\"network\":%s}\n",network?"true":"false");
    size_t length=0; bool overflow=false;
    for(;;) {
        int ch=getchar();
        if(ch==EOF) {clearerr(stdin);vTaskDelay(pdMS_TO_TICKS(5));continue;}
        if(ch=='\n'||ch=='\r') {
            if(overflow) puts("{\"error\":\"FRAME_TOO_LARGE\"}");
            else if(length) {
                size_t n=(length==7 && memcmp(input,"NETWORK",7)==0)
                    ?cibyp_network_credentials(output,sizeof(output))
                    :cibyp_dispatch(input,length,output,sizeof(output));
                if(n) {fwrite(output,1,n,stdout);putchar('\n');}
            }
            clear_secret(input,sizeof(input));clear_secret(output,sizeof(output));length=0;overflow=false;
        } else if(!overflow) {if(length<sizeof(input)) input[length++]=(uint8_t)ch; else overflow=true;}
    }
}
