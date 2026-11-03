/* SPDX-License-Identifier: GPL-3.0-or-later */
/* IDF transport only. All tarot commands and their permission boundary are Rust. */
#include "network.h"
#include <stdio.h>
#include <string.h>
#include "esp_event.h"
#include "esp_http_server.h"
#include "esp_netif.h"
#include "esp_random.h"
#include "esp_timer.h"
#include "esp_system.h"
#include "esp_wifi.h"
#include "esp_partition.h"
#include "tarot_art_digest.h"
#include "nvs.h"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"

#define FRAME_LIMIT 384
#define RESPONSE_LIMIT 8192
extern bool cibyp_rng(uint8_t *, size_t);
extern void cibyp_id(uint8_t *);
extern size_t cibyp_dispatch_network(const uint8_t *, size_t, uint8_t *, size_t, bool);
static const char *HOST = "192.168.4.1";
typedef struct { uint32_t version; char ssid[33], password[64], admin[33]; } settings_t;
static settings_t settings;
static SemaphoreHandle_t settings_lock;
static bool available, restart_required, setup_required=true;
static int64_t rate_window;
static unsigned rate_count;
static const char HEX[]="0123456789abcdef";
static const esp_partition_t *art_partition;
static uint8_t art_index[4096];
static uint16_t read_u16(const uint8_t *p) {return p[0]|((uint16_t)p[1]<<8);}
static uint32_t read_u32(const uint8_t *p) {return p[0]|((uint32_t)p[1]<<8)|((uint32_t)p[2]<<16)|((uint32_t)p[3]<<24);}
static bool art_start(void) {
    const esp_partition_t *part=esp_partition_find_first(ESP_PARTITION_TYPE_DATA,0x40,"tarot_art");
    uint8_t digest[32];
    if(!part || part->size!=0x1e0000 || esp_partition_get_sha256(part,digest)!=ESP_OK || memcmp(digest,CIBYP_TAROT_ART_SHA256,32)!=0) return false;
    if(esp_partition_read(part,0,art_index,sizeof(art_index))!=ESP_OK || memcmp(art_index,"CIBYPTA1",8)!=0 || read_u32(art_index+8)!=78 || read_u32(art_index+12)!=4096) return false;
    uint32_t previous=4096;
    for(size_t i=0;i<78;i++) {
        const uint8_t *entry=art_index+64+i*48;uint32_t offset=read_u32(entry+8),length=read_u32(entry+12);
        if(read_u16(entry)!=i || read_u16(entry+2)!=224 || read_u16(entry+4)!=336 || read_u16(entry+6)!=1 || offset<previous || length<16 || length>22400 || offset>part->size || length>part->size-offset) return false;
        previous=offset+length;
    }
    art_partition=part;return true;
}
bool cibyp_network_setup_required(void) {return setup_required;}
static void restart_after_setup(void *arg) {(void)arg;vTaskDelay(pdMS_TO_TICKS(3000));esp_restart();}
static void to_hex(char *out, const uint8_t *in, size_t length) {
    for(size_t i=0;i<length;i++) {out[i*2]=HEX[in[i]>>4];out[i*2+1]=HEX[in[i]&15];}
    out[length*2]=0;
}
static bool save_settings(const settings_t *next) {
    nvs_handle_t h;
    if(nvs_open("trng_net",NVS_READWRITE,&h)!=ESP_OK) return false;
    esp_err_t result=nvs_set_blob(h,"settings",next,sizeof(*next));
    if(result==ESP_OK) result=nvs_commit(h);
    nvs_close(h); return result==ESP_OK;
}
bool cibyp_configure_network(const uint8_t *ssid, size_t name_len, const uint8_t *password, size_t pass_len) {
    if(!available || !ssid || !password || !name_len || name_len>32 || pass_len<8 || pass_len>63) return false;
    if(xSemaphoreTake(settings_lock,pdMS_TO_TICKS(500))!=pdTRUE) return false;
    settings_t next=settings;
    memset(next.ssid,0,sizeof(next.ssid));memset(next.password,0,sizeof(next.password));
    memcpy(next.ssid,ssid,name_len);memcpy(next.password,password,pass_len);
    bool saved=save_settings(&next);
    if(saved) {settings=next;restart_required=true;}
    memset(&next,0,sizeof(next));xSemaphoreGive(settings_lock);return saved;
}
size_t cibyp_network_credentials(uint8_t *output, size_t capacity) {
    if(!available || xSemaphoreTake(settings_lock,pdMS_TO_TICKS(500))!=pdTRUE) {
        const char *error="{\"error\":\"NETWORK_UNAVAILABLE\"}";
        size_t len=strlen(error);if(capacity<len) return 0;memcpy(output,error,len);return len;
    }
    char name[65],password[127];to_hex(name,(uint8_t*)settings.ssid,strlen(settings.ssid));to_hex(password,(uint8_t*)settings.password,strlen(settings.password));
    int n=snprintf((char*)output,capacity,"{\"network\":true,\"url\":\"http://192.168.4.1\",\"ssidHex\":\"%s\",\"passwordHex\":\"%s\",\"adminToken\":\"%s\",\"restartRequired\":%s,\"setupRequired\":%s}",name,password,settings.admin,restart_required?"true":"false",setup_required?"true":"false");
    memset(password,0,sizeof(password));xSemaphoreGive(settings_lock);
    return n>0 && (size_t)n<capacity?(size_t)n:0;
}
static void wifi_event(void *arg, esp_event_base_t base, int32_t id, void *data) {
    (void)arg;(void)base;(void)data;
    if(id==WIFI_EVENT_AP_START) cibyp_entropy_rf(true);
    else if(id==WIFI_EVENT_AP_STOP) cibyp_entropy_rf(false);
}
static esp_err_t security_headers(httpd_req_t *req) {
    httpd_resp_set_hdr(req,"Cache-Control","no-store");
    httpd_resp_set_hdr(req,"X-Content-Type-Options","nosniff");
    httpd_resp_set_hdr(req,"Referrer-Policy","no-referrer");
    httpd_resp_set_hdr(req,"Content-Security-Policy","default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self' ws://192.168.4.1; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    return ESP_OK;
}
/* Bind the HTTP identity to the AP IP: DNS rebinding and cross-site WebSocket
   clients must not gain access just because their browser joined this AP. */
static bool same_origin(httpd_req_t *req) {
    char host[40],origin[64];
    if(httpd_req_get_hdr_value_str(req,"Host",host,sizeof(host))!=ESP_OK) return false;
    if(strcmp(host,HOST)!=0 && strcmp(host,"192.168.4.1:80")!=0) return false;
    size_t len=httpd_req_get_hdr_value_len(req,"Origin");
    if(!len) return true; /* Local REST clients need not supply Origin. */
    if(httpd_req_get_hdr_value_str(req,"Origin",origin,sizeof(origin))!=ESP_OK) return false;
    return strcmp(origin,"http://192.168.4.1")==0 || strcmp(origin,"http://192.168.4.1:80")==0;
}
static bool admin_authorized(httpd_req_t *req) {
    char token[80]={0};
    if(httpd_req_get_hdr_value_str(req,"Authorization",token,sizeof(token))!=ESP_OK || strlen(token)<15 || memcmp(token,"Bearer ",7)!=0) return false;
    if(xSemaphoreTake(settings_lock,pdMS_TO_TICKS(500))!=pdTRUE) return false;
    size_t len=strlen(token+7),pass_len=strlen(settings.password);
    volatile uint8_t diff=(len!=32),pass_diff=(len!=pass_len || pass_len<8);
    for(size_t i=0;i<32;i++) diff|=(uint8_t)(token[i+7]^settings.admin[i]);
    for(size_t i=0;i<63;i++) pass_diff|=(uint8_t)(token[i+7]^settings.password[i]);
    xSemaphoreGive(settings_lock);memset(token,0,sizeof(token));return diff==0 || pass_diff==0;
}
static bool rate_ok(void) {
    int64_t now=esp_timer_get_time();
    if(now-rate_window>=1000000) {rate_window=now;rate_count=0;}
    return ++rate_count<=12; /* One HTTP task; bounded global work per second. */
}
static esp_err_t json(httpd_req_t *req, const char *body, size_t length) {
    security_headers(req);httpd_resp_set_type(req,"application/json; charset=utf-8");
    return httpd_resp_send(req,body,length);
}
static esp_err_t denied(httpd_req_t *req, const char *status, const char *error) {
    httpd_resp_set_status(req,status);return json(req,error,strlen(error));
}
static esp_err_t command(httpd_req_t *req, const uint8_t *input, size_t len, bool admin) {
    uint8_t output[RESPONSE_LIMIT];
    size_t n=cibyp_dispatch_network(input,len,output,sizeof(output),admin);
    if(!n) return denied(req,"503 Service Unavailable","{\"error\":\"DEVICE_BUSY\"}");
    return json(req,(char*)output,n);
}
#define ASSET(name) extern const uint8_t name##_start[] asm("_binary_" #name "_start"); extern const uint8_t name##_end[] asm("_binary_" #name "_end")
ASSET(index_html);ASSET(app_css);ASSET(app_js);ASSET(catalog_json);ASSET(deck_json);ASSET(question_seed_js);
static esp_err_t asset(httpd_req_t *req) {
    if(!same_origin(req)) return denied(req,"403 Forbidden","{\"error\":\"ORIGIN_REJECTED\"}");
    const uint8_t *start=index_html_start,*end=index_html_end;const char *type="text/html; charset=utf-8";
    if(strcmp(req->uri,"/app.css")==0) {start=app_css_start;end=app_css_end;type="text/css; charset=utf-8";}
    else if(strcmp(req->uri,"/app.js")==0) {start=app_js_start;end=app_js_end;type="text/javascript; charset=utf-8";}
    else if(strcmp(req->uri,"/catalog.json")==0) {start=catalog_json_start;end=catalog_json_end;type="application/json; charset=utf-8";}
    else if(strcmp(req->uri,"/deck.json")==0) {start=deck_json_start;end=deck_json_end;type="application/json; charset=utf-8";}
    else if(strcmp(req->uri,"/question-seed.js")==0) {start=question_seed_js_start;end=question_seed_js_end;type="text/javascript; charset=utf-8";}
    security_headers(req);httpd_resp_set_type(req,type);return httpd_resp_send(req,(char*)start,end-start);
}
static esp_err_t card_asset(httpd_req_t *req) {
    if(!same_origin(req)) return denied(req,"403 Forbidden","{\"error\":\"ORIGIN_REJECTED\"}");
    if(!art_partition) return denied(req,"503 Service Unavailable","{\"error\":\"ARTWORK_UNAVAILABLE\"}");
    const char *query=strchr(req->uri,'?');size_t len=query?(size_t)(query-req->uri):strlen(req->uri);
    if(len!=14 || req->uri[7]<'0' || req->uri[7]>'7' || req->uri[8]<'0' || req->uri[8]>'9' || memcmp(req->uri+9,".webp",5)!=0) return denied(req,"404 Not Found","{\"error\":\"CARD_NOT_FOUND\"}");
    unsigned id=(req->uri[7]-'0')*10+req->uri[8]-'0';
    if(id>=78) return denied(req,"404 Not Found","{\"error\":\"CARD_NOT_FOUND\"}");
    const uint8_t *entry=art_index+64+id*48;uint32_t offset=read_u32(entry+8),length=read_u32(entry+12);
    security_headers(req);httpd_resp_set_type(req,"image/webp");httpd_resp_set_hdr(req,"Cache-Control","private, max-age=86400, immutable");
    uint8_t chunk[1024];
    while(length) {
        size_t n=length>sizeof(chunk)?sizeof(chunk):length;
        if(esp_partition_read(art_partition,offset,chunk,n)!=ESP_OK || httpd_resp_send_chunk(req,(char*)chunk,n)!=ESP_OK) return ESP_FAIL;
        offset+=n;length-=n;
    }
    return httpd_resp_send_chunk(req,NULL,0);
}
static esp_err_t rest(httpd_req_t *req) {
    if(!same_origin(req)) return denied(req,"403 Forbidden","{\"error\":\"ORIGIN_REJECTED\"}");
    if(!rate_ok()) return denied(req,"429 Too Many Requests","{\"error\":\"RATE_LIMIT\"}");
    if(strncmp(req->uri,"/api/config",11)==0) {
        bool first=setup_required;
        if(first && restart_required) return denied(req,"409 Conflict","{\"error\":\"RESTART_REQUIRED\"}");
        char setup[4];
        bool setup_request=first && req->method==HTTP_POST && httpd_req_get_hdr_value_str(req,"X-CIBYP-Setup",setup,sizeof(setup))==ESP_OK && strcmp(setup,"1")==0;
        if(!setup_request && !admin_authorized(req)) return denied(req,"401 Unauthorized","{\"error\":\"ADMIN_REQUIRED\"}");
        if(req->method==HTTP_GET) {
            char name[65],body[160];
            if(xSemaphoreTake(settings_lock,pdMS_TO_TICKS(500))!=pdTRUE) return ESP_FAIL;
            to_hex(name,(uint8_t*)settings.ssid,strlen(settings.ssid));
            snprintf(body,sizeof(body),"{\"ssidHex\":\"%s\",\"hasPassword\":true,\"restartRequired\":%s}",name,restart_required?"true":"false");
            xSemaphoreGive(settings_lock);return json(req,body,strlen(body));
        }
        if(req->content_len<1 || req->content_len>FRAME_LIMIT) return denied(req,"413 Content Too Large","{\"error\":\"FRAME_TOO_LARGE\"}");
        uint8_t input[FRAME_LIMIT];size_t received=0;
        while(received<req->content_len) {int n=httpd_req_recv(req,(char*)input+received,req->content_len-received);if(n<=0) return ESP_FAIL;received+=n;}
        /* A valid admin token cannot turn the configuration endpoint into a
           generic device/entropy proxy. The Rust boundary repeats this check. */
        if(received<7 || memcmp(input,"NETCFG ",7)!=0) return denied(req,"400 Bad Request","{\"error\":\"NETWORK_CONFIG_FORMAT\"}");
        restart_required=false;
        esp_err_t result=command(req,input,received,true);memset(input,0,sizeof(input));
        if(first && restart_required) { /* Still gate draws until reboot switches to WPA2. */
            if(xTaskCreate(restart_after_setup,"setup-restart",2048,NULL,3,NULL)!=pdPASS) return ESP_FAIL;
        }
        return result;
    }
    if(strncmp(req->uri,"/api/spread",11)==0) {
        if(req->method==HTTP_POST) {
            if(req->content_len<1 || req->content_len>FRAME_LIMIT) return denied(req,"413 Content Too Large","{\"error\":\"FRAME_TOO_LARGE\"}");
            uint8_t input[FRAME_LIMIT];size_t received=0;
            while(received<req->content_len){int n=httpd_req_recv(req,(char*)input+received,req->content_len-received);if(n<=0)return ESP_FAIL;received+=n;}
            if(received<8 || memcmp(input,"SPREAD2 ",8)!=0) return denied(req,"400 Bad Request","{\"error\":\"QUESTION_FORMAT\"}");
            esp_err_t result=command(req,input,received,false);memset(input,0,sizeof(input));return result;
        }
        char query[64],type[40]="single",input[48];
        if(httpd_req_get_url_query_len(req)>0) {
            if(httpd_req_get_url_query_str(req,query,sizeof(query))!=ESP_OK || httpd_query_key_value(query,"type",type,sizeof(type))!=ESP_OK)
                return denied(req,"400 Bad Request","{\"error\":\"UNKNOWN_SPREAD\"}");
        }
        int n=snprintf(input,sizeof(input),"SPREAD:%s",type);return command(req,(uint8_t*)input,n,false);
    }
    const char *cmd=strncmp(req->uri,"/api/draw",9)==0?"DRAW":strncmp(req->uri,"/api/random",11)==0?"RANDOM":"INFO";
    return command(req,(uint8_t*)cmd,strlen(cmd),false);
}
static esp_err_t ws_pre_handshake(httpd_req_t *req) {
    if(!same_origin(req)) {denied(req,"403 Forbidden","{\"error\":\"ORIGIN_REJECTED\"}");return ESP_FAIL;}
    return ESP_OK;
}
static esp_err_t websocket(httpd_req_t *req) {
    if(req->method==HTTP_GET) return ESP_OK;
    uint8_t input[FRAME_LIMIT],output[RESPONSE_LIMIT];
    httpd_ws_frame_t frame={0};
    if(httpd_ws_recv_frame(req,&frame,0)!=ESP_OK) return ESP_FAIL;
    /* Reject fragmented/binary/oversize before allocating or reading payload. */
    if(!frame.final || frame.type!=HTTPD_WS_TYPE_TEXT || !frame.len || frame.len>sizeof(input)) return ESP_FAIL;
    frame.payload=input;
    if(httpd_ws_recv_frame(req,&frame,sizeof(input))!=ESP_OK) return ESP_FAIL;
    const char *limit="{\"error\":\"RATE_LIMIT\"}",*busy="{\"error\":\"DEVICE_BUSY\"}";
    size_t n=0;
    if(rate_ok()) n=cibyp_dispatch_network(input,frame.len,output,sizeof(output),false);
    else {n=strlen(limit);memcpy(output,limit,n);}
    if(!n) {n=strlen(busy);memcpy(output,busy,n);}
    httpd_ws_frame_t response={.type=HTTPD_WS_TYPE_TEXT,.payload=output,.len=n};
    return httpd_ws_send_frame(req,&response);
}
bool cibyp_network_start(bool storage_ready) {
    if(!storage_ready) return false;
    settings_lock=xSemaphoreCreateMutex();if(!settings_lock) return false;
    nvs_handle_t h;size_t size=sizeof(settings);esp_err_t loaded=nvs_open("trng_net",NVS_READONLY,&h);
    if(loaded==ESP_OK) {loaded=nvs_get_blob(h,"settings",&settings,&size);nvs_close(h);}
    if(loaded==ESP_ERR_NVS_NOT_FOUND) {
        uint8_t random[32],id[6];if(!cibyp_rng(random,sizeof(random))) return false;cibyp_id(id);
        memset(&settings,0,sizeof(settings));settings.version=1;
        snprintf(settings.ssid,sizeof(settings.ssid),"CIBYP-Tarot-%02x%02x%02x",id[3],id[4],id[5]);
        to_hex(settings.password,random,16);to_hex(settings.admin,random+16,16);memset(random,0,sizeof(random));
        settings.password[0]=0; /* First use is an open, configuration-only AP. */
    } else if(loaded!=ESP_OK || size!=sizeof(settings) || settings.version!=1 ||
        strnlen(settings.ssid,sizeof(settings.ssid))>32 || !settings.ssid[0] ||
        strnlen(settings.password,sizeof(settings.password))<8 || strnlen(settings.password,sizeof(settings.password))>63 ||
        strnlen(settings.admin,sizeof(settings.admin))!=32) return false;
    if(esp_netif_init()!=ESP_OK || esp_event_loop_create_default()!=ESP_OK || !esp_netif_create_default_wifi_ap()) return false;
    cibyp_entropy_rf(false); /* Disable SAR before any RF initialization. */
    wifi_init_config_t init=WIFI_INIT_CONFIG_DEFAULT();
    if(esp_wifi_init(&init)!=ESP_OK || esp_wifi_set_storage(WIFI_STORAGE_RAM)!=ESP_OK) return false;
    if(esp_event_handler_register(WIFI_EVENT,ESP_EVENT_ANY_ID,&wifi_event,NULL)!=ESP_OK) return false;
    wifi_config_t ap={0};memcpy(ap.ap.ssid,settings.ssid,strlen(settings.ssid));ap.ap.ssid_len=strlen(settings.ssid);
    setup_required=settings.password[0]==0;
    memcpy(ap.ap.password,settings.password,strlen(settings.password));ap.ap.channel=1;ap.ap.max_connection=setup_required?1:4;
    ap.ap.authmode=setup_required?WIFI_AUTH_OPEN:WIFI_AUTH_WPA2_PSK;ap.ap.pmf_cfg.capable=true;
    if(esp_wifi_set_mode(WIFI_MODE_AP)!=ESP_OK || esp_wifi_set_config(WIFI_IF_AP,&ap)!=ESP_OK || esp_wifi_start()!=ESP_OK || esp_wifi_set_ps(WIFI_PS_NONE)!=ESP_OK) return false;
    memset(&ap,0,sizeof(ap));
    (void)art_start(); /* Invalid or mismatched art is never served. Setup/USB repair remains available. */
    httpd_config_t config=HTTPD_DEFAULT_CONFIG();config.stack_size=16384;config.max_uri_handlers=16;config.max_open_sockets=4;config.uri_match_fn=httpd_uri_match_wildcard;
    config.lru_purge_enable=true;config.recv_wait_timeout=3;config.send_wait_timeout=3;
    httpd_handle_t server;
    if(httpd_start(&server,&config)!=ESP_OK) return false;
    const char *assets[]={"/","/app.css","/app.js","/catalog.json","/deck.json","/question-seed.js"};
    for(size_t i=0;i<6;i++) {httpd_uri_t route={.uri=assets[i],.method=HTTP_GET,.handler=asset};if(httpd_register_uri_handler(server,&route)!=ESP_OK) goto failed;}
    httpd_uri_t pictures={.uri="/cards/*",.method=HTTP_GET,.handler=card_asset};
    if(httpd_register_uri_handler(server,&pictures)!=ESP_OK) goto failed;
    const char *apis[]={"/api/draw","/api/spread","/api/random","/api/info","/api/config"};
    for(size_t i=0;i<5;i++) {httpd_uri_t route={.uri=apis[i],.method=HTTP_GET,.handler=rest};if(httpd_register_uri_handler(server,&route)!=ESP_OK) goto failed;}
    httpd_uri_t cfg={.uri="/api/config",.method=HTTP_POST,.handler=rest};
    httpd_uri_t spread_post={.uri="/api/spread",.method=HTTP_POST,.handler=rest};
    httpd_uri_t ws={.uri="/ws",.method=HTTP_GET,.handler=websocket,.is_websocket=true,.ws_pre_handshake_cb=ws_pre_handshake};
    if(httpd_register_uri_handler(server,&cfg)!=ESP_OK || httpd_register_uri_handler(server,&spread_post)!=ESP_OK || httpd_register_uri_handler(server,&ws)!=ESP_OK) goto failed;
    available=true;return true;
failed:
    httpd_stop(server);return false;
}
