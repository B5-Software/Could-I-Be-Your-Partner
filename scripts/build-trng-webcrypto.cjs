/* SPDX-License-Identifier: GPL-3.0-or-later */
'use strict';
const fs=require('node:fs'),path=require('node:path');
function bundle(check=false) {
  const project=path.resolve(__dirname,'../IoT-Firmware/CIBYP-TRNG/web'),output=path.join(project,'question-seed.js');
  const bytes=require('esbuild').buildSync({entryPoints:[path.join(project,'question-seed-source.js')],bundle:true,platform:'browser',target:'es2022',format:'iife',minify:true,legalComments:'eof',write:false}).outputFiles[0].contents;
  if(check){if(!fs.existsSync(output)||!fs.readFileSync(output).equals(Buffer.from(bytes)))throw Error('TRNG_QUESTION_HASH_BUNDLE_STALE');}
  else fs.writeFileSync(output,bytes);
}
if(require.main===module)bundle(process.argv.includes('--check'));
module.exports={bundle};
