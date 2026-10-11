import assert from 'node:assert/strict';
import {chromium} from '@playwright/test';
import {waitForVisualReady,visualState} from '../helpers/desktop-screenshot.mjs';

const browser=await chromium.launch({channel:'msedge',headless:true});
try{
  const page=await browser.newPage();let releaseImage,requested;
  const imageGate=new Promise(resolve=>releaseImage=resolve),requestSeen=new Promise(resolve=>requested=resolve);
  await page.route('http://capture-fixture.invalid/portrait.png',async route=>{requested();await imageGate;await route.fulfill({contentType:'image/png',body:Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==','base64')});});
  await page.setContent('<div id="editor">editor</div><img width="16" height="16" id="portrait">');
  await page.evaluate(()=>{
    document.querySelector('#portrait').src='http://capture-fixture.invalid/portrait.png';
    globalThis.editorMotion=document.querySelector('#editor').animate([{opacity:.2},{opacity:1}],{duration:100000,fill:'both'});
    document.querySelector('#editor').animate([{color:'red'},{color:'blue'}],{duration:1000,iterations:Infinity});
  });
  await requestSeen;assert.equal((await visualState(page)).pendingImages,1);
  let settled=false;const stages=[];
  const ready=waitForVisualReady(page,stage=>stages.push(stage)).then(()=>{settled=true;});
  await page.waitForFunction(()=>document.fonts.status==='loaded');assert.equal(settled,false);
  releaseImage();await page.waitForFunction(()=>document.querySelector('#portrait').complete);
  assert.equal((await visualState(page)).finiteAnimations,1);assert.equal(settled,false);
  await page.evaluate(()=>globalThis.editorMotion.finish());await ready;
  assert.ok(stages.includes('images')&&stages.includes('animations')&&stages.includes('paint'));
  assert.deepEqual(await visualState(page),{visibility:'visible',fonts:'loaded',images:1,pendingImages:0,brokenImages:0,finiteAnimations:0});
  await page.route('http://capture-fixture.invalid/broken.png',route=>route.fulfill({status:404,body:''}));
  await page.evaluate(()=>document.querySelector('#portrait').src='http://capture-fixture.invalid/broken.png');
  await assert.rejects(waitForVisualReady(page),/cannot be decoded|EncodingError/);
  console.log('Desktop capture readiness passed: delayed portrait, finite editor motion, paint frames, infinite activity and broken-image rejection. No model calls.');
}finally{await browser.close();}
