import {chromium} from '@playwright/test';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
// Keep the owner's selected artwork as the canonical source; derive every size from it.
const source=(await readFile(new URL('../build/airoom-source.png',import.meta.url))).toString('base64');
const browser=await chromium.launch({channel:'msedge',headless:true});
try{
  const page=await browser.newPage();
  const frames=[];
  for(const size of [16,24,32,48,64,128,256]){
    const png=Buffer.from(await page.evaluate(async({source,size})=>{
      const image=new Image();image.src='data:image/png;base64,'+source;await image.decode();
      const canvas=document.createElement('canvas');canvas.width=canvas.height=size;const context=canvas.getContext('2d');context.imageSmoothingQuality='high';
      // Encode a precise circular alpha boundary at every Windows icon size.
      context.beginPath();context.arc(size/2,size/2,size*0.48,0,Math.PI*2);context.clip();context.drawImage(image,0,0,size,size);
      const pixels=context.getImageData(0,0,size,size).data;
      for(const [x,y] of [[0,0],[size-1,0],[0,size-1],[size-1,size-1]])if(pixels[(y*size+x)*4+3]!==0)throw new Error('Circular icon corners must be transparent.');
      return Array.from(new Uint8Array(await (await new Promise(resolve=>canvas.toBlob(resolve,'image/png'))).arrayBuffer()));
    },{source,size}));
    frames.push({size,png});
  }
  const header=Buffer.alloc(6+frames.length*16);header.writeUInt16LE(1,2);header.writeUInt16LE(frames.length,4);
  let offset=header.length;
  frames.forEach(({size,png},i)=>{const p=6+i*16;header[p]=header[p+1]=size===256?0:size;header.writeUInt16LE(1,p+4);header.writeUInt16LE(32,p+6);header.writeUInt32LE(png.length,p+8);header.writeUInt32LE(offset,p+12);offset+=png.length;});
  await mkdir(new URL('../build/',import.meta.url),{recursive:true});
  await writeFile(new URL('../build/airoom.ico',import.meta.url),Buffer.concat([header,...frames.map(frame=>frame.png)]));
  await writeFile(new URL('../build/airoom.png',import.meta.url),frames.at(-1).png);
  console.log('AIROOM icon generated at 16–256 pixels.');
}finally{await browser.close();}
