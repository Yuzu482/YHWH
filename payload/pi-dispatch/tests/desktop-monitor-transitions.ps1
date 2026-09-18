$ErrorActionPreference='Stop'
Add-Type -AssemblyName PresentationFramework
$root=Join-Path $PSScriptRoot '..\pi-extensions\desktop-monitor'
[xml]$xaml=[IO.File]::ReadAllText((Join-Path $root 'window.xaml'))
$window=[Windows.Markup.XamlReader]::Load([Xml.XmlNodeReader]::new($xaml))
$window.Title='Pi transition verification';$window.ShowActivated=$false;$window.Topmost=$false
foreach($name in @('connection','connectionDot','activeCount','queuedCount','memoryCount','tasks','status','updated','pin','compact','taskArea','activeOnly','taskHeading','emptyState','emptyTitle','emptyHint')){Set-Variable -Name $name -Value $window.FindName($name)}
$script:latestSnapshot=$null;$script:expandedHeight=520
$tokens=$null;$errors=$null
$ast=[System.Management.Automation.Language.Parser]::ParseFile((Join-Path $root 'window.ps1'),[ref]$tokens,[ref]$errors)
foreach($name in @('Get-StateTheme','Show-Tasks','Set-Connection')){$fn=$ast.Find({param($n)$n -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq $name},$true);Invoke-Expression $fn.Extent.Text}
$compact.Add_Checked({Request-WindowTransition 'compact' $true});$compact.Add_Unchecked({Request-WindowTransition 'compact' $false})
$Mode='pet';. (Join-Path $root 'pet.ps1')
function Wait-Ui([int]$Ms){
 $frame=[Windows.Threading.DispatcherFrame]::new();$waitTimer=[Windows.Threading.DispatcherTimer]::new();$waitTimer.Interval=[TimeSpan]::FromMilliseconds($Ms)
 $waitTimer.Add_Tick({$waitTimer.Stop();$frame.Continue=$false}.GetNewClosure());$waitTimer.Start();[Windows.Threading.Dispatcher]::PushFrame($frame)
}
try{
 $window.Show();Wait-Ui 80
 $script:frames=[Collections.Generic.List[object]]::new();$script:clock=[Diagnostics.Stopwatch]::StartNew()
 $sampler=[Windows.Threading.DispatcherTimer]::new();$sampler.Interval=[TimeSpan]::FromMilliseconds(12)
 $sampler.Add_Tick({$script:frames.Add([pscustomobject]@{ms=$script:clock.ElapsedMilliseconds;width=[Math]::Round($window.Width,2);opacity=[Math]::Round($window.Opacity,3);scale=if($script:transitionSurface){[Math]::Round($script:transitionSurface.RenderTransform.ScaleX,4)}else{1}})})
 $sampler.Start();Request-WindowTransition 'mode' 'panel';Wait-Ui 650;$sampler.Stop()
 $script:frames|Select-Object -First 20|Format-Table
 $fadeObserved=@($script:frames|Where-Object {$_.opacity -gt 0 -and $_.opacity -lt 1}).Count -gt 0
 $sizeObserved=@($script:frames|Where-Object {$_.scale -gt 0.975 -and $_.scale -lt 1}).Count -gt 0
 if($script:transitionRunning -or $window.Width -ne 600 -or $window.Opacity -ne 1){throw 'Expand did not settle'}
 if([Windows.SystemParameters]::ClientAreaAnimation -and (-not $fadeObserved -or -not $sizeObserved)){throw 'No intermediate animation observed'}
 Request-WindowTransition 'mode' 'pet';Wait-Ui 20;Request-WindowTransition 'mode' 'panel';Request-WindowTransition 'mode' 'pet';Wait-Ui 700
 if($script:displayMode -ne 'pet' -or $window.Width -ne 320 -or $script:transitionRunning){throw 'Latest mode request did not win'}
 Request-WindowTransition 'mode' 'panel';Wait-Ui 400
 $compact.IsChecked=$true;Wait-Ui 15;$compact.IsChecked=$false;$compact.IsChecked=$true;Wait-Ui 700
 if($window.Height -ne 260 -or -not $compact.IsChecked -or $window.MinWidth -ne 520){throw 'Compact did not settle correctly'}
 $script:allowMotion=$false;$compact.IsChecked=$false
 if($script:transitionRunning -or $window.Height -ne 520){throw 'Reduced motion did not switch immediately'}
 $script:allowMotion=$true;Request-WindowTransition 'mode' 'pet';Wait-Ui 120
 $menuMotion.IsChecked=$false;$menuMotion.RaiseEvent([Windows.RoutedEventArgs]::new([Windows.Controls.MenuItem]::ClickEvent))
 if($script:transitionRunning -or $window.Width -ne 320 -or $window.MinWidth -ne 320 -or $window.Opacity -ne 1){throw 'Disabling motion did not snap cleanly'}
 $script:allowMotion=$true;Request-WindowTransition 'mode' 'panel';Wait-Ui 20;$window.Close();Wait-Ui 350
 if(-not $script:transitionDisposed -or $script:transitionRunning -or $window.HasAnimatedProperties){throw 'Close left transition clocks'}
 'PASS: intermediate frames, latest request, compact sizing, reduced motion, interruption and close cleanup'
}finally{if($window.IsVisible){$window.Close()}}