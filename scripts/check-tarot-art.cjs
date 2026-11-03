/* SPDX-License-Identifier: GPL-3.0-or-later */
'use strict';
const fs=require('node:fs'),path=require('node:path'),{createHash}=require('node:crypto');
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
function verify(root=path.resolve(__dirname,'..')) {
  const cards=require(path.join(root,'src/data/tarot')),base=path.join(root,'artwork/tarot');
  const manifest=JSON.parse(fs.readFileSync(path.join(base,'manifest.json'),'utf8'));
  if(!manifest.complete||manifest.version!==1||manifest.images.length!==78)throw Error('TAROT_ART_INCOMPLETE');
  if(new Set(manifest.images.map(image=>image.sourceSha256)).size!==78||new Set(manifest.images.map(image=>image.firmware.sha256)).size!==78)throw Error('TAROT_DUPLICATE_ARTWORK');
  const archive=fs.readFileSync(path.join(root,'assets/trng-firmware/tarot-art.bin'));
  if(archive.length!==0x1e0000||hash(archive)!==manifest.archive.sha256||archive.toString('ascii',0,8)!=='CIBYPTA1'||archive.readUInt32LE(8)!==78||archive.readUInt32LE(12)!==4096)throw Error('TAROT_ARCHIVE_INVALID');
  if(hash(archive.subarray(64,64+78*48))!==archive.subarray(16,48).toString('hex'))throw Error('TAROT_INDEX_INVALID');
  const header=fs.readFileSync(path.join(root,'IoT-Firmware/CIBYP-TRNG/main/tarot_art_digest.h'),'utf8');
  const expected=Array.from(Buffer.from(manifest.archive.sha256,'hex')).map(v=>'0x'+v.toString(16).padStart(2,'0')).join(',');
  if(!header.includes('{'+expected+'}'))throw Error('TAROT_FIRMWARE_DIGEST_STALE');
  const paths=[path.join(root,'src/renderer/assets/tarot'),path.join(root,'IoT-Firmware/CIBYP-TRNG/web/cards')];
  const seen=new Set();let previous=4096;
  for(const [i,image]of manifest.images.entries()) {
    if(image.id!==i||seen.has(image.id)||image.name!==cards[i].name||image.nameEn!==cards[i].nameEn||image.file!==String(i).padStart(2,'0')+'.webp')throw Error('TAROT_CARD_ID_MISMATCH');seen.add(i);
    for(const [variant,folder]of[['desktop',paths[0]],['firmware',paths[1]]]) {
      const bytes=fs.readFileSync(path.join(folder,image.file));
      if(bytes.length!==image[variant].bytes||hash(bytes)!==image[variant].sha256||bytes.toString('ascii',0,4)!=='RIFF'||bytes.toString('ascii',8,12)!=='WEBP')throw Error('TAROT_CARD_HASH_MISMATCH: '+i);
    }
    const pos=64+i*48,offset=archive.readUInt32LE(pos+8),length=archive.readUInt32LE(pos+12);
    if(archive.readUInt16LE(pos)!==i||archive.readUInt16LE(pos+2)!==224||archive.readUInt16LE(pos+4)!==336||archive.readUInt16LE(pos+6)!==1||offset<previous||length<16||length>22400||offset+length>archive.length||hash(archive.subarray(offset,offset+length))!==image.firmware.sha256||archive.subarray(pos+16,pos+48).toString('hex')!==image.firmware.sha256)throw Error('TAROT_CARD_ARCHIVE_MISMATCH: '+i);
    previous=offset+length;
  }
  const deck=JSON.parse(fs.readFileSync(path.join(root,'IoT-Firmware/CIBYP-TRNG/web/deck.json'),'utf8'));
  if(!deck.complete||deck.deckId!==manifest.deckId||deck.images.length!==78||deck.images.some((entry,i)=>entry.id!==i||entry.file!==manifest.images[i].file||entry.sha256!==manifest.images[i].firmware.sha256))throw Error('TAROT_WEB_MANIFEST_STALE');
  return {images:78,bytes:archive.length,usedBytes:manifest.archive.usedBytes,sha256:manifest.archive.sha256};
}
if(require.main===module)try{console.log(JSON.stringify(verify()));}catch(error){console.error(error.message);process.exitCode=1;}
module.exports={verify};
