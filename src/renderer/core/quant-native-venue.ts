/* SPDX-License-Identifier: GPL-3.0-or-later */
import catalog from '../../shared/quant-native-venues.json';
import labels from '../../shared/quant-source-labels.json';
import type { QuantNativeSource } from '../../shared/quant-types';

export const nativeVenueLabel = (key?: string): string =>
  catalog.venues.find(({ id }) => id === (key || 'coinbase'))?.label || '';

export const nativeSourceMatches = (source: QuantNativeSource, product: string, venue: string) =>
  source.product === product && (source.venue || 'coinbase') === venue;

export function nativeVenueOptions(selected = 'coinbase'): string {
  return catalog.venues
    .map(
      ({ id, label }) =>
        `<option value="${id}"${id === selected ? ' selected' : ''}>${label}</option>`,
    )
    .join('');
}

export function nativeSourceLanguage(language: string) {
  return labels[language.startsWith('de') ? 'de' : language.startsWith('en') ? 'en' : 'zh'];
}
