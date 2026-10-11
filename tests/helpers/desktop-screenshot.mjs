import {writeFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';

export async function visualState(page){
  return page.evaluate(()=>{
    const visible=node=>node?.getClientRects().length&&getComputedStyle(node).visibility!=='hidden';
    const images=[...document.images].filter(visible);
    const moving=document.getAnimations().filter(a=>visible(a.effect?.target)&&Number.isFinite(a.effect?.getComputedTiming().endTime)&&(a.pending||a.playState==='running'));
    return {visibility:document.visibilityState,fonts:document.fonts.status,images:images.length,pendingImages:images.filter(i=>!i.complete).length,brokenImages:images.filter(i=>i.complete&&!i.naturalWidth).length,finiteAnimations:moving.length};
  });
}

/** Wait for actual resources and paint opportunities, without sleeps, capture retries or disabling motion. */
export async function waitForVisualReady(page,stage=()=>{}){
  stage('visible');await page.waitForFunction(()=>document.visibilityState==='visible',null,{timeout:10000,polling:50});
  stage('fonts');await page.waitForFunction(()=>document.fonts.status==='loaded',null,{timeout:10000,polling:50});
  stage('images');await page.waitForFunction(()=>[...document.images].filter(i=>i.getClientRects().length&&getComputedStyle(i).visibility!=='hidden').every(i=>i.complete),null,{timeout:10000,polling:50});
  await page.evaluate(()=>Promise.all([...document.images].filter(i=>i.getClientRects().length&&getComputedStyle(i).visibility!=='hidden').map(i=>i.decode())));
  stage('animations');await page.waitForFunction(()=>document.getAnimations().every(a=>!a.effect?.target?.getClientRects().length||getComputedStyle(a.effect.target).visibility==='hidden'||!Number.isFinite(a.effect.getComputedTiming().endTime)||(!a.pending&&a.playState!=='running')),null,{timeout:10000,polling:50});
  stage('paint');const key='__airoomPaint_'+randomUUID();
  try{await page.waitForFunction(key=>{globalThis[key]=(globalThis[key]??0)+1;return globalThis[key]>=3;},key,{timeout:10000,polling:'raf'});}
  finally{await page.evaluate(key=>delete globalThis[key],key);}
}

export async function desktopScreenshot(application,page,file){
  let stage='window';const window=await application.browserWindow(page);
  const windowState=()=>window.evaluate(w=>({visible:w.isVisible(),minimized:w.isMinimized(),focused:w.isFocused(),bounds:w.getBounds()}));
  const before={window:await windowState(),page:await visualState(page)};
  try{
    await window.evaluate(w=>{if(w.isMinimized())w.restore();w.show();w.focus();});
    await page.bringToFront();
    await waitForVisualReady(page,value=>{stage=value;});
    const ready={window:await windowState(),page:await visualState(page)};
    stage='capture';await page.screenshot({path:file,fullPage:true});
    await writeFile(file+'.ready.json',JSON.stringify({before,ready},null,2));
    console.log('Desktop screenshot ready:',JSON.stringify({file,condition:ready.page}));
  }catch(error){
    const diagnostic={stage,before,window:await windowState().catch(()=>null),page:await visualState(page).catch(()=>null),error:error.message};
    await writeFile(file+'.failure.json',JSON.stringify(diagnostic,null,2));
    console.error('Desktop screenshot diagnostics:',JSON.stringify(diagnostic));
    throw new Error(`Desktop screenshot failed during ${stage}: ${error.message}`,{cause:error});
  }
}
