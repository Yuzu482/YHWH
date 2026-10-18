import test from 'node:test';
import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';
import {inspectCheckCoverage} from '../scripts/check-coverage.mjs';
test('real browser: hidden pane bounds are unknown; visible short-screen artwork and controls stay contained',
 {skip:!process.env.YHWH_TEST_PLAYWRIGHT_MODULE,timeout:30000},async()=>{
 const {chromium}=await import(pathToFileURL(process.env.YHWH_TEST_PLAYWRIGHT_MODULE).href);
 const browser=await chromium.launch({channel:'msedge',headless:true,args:['--disable-background-networking']});
 try{for(const [width,height]of [[1280,900],[390,900],[320,900],[390,400]]){
  const page=await browser.newPage({viewport:{width,height}});try{
   await page.route('**/*',r=>r.abort());
   await page.setContent(`<style>*{box-sizing:border-box}#pane{display:none}dialog{margin:auto;padding:12px;max-width:calc(100vw - 24px);max-height:calc(100vh - 24px)}dialog[open]{display:flex;flex-direction:column;gap:8px}#art{width:min(240px,calc((100vh - 100px)*33/53),calc(100vw - 72px));aspect-ratio:33/53;background:teal}button{height:24px;flex-shrink:0}</style><section id="pane"><div id="preview" style="width:33px;height:53px"></div></section><dialog><button>Close</button><div id="art"></div></dialog>`);
   assert.equal(await page.locator('#preview').boundingBox(),null);
   await page.locator('#pane').evaluate(e=>e.style.display='block');await page.locator('#preview').waitFor({state:'visible'});assert.ok(await page.locator('#preview').boundingBox());
   await page.locator('dialog').evaluate(e=>e.showModal());const dialog=await page.locator('dialog').boundingBox(),art=await page.locator('#art').boundingBox(),button=await page.locator('button').boundingBox();assert.ok(dialog&&art&&button);assert.ok(Math.abs(art.width/art.height-33/53)<0.002);
   for(const b of [art,button])assert.ok(b.x>=dialog.x&&b.y>=dialog.y&&b.x+b.width<=dialog.x+dialog.width&&b.y+b.height<=dialog.y+dialog.height&&b.x>=0&&b.y>=0&&b.x+b.width<=width&&b.y+b.height<=height);
   const coverage=inspectCheckCoverage(['style.css'],[{id:'presentation'}]);assert.deepEqual(coverage.uncovered,['style.css']);assert.equal(coverage.executionProven,false);
  }finally{await page.close();}
 }}finally{await browser.close();}
});
