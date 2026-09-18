import {openMonitor} from './launcher.mjs';
export default function(pi){
  for(const [name,mode] of [['pi-monitor','panel'],['pi-pet','pet']])pi.registerCommand(name,{
    description:mode==='pet'?'Open the independent Pi mini pet monitor (Windows)':'Open the independent, read-only Pi task monitor (Windows)',
    handler:async(args,ctx)=>{
      if(args.trim()){ctx.ui.notify(`Usage: /${name}`,'warning');return;}
      try{const result=await openMonitor({mode});ctx.ui.notify(result.state==='already-open'?'Pi 监控已打开，可在窗口内切换宠物与面板。':mode==='pet'?'Pi 迷你宠物已打开。':'Pi 独立监控窗口已打开。','info');}
      catch{ctx.ui.notify('无法打开 Pi 监控窗口；请检查 Windows 环境和 Gateway 配置。','error');}
    },
  });
}
