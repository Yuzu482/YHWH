export function roleValue(role, result='Observed fixture result') {
  role=({worker:'Chesed',researcher:'Malkuth',reviewer:'Geburah'})[role]??role;
  const deliverable={
    Yesod:{goal:'Inspect fixture',scope:['fixture'],constraints:[],exclusions:[],acceptance:['Observe fixture']},
    Binah:{clarificationNeeded:false,questions:[],resolution:'The fixture scope is explicit'},
    Hod:{complexity:'low',risk:'low',rationale:'Read-only fixture',dependencies:[]},
    Malkuth:{observations:['Fixture exists'],sources:['fixture'],limitations:[]},
    Chochmah:{steps:[{id:'step-1',role:'Chesed',objective:'Process fixture',readScope:[],writeScope:[],dependsOn:[],acceptance:['Report fixture']}],verification:['Check the fixture result']},
    Chesed:{summary:'Processed fixture',changes:[],checks:[{name:'fixture check',outcome:'passed',evidence:'Observed fixture'}]},
    Netzach:{verdict:'passed',checks:[{name:'fixture check',outcome:'passed',evidence:'Observed fixture'}]},
    Geburah:{findings:[],recommendations:[]},
  }[role];
  return {status:'completed',result,evidence:['Observed fixture'],changedFiles:[],assumptions:[],uncertainty:[],errors:[],nextAction:'Return to primary',deliverable,
    ...(role==='Geburah'?{reviewDecision:'approve',missingMaterials:[]}:{}),
  };
}
export const handoff = (stage,inputs=[]) => ({version:1,stage,inputs});
export const ref = (requestId,role,stage,resultSha256='0'.repeat(64)) => ({requestId,role,stage,resultSha256});
