/* SPDX-License-Identifier: GPL-3.0-or-later */
// Bundled locally: works on an ESP32's plain-HTTP AP without WebCrypto.subtle.
import {sha256} from '@noble/hashes/sha2.js';
import {bytesToHex} from '@noble/hashes/utils.js';
globalThis.CibypTarotQuestionDigest=(question)=>{
  if(typeof question!=='string'||!question.trim()||question.length>200)throw Error('QUESTION_FORMAT');
  const nonce=new Uint8Array(32);globalThis.crypto.getRandomValues(nonce);
  const hash=sha256.create().update(new TextEncoder().encode('CIBYP-TAROT/2/browser-question\n')).update(nonce).update(new TextEncoder().encode(question.normalize('NFC'))).digest();
  const digest=bytesToHex(hash);nonce.fill(0);hash.fill(0);return digest;
};
