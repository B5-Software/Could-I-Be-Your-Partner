/* SPDX-License-Identifier: GPL-3.0-or-later */
'use strict';
const fs=require('node:fs'),path=require('node:path');
const {FirmwareService,readImage}=require('../src/main/services/firmware');
function verify(root=path.resolve(__dirname,'..')) {
  const artwork=require('./check-tarot-art.cjs').verify(root);
  require('./build-trng-webcrypto.cjs').bundle(true);
  const directory=path.join(root,'assets/trng-firmware'),service=new FirmwareService({directory});
  const source=require('./build-trng-firmware.cjs').sources(),manifest=service.manifest();
  const expected=['esp32c3-uart','esp32c3-usb','esp32c6-uart','esp32c6-usb','esp32s31-uart','esp32s31-usb'];
  if(manifest.images.length!==expected.length||expected.some(id=>!manifest.images.some(image=>image.id===id)))throw Error('TRNG_BUNDLED_IMAGES_INCOMPLETE');
  let bytes=0;
  for(const image of manifest.images) {
    if(image.sourceSha256!==source||image.rust!=='1.99.1'||image.idf?.tag!=='v6.1'||image.idf.revision!=='fff9895c82d744c7237be8847347bdd1b07c6643')throw Error('TRNG_BUNDLED_IMAGE_STALE: '+image.id);
    const art=image.segments.filter(segment=>segment.file.endsWith('/tarot-art.bin'));
    if(art.length!==1||art[0].address!==0x220000||art[0].size!==0x1e0000||art[0].sha256!==artwork.sha256)throw Error('TRNG_ARTWORK_SEGMENT_INVALID: '+image.id);
    const app=image.segments.find(segment=>segment.file.endsWith('/cibyp_trng.bin'));
    if(!app||app.address!==0x20000||app.size>0x100000)throw Error('TRNG_APPLICATION_SLOT_INVALID: '+image.id);
    bytes+=readImage(directory,image).reduce((sum,file)=>sum+file.data.length,0);
    if(!fs.existsSync(path.join(directory,image.id,'cibyp_trng.bin')))throw Error('TRNG_APPLICATION_MISSING');
  }
  return{images:manifest.images.length,bytes,protocol:manifest.protocol,sourceSha256:source};
}
if(require.main===module)try{console.log(JSON.stringify(verify()));}catch(error){console.error(error.message);process.exitCode=1;}
module.exports={verify};
