param([Parameter(Mandatory=$true)][string]$NodePath,[Parameter(Mandatory=$true)][string]$GatewayConfig,[Parameter(Mandatory=$true)][string]$ReadyFile,[switch]$Background,[ValidateSet('panel','pet')][string]$Mode='panel')
$ErrorActionPreference='Stop'
if($Background){
  # Give the GUI a hidden console of its own so the invoking console can exit.
  $launchArgs=@('-NoLogo','-NoProfile','-NonInteractive','-STA','-File',$PSCommandPath,'-NodePath',$NodePath,'-GatewayConfig',$GatewayConfig,'-ReadyFile',$ReadyFile,'-Mode',$Mode)
  $quotedArgs=($launchArgs|ForEach-Object{'"'+$_+'"'}) -join ' '
  $null=Start-Process -FilePath (Join-Path $PSHOME 'powershell.exe') -ArgumentList $quotedArgs -WindowStyle Hidden -PassThru
  return
}
$monitorFeed=$null
$monitorMutex=$null
$ownsMutex=$false
function Write-Ready([string]$State){[IO.File]::WriteAllText($ReadyFile,(@{state=$State;pid=$PID}|ConvertTo-Json -Compress),[Text.UTF8Encoding]::new($false))}
try {
  $hash=[Security.Cryptography.SHA256]::Create()
  $identity=([BitConverter]::ToString($hash.ComputeHash([Text.Encoding]::UTF8.GetBytes([IO.Path]::GetFullPath($GatewayConfig).ToLowerInvariant())))).Replace('-','').Substring(0,24)
  $hash.Dispose()
  $monitorMutex=[Threading.Mutex]::new($false,"Local\PiKetherMonitor-$identity")
  try{$ownsMutex=$monitorMutex.WaitOne(0)}catch [Threading.AbandonedMutexException]{$ownsMutex=$true}
  if(-not $ownsMutex){Write-Ready 'already-open';return}
  Add-Type -AssemblyName PresentationFramework
  Add-Type -AssemblyName PresentationCore
  [xml]$xaml=[IO.File]::ReadAllText((Join-Path $PSScriptRoot 'window.xaml'))
  $window=[Windows.Markup.XamlReader]::Load([Xml.XmlNodeReader]::new($xaml))
  foreach($name in @('connection','connectionDot','activeCount','queuedCount','memoryCount','tasks','status','updated','pin','compact','taskArea','activeOnly','taskHeading','emptyState','emptyTitle','emptyHint')){Set-Variable -Name $name -Value $window.FindName($name)}
  $script:latestSnapshot=$null
  $script:expandedHeight=520
  function Get-StateTheme([string]$State){
    $key=switch($State){'running'{'StateRunning'};'queued'{'StateWaiting'};'waiting'{'StateWaiting'};'offline'{'StateWaiting'};'unverified'{'StateWaiting'};'failed'{'StateFailed'};'blocked'{'StateFailed'};'idle'{'StateReady'};'completed'{'StateReady'};default{'StateMuted'}}
    [pscustomobject]@{accent=$window.FindResource($key).ToString();tint=$window.FindResource($key+'Tint').ToString()}
  }
  function Show-Tasks {
    if($null -eq $script:latestSnapshot){return}
    $entries=@($script:latestSnapshot.tasks)
    if($activeOnly.IsChecked){$entries=@($entries|Where-Object {$_.state -in @('queued','running','cancelling','canceling')})}
    $labels=@{queued='排队中';running='执行中';completed='已完成';failed='失败';cancelled='已取消';canceled='已取消';cancelling='正在取消';canceling='正在取消';blocked='受阻';unverified='未验证'}
    $cards=@(foreach($entry in $entries){
      $seconds=[Math]::Max(0,[double]$entry.seconds)
      $duration=if($seconds -ge 3600){'{0}h {1}m' -f [Math]::Floor($seconds/3600),[Math]::Floor(($seconds%3600)/60)}elseif($seconds -ge 60){'{0}m {1}s' -f [Math]::Floor($seconds/60),($seconds%60)}else{"${seconds}s"}
      $label=if($labels.ContainsKey([string]$entry.state)){$labels[[string]$entry.state]}else{[string]$entry.state}
      $theme=Get-StateTheme ([string]$entry.state)
      [pscustomobject]@{role=$entry.role;label=$label;accent=$theme.accent;tint=$theme.tint;duration=$duration;route=$entry.route;requestId=$entry.requestId}
    })
    $tasks.ItemsSource=$cards
    $taskHeading.Text="最近任务 · $($cards.Count)"
    $emptyState.Visibility=if($cards.Count){'Collapsed'}else{'Visible'}
    $emptyTitle.Text=if($activeOnly.IsChecked){'当前没有进行中的任务'}else{'当前没有子 Agent 任务'}
    $emptyHint.Text='任务启动后会自动出现在这里'
  }
  function Set-Connection([string]$Text,[string]$Color){$connection.Text=$Text;$connectionDot.Fill=[Windows.Media.BrushConverter]::new().ConvertFromString($Color)}
  $pin.Add_Checked({$window.Topmost=$true});$pin.Add_Unchecked({$window.Topmost=$false})
  $activeOnly.Add_Checked({Show-Tasks});$activeOnly.Add_Unchecked({Show-Tasks})
  $compact.Add_Checked({Request-WindowTransition 'compact' $true})
  $compact.Add_Unchecked({Request-WindowTransition 'compact' $false})
  . (Join-Path $PSScriptRoot 'pet.ps1')
  $info=[Diagnostics.ProcessStartInfo]::new()
  $info.FileName=$NodePath
  $info.Arguments='"'+(Join-Path $PSScriptRoot 'feed.mjs')+'" "'+$GatewayConfig+'"'
  $info.UseShellExecute=$false;$info.CreateNoWindow=$true;$info.RedirectStandardOutput=$true;$info.RedirectStandardError=$true
  $info.StandardOutputEncoding=[Text.UTF8Encoding]::new($false);$info.StandardErrorEncoding=[Text.UTF8Encoding]::new($false)
  $monitorFeed=[Diagnostics.Process]::Start($info)
  $stderrTask=$monitorFeed.StandardError.ReadToEndAsync()
  $script:lineTask=$monitorFeed.StandardOutput.ReadLineAsync()
  $timer=[Windows.Threading.DispatcherTimer]::new();$timer.Interval=[TimeSpan]::FromMilliseconds(200)
  $timer.Add_Tick({
    try{
      if($script:lineTask.IsCompleted){
        $line=$script:lineTask.GetAwaiter().GetResult()
        if($null -eq $line){Set-Connection '监控已停止' (Get-StateTheme 'failed').accent;Set-PetStatus ([pscustomobject]@{state='offline';label='监控已停止';detail='请重新打开';accent=(Get-StateTheme 'failed').accent;count='!'});$status.Text='请关闭窗口后重新打开';$timer.Stop();return}
        if($line.Length -gt 262144){throw 'Oversized snapshot'}
        $data=$line|ConvertFrom-Json
        if($data.ok){
          $script:latestSnapshot=$data
          Set-PetStatus $data.pet
          $activeCount.Text=[string]$data.active;$queuedCount.Text=[string]$data.queued;$memoryCount.Text=[string]$data.rssMiB
          Set-Connection '已连接 · 每 2 秒更新' (Get-StateTheme 'running').accent
          $connection.ToolTip="Gateway $($data.instance)"
          $status.Text='只读监控 · 关闭窗口不影响任务'
          $updated.Text=[DateTime]::Now.ToString('HH:mm:ss')
          Show-Tasks
        }else{
          Set-Connection '连接中断 · 正在重连' (Get-StateTheme 'offline').accent
          Set-PetStatus ([pscustomobject]@{state='offline';label='连接中断';detail='自动重连中';accent=(Get-StateTheme 'offline').accent;count='?'})
          $status.Text='显示上次数据 · 等待网关恢复'
          if($null -eq $script:latestSnapshot){$emptyTitle.Text='暂时无法连接网关';$emptyHint.Text='正在自动重连，请确认 Gateway 已启动'}
        }
        $script:lineTask=$monitorFeed.StandardOutput.ReadLineAsync()
      }
    }catch{Set-Connection '状态读取失败' (Get-StateTheme 'failed').accent;Set-PetStatus ([pscustomobject]@{state='offline';label='状态读取失败';detail='请重新打开';accent=(Get-StateTheme 'failed').accent;count='!'});$status.Text='请关闭窗口后重新打开';$timer.Stop()}
  })
  $window.Add_ContentRendered({Write-Ready 'open';$timer.Start()})
  $null=$window.ShowDialog()
}catch{[IO.File]::WriteAllText($ReadyFile,(@{state='failed';error=$_.Exception.Message;line=$_.InvocationInfo.ScriptLineNumber}|ConvertTo-Json -Compress),[Text.UTF8Encoding]::new($false))}finally{
  if($timer){$timer.Stop()}
  if($monitorFeed){if(-not $monitorFeed.HasExited){$monitorFeed.Kill();$monitorFeed.WaitForExit(3000)|Out-Null};$monitorFeed.Dispose()}
  if($ownsMutex){$monitorMutex.ReleaseMutex()}
  if($monitorMutex){$monitorMutex.Dispose()}
}
