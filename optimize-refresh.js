#!/usr/bin/env node
'use strict';

/*
  Safe refresh-data.js performance optimizer for WorldSquashMasters2026.

  What it changes:
  - Keeps the existing fresh-page-per-venue behaviour.
  - Keeps every existing venue/date verification.
  - Keeps the exact same parseCurrentState() logic and parses venue pages serially.
  - Only overlaps the NETWORK/RENDER preparation of Mirrabooka, Belmont and
    Karrinyup venue pages (up to 3 at once).

  This avoids the shared-parser-state race that would happen if three venue
  pages were parsed concurrently, while still removing most of the serial wait.

  Usage:
      node optimize-refresh.js

  Optional runtime tuning after patching:
      MATCH_VENUE_WORKERS=1   # conservative
      MATCH_VENUE_WORKERS=2
      MATCH_VENUE_WORKERS=3   # default / fastest
*/

const fs = require('fs');
const path = require('path');
const cp = require('child_process');

const dir = process.cwd();
const target = path.join(dir, 'refresh-data.js');
const backup = path.join(dir, 'refresh-data.before-optimization.js');

if (!fs.existsSync(target)) {
  console.error('Could not find refresh-data.js in the current folder.');
  console.error('Run this script from the WorldSquashMasters2026 repository root.');
  process.exit(1);
}

let src = fs.readFileSync(target, 'utf8');
const original = src;

function mustContain(text, label) {
  if (!src.includes(text)) {
    throw new Error(`Current refresh-data.js does not match the expected version (${label}). No changes were written.`);
  }
}

function replaceOnce(oldText, newText, label) {
  const first = src.indexOf(oldText);
  if (first < 0) {
    throw new Error(`Could not find expected code for ${label}. No changes were written.`);
  }
  if (src.indexOf(oldText, first + oldText.length) >= 0) {
    throw new Error(`Expected code for ${label} occurs more than once. Refusing an ambiguous patch.`);
  }
  src = src.slice(0, first) + newText + src.slice(first + oldText.length);
}

try {
  mustContain('async function scrapeOfficialMatchesSchedule(context,canonicalPlayers,previousMatches=[])', 'Matches schedule crawler');
  mustContain('// Then revisit the date from a clean page for each venue. Venue metadata', 'venue crawl loop');
  mustContain('Official TournamentSoftware Matches schedule:', 'Matches diagnostics');

  // 1) Allow the existing body parser to read from an explicitly supplied page.
  replaceOnce(
`  async function bodyText(){
    for(const frame of page.frames()){
      try{
        const txt=await frame.locator('body').innerText();
        if(/\\bMatch schedule\\b/i.test(txt)&&/\\bH2H\\b/i.test(txt))return txt;
      }catch{}
    }
    try{return await page.locator('body').innerText()}catch{return ''}
  }`,
`  async function bodyText(targetPage=page){
    for(const frame of targetPage.frames()){
      try{
        const txt=await frame.locator('body').innerText();
        if(/\\bMatch schedule\\b/i.test(txt)&&/\\bH2H\\b/i.test(txt))return txt;
      }catch{}
    }
    try{return await targetPage.locator('body').innerText()}catch{return ''}
  }`,
    'page-aware bodyText()'
  );

  // 2) Keep parser logic identical, but let it parse one of the preloaded venue pages.
  replaceOnce(
`  async function parseCurrentState(forcedVenue=''){
    const pendingStart=pendingOnePlayerFragments.length;
    const body=String(await bodyText())`,
`  async function parseCurrentState(forcedVenue='',targetPage=page){
    const pendingStart=pendingOnePlayerFragments.length;
    const body=String(await bodyText(targetPage))`,
    'page-aware parseCurrentState()'
  );

  // 3) Page-aware H2H/date helpers.
  replaceOnce(
`  async function currentH2HCount(){
    const txt=clean(await bodyText());
    return (txt.match(/\\bH2H\\b/gi)||[]).length;
  }
  async function currentScheduleDate(){
    const txt=clean(await bodyText());`,
`  async function currentH2HCount(targetPage=page){
    const txt=clean(await bodyText(targetPage));
    return (txt.match(/\\bH2H\\b/gi)||[]).length;
  }
  async function currentScheduleDate(targetPage=page){
    const txt=clean(await bodyText(targetPage));`,
    'page-aware date/H2H helpers'
  );

  // 4) Make clickDateTab accept a page. The existing default keeps every old call working.
  replaceOnce(
`  async function clickDateTab(text){
    const before=await currentScheduleDate();
    const clicked=await clickExactText(text);`,
`  async function clickDateTab(text,targetPage=page){
    const before=await currentScheduleDate(targetPage);
    const clicked=await clickExactText(text,targetPage);`,
    'page-aware clickDateTab() header'
  );
  replaceOnce(
`      const after=await currentScheduleDate();
      if(after&&after!==before)return true;
    }

    return true;
  }
  async function selectVenue(venue){`,
`      const after=await currentScheduleDate(targetPage);
      if(after&&after!==before)return true;
    }

    return true;
  }
  async function selectVenue(venue,targetPage=page){`,
    'page-aware clickDateTab() tail / selectVenue() header'
  );

  // 5) Rewrite only the selectVenue function body so all old behaviour is retained
  //    but it can act on a venue worker page.
  {
    const startMarker = '  async function selectVenue(venue,targetPage=page){';
    const endMarker = '\n  }\n\n  try{';
    const start = src.indexOf(startMarker);
    const end = src.indexOf(endMarker, start);
    if (start < 0 || end < 0) throw new Error('Could not isolate selectVenue().');
    let block = src.slice(start, end + '\n  }'.length);
    block = block
      .replace(/page\.frames\(\)/g, 'targetPage.frames()')
      .replace(/clickExactText\(triggerText\)/g, 'clickExactText(triggerText,targetPage)')
      .replace(/clickExactText\(venue\)/g, 'clickExactText(venue,targetPage)');
    src = src.slice(0, start) + block + src.slice(end + '\n  }'.length);
  }

  // 6) Make clickExactText page-aware. Scope the edit to that function only.
  {
    const startMarker = '  async function clickExactText(text){';
    const endMarker = '\n  }\n  async function tabLabels(){';
    const start = src.indexOf(startMarker);
    const end = src.indexOf(endMarker, start);
    if (start < 0 || end < 0) throw new Error('Could not isolate clickExactText().');
    let block = src.slice(start, end + '\n  }'.length);
    block = block
      .replace('async function clickExactText(text){', 'async function clickExactText(text,targetPage=page){')
      .replace(/page\.frames\(\)/g, 'targetPage.frames()');
    src = src.slice(0, start) + block + src.slice(end + '\n  }'.length);
  }

  // 7) Make the venue/date verification closures page-aware for the preparation phase.
  replaceOnce(
`    const currentVenueText=async()=>{
      const txt=clean(await bodyText());`,
`    const currentVenueText=async(targetPage=page)=>{
      const txt=clean(await bodyText(targetPage));`,
    'page-aware currentVenueText()'
  );
  replaceOnce(
`    const waitForDate=async(expectedIso)=>{
      for(let i=0;i<14;i++){
        const current=await currentScheduleDate();`,
`    const waitForDate=async(expectedIso,targetPage=page)=>{
      for(let i=0;i<14;i++){
        const current=await currentScheduleDate(targetPage);`,
    'page-aware waitForDate()'
  );

  // 8) Replace ONLY the venue portion of each date crawl.
  //    Three fresh venue pages are navigated/selected in parallel, but their
  //    parsed match text is fed through parseCurrentState() one at a time and in
  //    the same Mirrabooka -> Belmont -> Karrinyup order as before.
  {
    const startMarker = '      // Then revisit the date from a clean page for each venue. Venue metadata';
    const endMarker = '\n    }\n    if(!observations.length){';
    const start = src.indexOf(startMarker);
    const end = src.indexOf(endMarker, start);
    if (start < 0 || end < 0) throw new Error('Could not isolate the venue crawl block.');

    const newBlock = `      // Prepare the three fresh venue views in parallel, then parse them serially.\n`+
`      // IMPORTANT: every venue still gets its own clean TournamentSoftware page,\n`+
`      // the same date/filter verification is retained, and parseCurrentState() is\n`+
`      // deliberately NOT run concurrently because it owns shared recovery/dedupe state.\n`+
`      const venueWorkerCount=Math.max(1,Math.min(3,Number(process.env.MATCH_VENUE_WORKERS||3)));\n`+
`      const venuePrepared=new Array(venues.length);\n`+
`      let nextVenueIndex=0;\n`+
`\n`+
`      async function prepareVenueWorker(){\n`+
`        while(true){\n`+
`          const venueIndex=nextVenueIndex++;\n`+
`          if(venueIndex>=venues.length)return;\n`+
`          const venue=venues[venueIndex];\n`+
`          const venuePage=await context.newPage();\n`+
`          const prepared={venue,page:venuePage,valid:false,beforeVenueCount:0,afterVenueCount:0,active:''};\n`+
`          venuePrepared[venueIndex]=prepared;\n`+
`\n`+
`          try{\n`+
`            await gotoTournamentSoftware(venuePage,MATCHES_URL,4);\n`+
`            await dismissPopups(venuePage);\n`+
`            await sleep(650);\n`+
`            if((await currentScheduleDate(venuePage))!==expectedIso){\n`+
`              const clicked=await clickDateTab(dateLabel,venuePage);\n`+
`              if(!clicked || !(await waitForDate(expectedIso,venuePage))){\n`+
`                console.warn(\`    Could not restore \${dateLabel} before venue \${venue}.\`);\n`+
`                continue;\n`+
`              }\n`+
`            }\n`+
`\n`+
`            prepared.beforeVenueCount=await currentH2HCount(venuePage);\n`+
`            const selected=await selectVenue(venue,venuePage);\n`+
`            await sleep(700);\n`+
`            prepared.afterVenueCount=await currentH2HCount(venuePage);\n`+
`            prepared.active=await currentVenueText(venuePage);\n`+
`\n`+
`            // TournamentSoftware's rendered body keeps the text "Venue All venues"\n`+
`            // even when its custom venue control is filtered. Preserve the exact\n`+
`            // old verification rules before any venue metadata can be attached.\n`+
`            const textVerified=\n`+
`              clean(prepared.active).toLowerCase()===clean(venue).toLowerCase();\n`+
`            const countVerified=\n`+
`              selected &&\n`+
`              prepared.afterVenueCount>0 &&\n`+
`              prepared.beforeVenueCount>0 &&\n`+
`              prepared.afterVenueCount<prepared.beforeVenueCount;\n`+
`\n`+
`            if(!textVerified&&!countVerified){\n`+
`              console.warn(\`    Venue filter not verified for \${venue}; H2H \${prepared.beforeVenueCount} -> \${prepared.afterVenueCount}, active="\${prepared.active||'(unknown)'}". No venue metadata applied.\`);\n`+
`              continue;\n`+
`            }\n`+
`            if((await currentScheduleDate(venuePage))!==expectedIso){\n`+
`              console.warn(\`    Venue filter \${venue} changed away from \${dateLabel}; no venue metadata applied.\`);\n`+
`              continue;\n`+
`            }\n`+
`\n`+
`            prepared.valid=true;\n`+
`          }catch(e){\n`+
`            console.warn(\`    Venue preparation failed for \${venue}: \${String(e?.message||e).split('\\n')[0]}\`);\n`+
`          }\n`+
`        }\n`+
`      }\n`+
`\n`+
`      await Promise.all(Array.from({length:Math.min(venueWorkerCount,venues.length)},()=>prepareVenueWorker()));\n`+
`\n`+
`      // Preserve the original venue parse order and shared parser semantics.\n`+
`      for(const prepared of venuePrepared){\n`+
`        if(!prepared)continue;\n`+
`        const {venue,page:venuePage,beforeVenueCount,afterVenueCount}=prepared;\n`+
`        try{\n`+
`          if(!prepared.valid)continue;\n`+
`          const added=await parseCurrentState(venue,venuePage);\n`+
`          console.log(\`    \${venue}: \${added} new/enriched fixture(s) (verified H2H \${beforeVenueCount} -> \${afterVenueCount})\`);\n`+
`        }finally{\n`+
`          await venuePage.close().catch(()=>{});\n`+
`        }\n`+
`      }`;

    src = src.slice(0, start) + newBlock + src.slice(end);
  }

  // Add a small diagnostic so logs show that the optimized path is active.
  replaceOnce(
`    const venues=[
      'Squashworld Mirrabooka',
      'Belmont Saints Squash Centre',
      'Karrinyup Shopping Centre'
    ];`,
`    const venues=[
      'Squashworld Mirrabooka',
      'Belmont Saints Squash Centre',
      'Karrinyup Shopping Centre'
    ];
    console.log(\`TournamentSoftware venue-page preparation: up to \${Math.max(1,Math.min(3,Number(process.env.MATCH_VENUE_WORKERS||3)))} concurrent worker(s); parsing remains serial.\`);`,
    'optimization diagnostic'
  );

  if (src === original) throw new Error('No source changes were produced.');

  if (!fs.existsSync(backup)) {
    fs.writeFileSync(backup, original, 'utf8');
  }
  fs.writeFileSync(target, src, 'utf8');

  try {
    cp.execFileSync(process.execPath, ['--check', target], {stdio:'pipe'});
  } catch (e) {
    fs.writeFileSync(target, original, 'utf8');
    throw new Error(`Patched refresh-data.js failed node --check and was rolled back: ${String(e.stderr||e.message||e)}`);
  }

  console.log('Refresh optimization applied successfully.');
  console.log(`Backup: ${path.basename(backup)}`);
  console.log('Validation: node --check refresh-data.js PASSED');
  console.log('Default: MATCH_VENUE_WORKERS=3 (set 1 or 2 if TournamentSoftware becomes rate-limited).');
  console.log('No draw, score, player matching, SquashLevels, venue verification, or publish logic was removed.');
} catch (e) {
  console.error(`Optimization failed: ${e.message}`);
  process.exit(1);
}
