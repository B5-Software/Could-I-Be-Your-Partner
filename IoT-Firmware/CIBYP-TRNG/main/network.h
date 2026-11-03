/* SPDX-License-Identifier: GPL-3.0-or-later */
#pragma once
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
bool cibyp_network_start(bool storage_ready);
size_t cibyp_network_credentials(uint8_t *output, size_t capacity);
bool cibyp_configure_network(const uint8_t *ssid, size_t ssid_len, const uint8_t *password, size_t password_len);
void cibyp_entropy_rf(bool enabled);
