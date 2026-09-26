import {createReadStream} from 'node:fs';
import {createInterface} from 'node:readline';
import {fileURLToPath} from 'node:url';

const operations={get_workflow:'reads',workflow_topic_admitted:'admitted',workflow_topic_required:'blocked'};

function createSummary(){
  const topics={};
  return {add(record){
    const field=operations[record?.operation];
    if(!field||typeof record.topic!=='string'||!/^[a-z0-9:._-]{1,80}$/i.test(record.topic))return;
    const row=topics[record.topic]??={reads:0,admitted:0,blocked:0};
    row[field]++;
  },result(){return {metric:'gateway gate attempts; not model trigger recall',topics:Object.fromEntries(Object.entries(topics).sort(([a],[b])=>a.localeCompare(b)).map(([topic,row])=>[topic,{...row,gatePassRate:row.admitted+row.blocked?row.admitted/(row.admitted+row.blocked):null}]))};}};
}

export function summarizeWorkflowDisclosure(records){
  const summary=createSummary();
  for(const record of records)summary.add(record);
  return summary.result();
}

async function readAudit(path){
  const summary=createSummary();
  for await(const line of createInterface({input:createReadStream(path,{encoding:'utf8'}),crlfDelay:Infinity})){
    if(!line.trim())continue;
    try{summary.add(JSON.parse(line));}catch{throw new Error('Invalid audit JSONL line');}
  }
  return summary.result();
}

if(process.argv[1]&&fileURLToPath(import.meta.url)===process.argv[1]){
  if(process.argv.length!==3)throw new Error('Usage: node workflow-disclosure-report.mjs <audit.jsonl>');
  console.log(JSON.stringify(await readAudit(process.argv[2]),null,2));
}
